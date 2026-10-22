// Notification trên notification_db thật (cần: npm run c:db:up && npm run migration:notification:run). Không có DB thì skip.
// Chạy: npm run test:notification:integration
require('reflect-metadata');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../../../../../.env'), quiet: true });
const { DataSource } = require('typeorm');
const { databaseOptions } = require('../../src/database/options');
const { Notification, TripProjection, ProcessedEvent } = require('../../src/notifications/entities');
const { NotificationsService } = require('../../src/notifications/notifications.service');

const samplesDir = path.resolve(__dirname, '../../../../../docs/events/samples');
let dataSource;
let service;

/** Sự kiện mẫu với mã chuyến/khách/tài xế mới để mỗi test độc lập (app user không có quyền DELETE). */
function fresh(type, ids, changes = {}) {
  const file = fs.readdirSync(samplesDir).find(name => name.endsWith('.' + type + '.json'));
  const raw = fs
    .readFileSync(path.join(samplesDir, file), 'utf8')
    .replaceAll('a1031bdc-44d7-5c67-93ff-7f11b2987aa4', ids.trip)
    .replaceAll('c15878c4-5fc0-5082-a243-691c58a8c3f3', ids.passenger)
    .replaceAll('e7c02766-ce0d-553f-b18a-3860ac1be699', ids.driver);
  const event = JSON.parse(raw);

  return { ...event, event_id: randomUUID(), ...changes, payload: { ...event.payload, ...(changes.payload ?? {}) } };
}

const newIds = () => ({ trip: randomUUID(), passenger: randomUUID(), driver: randomUUID() });

before(async () => {
  try {
    dataSource = new DataSource({
      ...databaseOptions(process.env),
      entities: [Notification, TripProjection, ProcessedEvent],
    });
    await dataSource.initialize();
    await dataSource.query('SELECT 1 FROM notification_schema.notifications LIMIT 0');
    service = new NotificationsService(dataSource);
  } catch (error) {
    console.log('# notification_db not available, skipping: ' + error.message);
    dataSource = undefined;
  }
});

after(async () => {
  await dataSource?.destroy();
});

test('duplicate delivery creates no second notification', async t => {
  if (!dataSource) {
    return t.skip('no database');
  }

  const ids = newIds();
  const event = fresh('trip.accepted', ids, { payload: { tripVersion: 3 }, aggregate_version: 3 });

  assert.equal(await service.handleEvent(event), 2);
  assert.equal(await service.handleEvent(event), 'DUPLICATE_EVENT');
  assert.equal((await service.list(ids.passenger, {})).items.length, 1);
  assert.equal((await service.list(ids.driver, {})).items.length, 1);
});

test('driver polls the offer; it stops being actionable after the trip is cancelled', async t => {
  if (!dataSource) {
    return t.skip('no database');
  }

  const ids = newIds();
  const offer = fresh('matching.offer.created', ids, {
    payload: { offer: { ...fresh('matching.offer.created', ids).payload.offer, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
  });

  await service.handleEvent(offer);

  let [item] = (await service.list(ids.driver, {})).items;

  assert.equal(item.type, 'OFFER');
  assert.equal(item.actionable, true);
  assert.equal(item.offer.tripId, ids.trip);

  await service.handleEvent(fresh('trip.cancelled', ids, { payload: { affectedDriverIds: [], tripVersion: 2 }, aggregate_version: 2 }));

  const items = (await service.list(ids.driver, {})).items;

  item = items.find(n => n.type === 'OFFER');
  assert.equal(item.actionable, false);
  assert.ok(items.some(n => n.type === 'TRIP_STATUS' && n.tripStatus === 'CANCELLED'));
});

test('cursor pagination, unreadOnly and mark-read rules', async t => {
  if (!dataSource) {
    return t.skip('no database');
  }

  const ids = newIds();

  for (const version of [2, 3, 4]) {
    await service.handleEvent(
      fresh(version === 4 ? 'trip.started' : 'trip.accepted', ids, {
        payload: { tripVersion: version },
        aggregate_version: version,
      }),
    );
  }

  const first = await service.list(ids.passenger, { limit: 1 });

  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);

  const second = await service.list(ids.passenger, { limit: 5, cursor: first.nextCursor });

  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, undefined);
  assert.ok(!second.items.some(n => n.id === first.items[0].id));

  const target = first.items[0];
  const read = await service.markRead(ids.passenger, target.id);

  assert.equal(read.read, true);
  assert.equal((await service.markRead(ids.passenger, target.id)).read, true);
  assert.equal((await service.list(ids.passenger, { unreadOnly: true })).items.length, 2);
  await assert.rejects(service.markRead(ids.driver, target.id), error => error.getStatus() === 403);
  await assert.rejects(service.markRead(ids.passenger, randomUUID()), error => error.getStatus() === 404);
});
