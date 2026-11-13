import { buildReservationApp } from '../app';
import { sampleRequest } from '../support/sampleData';
import { printMessageLog, printRefundState } from './state';

/**
 * A refund that meets a payment provider which is not answering.
 *
 * `failOnCall(1)` arms the first call to `refund`, so the delivery that
 * follows the cancellation runs into a provider that throws. The run prints
 * what the delivery left behind, then redelivers the same refund message to
 * demonstrate recovery without repeating the ledger entry.
 *
 * Run it with `npm run demo:failure`.
 */
function main(): void {
  const app = buildReservationApp();
  app.gateway.failOnCall(1);
  console.log('armed: call 1 to the payment provider will throw');

  const booking = app.service.book(sampleRequest({ start: 11 * 60, end: 13 * 60 }));
  console.log(`booked ${booking.id} for ${booking.priceCents} cents`);

  const cancellation = app.service.cancel(booking.id);
  console.log(
    `cancelled ${booking.id}, refund ${cancellation.refundCents} cents, ` +
      `refund message ${cancellation.refundMessageId}`,
  );
  console.log(`the cancel call itself returned: booking is ${cancellation.booking.status}`);

  printRefundState(app, 'after the failed delivery');
  printMessageLog(app);

  console.log(
    '\nthe refund message is in the log and in the dead-letter list. ' +
      'Redelivering it now that the provider can answer.',
  );

  const messageId = cancellation.refundMessageId;
  if (messageId === undefined) {
    throw new Error('this cancellation owed no refund, so there is no message to replay');
  }
  app.bus.redeliver(messageId);

  printRefundState(app, 'after recovery by redelivery');
  printMessageLog(app);
}

main();
