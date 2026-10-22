// Dựng exchange ride.events, 4 queue, binding, queue retry và DLQ; chạy lại nhiều lần không lỗi.
// npm run events:topology            -> khai báo và in số tin trong từng queue
const { describeTopology } = require('@app/messaging');
const { withConnection, withChannel, fail } = require('./common.cjs');

async function main() {
  // Kết nối thành công nghĩa là assertTopology đã chạy xong.
  await withConnection(async () => undefined);
  const topology = describeTopology();

  await withChannel(async channel => {
    for (const queue of topology.queues) {
      const names = [
        queue.name,
        ...queue.retryQueues.map(retry => retry.name),
        queue.deadLetterQueue,
      ];

      for (const name of names) {
        const { messageCount, consumerCount } = await channel.checkQueue(name);

        console.log(name.padEnd(36) + ' messages=' + messageCount + ' consumers=' + consumerCount);
      }

      console.log('  bindings: ' + queue.bindings.join(', '));
    }
  });
}

main().catch(fail);
