// Gửi sự kiện mẫu của Phụ lục C (docs/events/samples) lên ride.events, dùng làm bản giả bên gửi (BA mục 11.3).
//   npm run events:send -- all                 gửi cả 11 mẫu
//   npm run events:send -- evt-01 trip.cancelled
//   npm run events:send -- evt-02 --new-id     event_id mới (không bị bên nhận bỏ trùng)
//   npm run events:send -- path/to/event.json  gửi file tự viết (vẫn phải đúng contract)
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventPublisher } = require('@app/messaging');
const { root, withConnection, fail } = require('./common.cjs');

const samplesDir = path.join(root, 'docs/events/samples');

function resolve(selector) {
  if (selector.endsWith('.json') && fs.existsSync(selector)) {
    return [selector];
  }

  const files = fs.readdirSync(samplesDir).sort();
  const matches =
    selector === 'all'
      ? files
      : files.filter(
          file =>
            file.startsWith(selector.toLowerCase() + '.') ||
            file.includes('.' + selector + '.json'),
        );

  if (matches.length === 0) {
    throw new Error('No sample matches "' + selector + '". Available: ' + files.join(', '));
  }

  return matches.map(file => path.join(samplesDir, file));
}

async function main() {
  const args = process.argv.slice(2);
  const newId = args.includes('--new-id');
  const selectors = args.filter(arg => !arg.startsWith('--'));

  if (selectors.length === 0) {
    throw new Error('Usage: npm run events:send -- <all|evt-NN|type|file.json>... [--new-id]');
  }

  const files = [...new Set(selectors.flatMap(resolve))];

  await withConnection(async connection => {
    const publisher = new EventPublisher(connection);

    for (const file of files) {
      const event = JSON.parse(fs.readFileSync(file, 'utf8'));

      if (newId) {
        event.event_id = randomUUID();
        event.occurred_at = new Date().toISOString();
      }

      await publisher.publish(event);
      console.log(
        'Published ' + event.type + ' ' + event.event_id + ' (' + path.basename(file) + ')',
      );
    }
  });
}

main().catch(fail);
