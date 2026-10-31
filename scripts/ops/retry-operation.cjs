const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const [operationId, reason, commandId = randomUUID()] = process.argv.slice(2);

if (!operationId || !reason) {
  console.error('Usage: npm run ops:retry -- <operationId> "<reason>" [commandId]');
  process.exit(2);
}

// Compose không mở cổng 3003 nên phải gọi từ trong container; token nằm trong env của container, không in ra.
const script = `
const [operationId, commandId, reason] = process.argv.slice(1);
fetch('http://127.0.0.1:3003/internal/v1/operations/' + operationId + '/retry', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Service-Token': process.env.SVC_TOKEN_OPS_TRIP },
  body: JSON.stringify({ commandId, reason }),
  signal: AbortSignal.timeout(10000),
}).then(async response => {
  console.log(response.status + ' ' + (await response.text()));
  process.exit(response.ok ? 0 : 1);
}).catch(error => {
  console.error(error.message);
  process.exit(1);
});
`;

const result = spawnSync(
  'docker',
  [
    'compose',
    '--env-file',
    '.env',
    '-f',
    'deploy/docker-compose.yml',
    'exec',
    '-T',
    'trip',
    'node',
    '-e',
    script,
    operationId,
    commandId,
    reason,
  ],
  { cwd: root, encoding: 'utf8', timeout: 30000 },
);

console.log('commandId: ' + commandId);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
