# Delivery semantics

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

"Event-driven" describes the dependency boundary. This bus still calls every
subscriber synchronously, in registration order, before `publish` returns; it
catches subscriber errors and records dead letters. There is no background worker
or automatic retry.

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Validate and reserve a room | Synchronous: `BookingService.book` validates, checks the store for conflicts, prices, saves, and records an audit entry. | Synchronous | The caller needs an accepted, stored reservation or an immediate rejection. |
| 2 | Index a new booking for room search | Synchronous: `BookingService.book` calls `searchIndex.indexBooking` before `store.save`. | Event-driven after the booking is saved | Search is a derived view; its outage should delay discoverability rather than prevent reservations. |
| 3 | Queue confirmation and cancellation email | Event-driven: `EmailConfirmationHandler` subscribes to `booking.confirmed` and `booking.cancelled` in `app.ts`. | Event-driven | Mail failure should be retried without undoing an accepted booking or cancellation. |
| 4 | Generate a receipt | Event-driven: `ReceiptGenerator` subscribes to `booking.confirmed` and checks the current stored booking. | Event-driven | Rendering can finish later; the authoritative booking and price are already stored. |
| 5 | Schedule or remove a reminder | Event-driven: `ReminderScheduler` handles confirmation/cancellation; `dispatchDue` is called separately. | Event-driven | Reminder work need not determine whether the room is reserved, but cancellation must eventually remove it. |
| 6 | Refresh dashboard statistics | Event-driven: `StatsUpdater` handles confirmation/cancellation and recomputes from the store. | Event-driven | A dashboard can briefly lag; counting failures should not reject a reservation. |
| 7 | Record and settle a refund | Event-driven: `BookingService.cancel` publishes `refund.requested`; `RefundLedger` records it and calls the gateway. | Event-driven | Release the room and report the amount owed even if payment is temporarily unavailable; track and recover unfinished payment. |
| 8 | Build the daily usage report | Synchronous: `buildUsageReport(store, rooms, atMinute)` reads current data and returns a report. | Synchronous | Its caller explicitly requests the computed report now; no booking mutation depends on it. |

### Two calls in detail

**Search indexing (row 2): event-driven.** The reservation page and front-desk
kiosk need a valid hold on the requested room and time, not a successful update
to the room-finder page. Availability already comes from `BookingStore`, not the
search cluster. I would save the booking, then have a `booking.confirmed`
subscriber build the search view. With this bus, a search error would become a
dead letter while `book` still returns the confirmed booking; an operator would
need to retry the failed indexing because this bus does not retry automatically.
Search would temporarily lag. The current direct call instead makes search
availability a prerequisite for saving any new reservation. This milestone
documents the proposed wiring; it does not change it.

**Validating and reserving (row 1): synchronous.** A caller needs to know before
`book` returns whether the room exists, the request obeys the rules, and the time
is free. `validateRequest` and `conflictingBooking` enforce those rules against
the registry and authoritative store; invalid or conflicting requests throw
`BookingError`. A successful return must include a booking that has been saved,
with its computed price. Deferring that decision to a subscriber could return
success before discovering that the room is already taken. In this single-threaded
lab no competing request races with the check and save; a concurrent production
store would also need an atomic reservation constraint.

### The incident

The implicated call is **`src/service/bookingService.ts:94`, in
`BookingService.book`:**

```ts
this.searchIndex.indexBooking(booking, room, now);
```

When search is down, `SearchIndexClient.requireAvailable` throws
`SearchIndexUnavailableError('search index is unavailable')`. `book` does not
catch it, so its caller gets that exception instead of a `Booking`. Execution
never reaches `store.save` on line 95, the audit write, or the confirmation
publication. The booking number has already advanced, but no room was held.
Cancellation does not call search, and mail already published does not depend
on search, matching the incident report.

## Milestone 2: what a second delivery does

### Prediction (written before running the replay demo)

The current `RefundLedger.handle` unconditionally appends an entry and calls
`gateway.refund`. `redeliver` uses the same message id but does not deduplicate
it. After cancellation I expect one ledger entry, one gateway call, one
settlement, and 8,500 cents returned. After one redelivery those become two
entries, two calls, two settlements, and 17,000 cents; after two redeliveries,
three of each and 25,500 cents. No delivery should fail. The bus should still
contain only one `refund.requested` message, `msg-3`, with delivery count 3;
`msg-1` and `msg-2` should each have delivery count 1.

### Before the fix

Unedited output of `npm run demo:replay` on the starter:

