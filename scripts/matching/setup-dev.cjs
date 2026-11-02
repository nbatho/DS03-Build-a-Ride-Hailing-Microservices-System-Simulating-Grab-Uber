const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const dotenv = require('dotenv');

const file = '.env';
const content = fs.readFileSync(file, 'utf8');
const env = dotenv.parse(content);
const user = env.RABBITMQ_USER || 'ride_dev';
const password = env.RABBITMQ_PASSWORD || randomBytes(24).toString('hex');
const values = {
  RABBITMQ_USER: user,
  RABBITMQ_PASSWORD: password,
  RABBITMQ_URL:
    'amqp://' +
    encodeURIComponent(user) +
    ':' +
    encodeURIComponent(password) +
    '@127.0.0.1:5672/%2F?heartbeat=5',
};
const additions = Object.entries(values).filter(([key]) => !env[key]);

if (additions.length) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';

  fs.appendFileSync(
    file,
    (content.endsWith('\n') ? '' : eol) +
      eol +
      '# Matching RabbitMQ local' +
      eol +
      additions.map(([key, value]) => key + '=' + value).join(eol) +
      eol,
  );

  console.log('Added missing RabbitMQ local variables. No secrets printed.');
} else {
  console.log('RabbitMQ configuration already exists.');
}
