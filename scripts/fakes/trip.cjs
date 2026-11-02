const http = require('node:http');
const fs = require('node:fs');
const { createHash, timingSafeEqual } = require('node:crypto');

require('dotenv').config({ quiet: true });

const file = process.env.FAKE_TRIP_STATE_FILE;
const token = process.env.SVC_TOKEN_MATCHING_TRIP;
const port = Number(process.env.FAKE_TRIP_PORT || 3013);

if (!file || !token) {
  throw new Error(
    'Set FAKE_TRIP_STATE_FILE and SVC_TOKEN_MATCHING_TRIP before starting the fake Trip',
  );
}

const hash = value => createHash('sha256').update(value).digest();
const expected = hash(token);
const server = http.createServer((req, res) => {
  const send = (status, body) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const match = /^\/internal\/v1\/trips\/([0-9a-f-]{36})$/i.exec(req.url);
  const supplied = req.headers['x-service-token'];

  if (typeof supplied !== 'string' || !timingSafeEqual(hash(supplied), expected)) {
    send(401, { code: 'INTERNAL_CALLER_FORBIDDEN' });
  } else if (req.method !== 'GET' || !match) {
    send(404, { code: 'NOT_FOUND' });
  } else {
    try {
      // File JSON chứa map tripId -> response Trip theo OpenAPI. Sửa file để đổi kịch bản.
      const states = JSON.parse(fs.readFileSync(file, 'utf8'));
      const trip = states[match[1].toLowerCase()];

      send(trip ? 200 : 404, trip || { code: 'TRIP_NOT_FOUND' });
    } catch {
      send(503, { code: 'FAKE_TRIP_STATE_UNAVAILABLE' });
    }
  }
});

server.listen(port, '127.0.0.1', () =>
  console.log('Fake Trip listening on http://127.0.0.1:' + port),
);

process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
