const fs = require('node:fs');
const amqp = require('amqplib');
const { assertRideEvent } = require('@app/contracts');

require('dotenv').config({ quiet: true });

async function main() {
  const file = process.argv[2];

  if (!file || !process.env.RABBITMQ_URL) {
    throw new Error('Usage: npm run matching:emit -- path/to/event.json (requires RABBITMQ_URL)');
  }

  const event = assertRideEvent(JSON.parse(fs.readFileSync(file, 'utf8')));

  if (event.type !== 'trip.requested' && event.type !== 'trip.cancelled') {
    throw Object.assign(new Error('Only trip.requested and trip.cancelled go to Matching'), {
      code: 'INVALID_EVENT',
    });
  }
  const connection = await amqp.connect(process.env.RABBITMQ_URL, { timeout: 3000 });

  connection.on('error', () => {});

  try {
    const channel = await connection.createConfirmChannel();
    let returned = false;

    channel.on('error', () => {});
    channel.on('return', () => {
      returned = true;
    });

    await channel.assertExchange('ride.events', 'topic', { durable: true });
    await new Promise((resolve, reject) => {
      channel.publish(
        'ride.events',
        event.type,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          messageId: event.event_id,
          correlationId: event.correlation_id,
        },
        error =>
          error || returned
            ? reject(new Error('Event was rejected or no Matching queue is bound'))
            : resolve(),
      );
    });

    await channel.close();
    console.log(
      'Published ' +
        event.type +
        ': eventId=' +
        event.event_id +
        ', tripId=' +
        event.payload.tripId,
    );
  } finally {
    await connection.close().catch(() => {});
  }
}

main().catch(error => {
  // Không in URL broker chứa mật khẩu hoặc stack của lỗi network.
  console.error(
    error.code ||
      (error.name === 'EventValidationError'
        ? 'INVALID_EVENT'
        : 'Failed to publish event; check the JSON file and RabbitMQ configuration'),
  );

  process.exitCode = 1;
});
