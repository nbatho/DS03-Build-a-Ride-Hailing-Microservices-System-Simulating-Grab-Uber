// Ghi docs/api/events.schema.json từ contract (Phụ lục C). Không cần RabbitMQ.
const fs = require('node:fs');
const path = require('node:path');
const { buildEventsJsonSchema } = require('@app/contracts');

const file = path.resolve(__dirname, '../../docs/api/events.schema.json');

fs.writeFileSync(file, JSON.stringify(buildEventsJsonSchema(), null, 2) + '\n');
console.log('Wrote ' + path.relative(process.cwd(), file));
