// Dùng chung cho script sự kiện. Chạy qua npm (đã có -r ts-node/register -r tsconfig-paths/register).
require('reflect-metadata');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const { RabbitConnection, loadMessagingConfig } = require('@app/messaging');

async function withConnection(work) {
  const connection = new RabbitConnection(loadMessagingConfig(process.env));

  await connection.connectOnce();
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}

/** Chạy một việc trên channel thường (get/ack/purge) của một kết nối riêng. */
async function withChannel(work) {
  const { connect } = require('amqplib');
  const model = await connect(loadMessagingConfig(process.env).url, { timeout: 10_000 });

  try {
    const channel = await model.createChannel();

    return await work(channel);
  } finally {
    await model.close().catch(() => undefined);
  }
}

function fail(error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

module.exports = { root, withConnection, withChannel, fail };