```text

> campus-reservations@1.0.0 demo:replay
> tsx src/demos/replayDemo.ts

booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Prediction against the run.** All predicted counts and amounts match: the
same refund message was delivered three times, creating three ledger entries
and three settlements totaling $255.00. Redelivery added no new bus message
and caused no dead letter.

### The fix

```diff
diff --git a/src/handlers/refundLedger.ts b/src/handlers/refundLedger.ts
index 600ffca..888724a 100644
--- a/src/handlers/refundLedger.ts
+++ b/src/handlers/refundLedger.ts
@@ -26,0 +27,2 @@ export class RefundLedger implements Subscriber<RefundRequested> {
+  private readonly recordedMessageIds = new Set<string>();
+  private readonly settledMessageIds = new Set<string>();
@@ -33,0 +36,4 @@ export class RefundLedger implements Subscriber<RefundRequested> {
+    if (this.settledMessageIds.has(message.id)) {
+      return;
+    }
+
@@ -35,8 +41,13 @@ export class RefundLedger implements Subscriber<RefundRequested> {
-    this.entries.push({
-      entryId: `led-${this.entries.length + 1}`,
-      bookingId: event.bookingId,
-      organizer: event.organizer,
-      amountCents: event.amountCents,
-      reason: event.reason,
-      recordedAtMinute: message.publishedAtMinute,
-    });
+    if (!this.recordedMessageIds.has(message.id)) {
+      this.entries.push({
+        entryId: `led-${this.entries.length + 1}`,
+        bookingId: event.bookingId,
+        organizer: event.organizer,
+        amountCents: event.amountCents,
+        reason: event.reason,
+        recordedAtMinute: message.publishedAtMinute,
+      });
+      this.recordedMessageIds.add(message.id);
+    }
+
+    // A failed payment leaves the ledger recorded, but the refund still retryable.
@@ -43,0 +55 @@ export class RefundLedger implements Subscriber<RefundRequested> {
+    this.settledMessageIds.add(message.id);
```

**Idempotency key and partial progress.** The key is the original bus
`message.id`, which stays the same on redelivery. `recordedMessageIds` prevents
a second ledger entry, while `settledMessageIds` skips the whole handler only
after the provider returns successfully. A failed provider call therefore
leaves payment retryable without recording the refund twice. Marking a single
"seen" set before payment would lose an unpaid refund; marking it only after
payment would duplicate the ledger on retry.

**Limits.** The sets live only in this handler instance. They do not survive a
restart, deduplicate a new message id for the same business refund, protect other
subscribers, or make local recording and an external payment atomic. If a real
provider settled and then its response was lost (or the process stopped before
marking settlement), retry could pay again. Production recovery would require
durable progress plus a stable provider-side idempotency key or settlement
reconciliation. This lab's gateway explicitly throws before settlement, and
deliveries never race.

### After the fix

Unedited output of `npm run demo:replay` on the fixed handler:

```text

> campus-reservations@1.0.0 demo:replay
> tsx src/demos/replayDemo.ts

booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**What stays the same.** After cancellation, after one redelivery, and after
two redeliveries: one ledger entry (`led-1`, 8,500 cents), ledger total 8,500
cents, one provider call, one settlement (`stl-1`, 8,500 cents), $85.00 actually
returned, and zero dead letters. Only the refund's delivery count increases
from 1 to 2 to 3; the published refund message keeps id `msg-3`.

## Milestone 3: a delivery that stops halfway

### The failure and recovery run

Unedited output of `npm run demo:failure`, including the state before and
after the explicit recovery at the end of `main()`:

```text

> campus-reservations@1.0.0 demo:failure
> tsx src/demos/failureDemo.ts

armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1

the refund message is in the log and in the dead-letter list. Redelivering it now that the provider can answer.

=== after recovery by redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=2
```

### What the failed delivery left undone

Cancellation completed and returned a cancelled booking with an 8,500-cent
refund owed. The ledger contains one $85.00 entry, but the provider's first
call threw **before settling anything**: zero settlements and $0.00 returned.
Thus payment was still undone, even though `totalRefundedCents()` reports
8,500 cents in the local ledger. A ledger entry alone is not proof that the
organizer received money. The bus caught the exception, kept the refund
message, and recorded a dead letter for `RefundLedger`, attempt 1.

### Recovery chosen: redeliver

At the end of `src/demos/failureDemo.ts`, I check that
`cancellation.refundMessageId` exists, call `app.bus.redeliver(messageId)`,
then call `printRefundState` and `printMessageLog` again. The injected failure
only affects gateway call 1, so call 2 succeeds. The milestone 2 fix preserves
the existing ledger entry and retries just the payment. After recovery there
is still one ledger entry, two gateway calls (one failed and one successful),
one $85.00 settlement, and $85.00 actually returned. The refund log line is:

```text
  msg-3 refund.requested deliveries=2
```

The dead-letter count remains **1** because that list is a historical log,
not a pending-work queue; successful redelivery never removes its old failure.
The settled payment and delivery count establish recovery, not an empty
failure list. Subsequent redelivery skips both completed effects. In this
single-threaded, before-settlement failure model, at-least-once delivery plus
the idempotent handler gives effectively-once processing.

### Cost of the other option: manual triage

Manual triage would cost an operator time to investigate the dead letter and reconcile provider settlements, delay the organizer's $85.00 until that work is done, and require confirming what already settled before using the replay-safe handler to finish the unpaid refund without a duplicate payout.

## Verification

- Repository: [saahasp/f26-lab11](https://github.com/saahasp/f26-lab11), verified as a fork of `CMU-17-214/f26-lab11`; the existing CI workflow has been enabled.
- Before changes: `npm install`, `npm run typecheck`, and all 33 starter tests passed.
- After changes: `npm run typecheck` and all 36 tests passed across six files.
- Added regressions cover successful replay and two failed payments followed by recovery and another replay.
- Enabled the optional fast-check property: 100 arbitrary replay schedules across three independent refunds.
- Both required demos completed successfully; their output above was captured directly, with no edits.
- Milestone 1 changes only this document; the search call remains at `src/service/bookingService.ts:94` for the TA demonstration.
