// Xem và gửi lại tin trong hàng đợi lỗi (BA mục 7.3, 8.1).
//   npm run events:dlq -- trip.events                 xem tối đa 20 tin, không lấy ra
//   npm run events:dlq -- trip.events --limit 5
//   npm run events:dlq -- trip.events --replay        chuyển về queue gốc (cùng event_id, đặt lại số lần thử)
const { deadLetterQueueName, isEventQueue, RETRY_COUNT_HEADER } = require('@app/messaging');
const { withConnection, withChannel, fail } = require('./common.cjs');

const ERROR_HEADERS = [
  'x-error-code',
  'x-error-message',
  'x-failed-at',
  'x-original-queue',
  'x-last-error',
];

async function main() {
  const [queue, ...flags] = process.argv.slice(2);

  if (!queue || !isEventQueue(queue)) {
    throw new Error(
      'Usage: npm run events:dlq -- <matching.events|trip.events|payment.events|notification.events> ' +
        '[--limit N] [--replay]',
    );
  }

  const replay = flags.includes('--replay');
  const limitIndex = flags.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(flags[limitIndex + 1]) : 20;
  const dlq = deadLetterQueueName(queue);

  await withConnection(connection =>
    withChannel(async channel => {
      const held = [];

      try {
        while (held.length < limit) {
          const message = await channel.get(dlq, { noAck: false });

          if (!message) {
            break;
          }

          held.push(message);
          const headers = message.properties.headers ?? {};
          const body = message.content.toString('utf8');
          let summary = body.slice(0, 200);

          try {
            const event = JSON.parse(body);

            summary = event.type + ' ' + event.event_id + ' aggregate=' + event.aggregate_id;
          } catch {
            // giữ nguyên body thô
          }

          console.log('- ' + summary);
          console.log(
            '  ' +
              ERROR_HEADERS.filter(name => headers[name] !== undefined)
                .map(name => name + '=' + headers[name])
                .join(' '),
          );

          if (replay) {
            const cleaned = Object.fromEntries(
              Object.entries(headers).filter(
                ([name]) =>
                  !ERROR_HEADERS.includes(name) &&
                  name !== RETRY_COUNT_HEADER &&
                  name !== 'x-publish-id',
              ),
            );
            const { messageId, correlationId, type, appId, timestamp } = message.properties;

            await connection.publishConfirmed('', queue, message.content, {
              messageId,
              correlationId,
              type,
              appId,
              timestamp,
              headers: { ...cleaned, 'x-replayed-at': new Date().toISOString() },
            });

            channel.ack(message);
            held.pop();
            console.log('  replayed to ' + queue);
          }
        }
      } finally {
        // Chế độ xem: trả lại mọi tin chưa gửi lại để DLQ giữ nguyên.
        for (const message of held) {
          channel.nack(message, false, true);
        }
      }

      if (held.length === 0 && !replay) {
        console.log(dlq + ' is empty');
      }
    }),
  );
}

main().catch(fail);
