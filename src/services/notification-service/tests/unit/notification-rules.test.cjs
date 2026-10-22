const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  applyEvent,
  emptyProjection,
  isActionable,
  toNotificationDto,
} = require('../../src/notifications/notification-rules');
const { encodeCursor, decodeCursor } = require('../../src/notifications/cursor');

const samplesDir = path.resolve(__dirname, '../../../../../docs/events/samples');
const sample = (type, changes = {}) => {
  const file = fs.readdirSync(samplesDir).find(name => name.endsWith('.' + type + '.json'));
  const event = JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8'));

  return {
    ...event,
    event_id: randomUUID(),
    ...changes,
    payload: { ...event.payload, ...(changes.payload ?? {}) },
  };
};
const TRIP = 'a1031bdc-44d7-5c67-93ff-7f11b2987aa4';
const PASSENGER = 'c15878c4-5fc0-5082-a243-691c58a8c3f3';
const DRIVER = 'e7c02766-ce0d-553f-b18a-3860ac1be699';
const OTHER_DRIVER = '11111111-1111-4111-8111-111111111111';
const BEFORE_EXPIRY = new Date('2026-10-11T02:00:05Z');

function run(events, projection = emptyProjection(TRIP)) {
  const notifications = [];

  for (const event of events) {
    const result = applyEvent(projection, event);

    projection = result.projection;
    notifications.push(...result.notifications);
  }

  return { projection, notifications };
}

test('offer created notifies only the invited driver with offer, pickup, dropoff, amount, currency', () => {
  const event = sample('matching.offer.created');
  const { projection, notifications } = run([event]);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].recipientId, DRIVER);
  assert.equal(notifications[0].type, 'OFFER');
  assert.deepEqual(Object.keys(notifications[0].payload).sort(), ['amount', 'currency', 'dropoff', 'offer', 'pickup']);
  assert.deepEqual(projection.knownDriverIds, [DRIVER]);
  assert.equal(isActionable('OFFER', notifications[0].payload, projection, BEFORE_EXPIRY), true);
  assert.equal(isActionable('OFFER', notifications[0].payload, projection, new Date('2026-10-11T02:00:16Z')), false);
});

test('trip status events notify passenger and assigned driver; offer stops being actionable once assigned', () => {
  const offer = sample('matching.offer.created');
  const accepted = sample('trip.accepted', { payload: { tripVersion: 3 } , aggregate_version: 3 });
  const { projection, notifications } = run([offer, accepted]);
  const status = notifications.filter(n => n.type === 'TRIP_STATUS');

  assert.deepEqual(status.map(n => n.recipientId).sort(), [PASSENGER, DRIVER].sort());
  assert.ok(status.every(n => n.payload.tripStatus === 'ASSIGNED'));
  assert.equal(isActionable('OFFER', notifications[0].payload, projection, BEFORE_EXPIRY), false);
});

test('older trip version is not shown (out-of-order)', () => {
  const started = sample('trip.started', { payload: { tripVersion: 4 }, aggregate_version: 4 });
  const accepted = sample('trip.accepted', { payload: { tripVersion: 3 }, aggregate_version: 3 });
  const { projection, notifications } = run([started, accepted]);

  assert.equal(projection.tripStatus, 'IN_PROGRESS');
  assert.ok(notifications.every(n => n.payload.tripStatus === 'IN_PROGRESS'));
});

test('cancellation goes to passenger, affected drivers and drivers known from offers — not everyone', () => {
  const offer = sample('matching.offer.created');
  const cancelled = sample('trip.cancelled', {
    payload: { affectedDriverIds: [OTHER_DRIVER], tripVersion: 2 },
    aggregate_version: 2,
  });
  const { projection, notifications } = run([offer, cancelled]);
  const recipients = notifications.filter(n => n.type === 'TRIP_STATUS').map(n => n.recipientId).sort();

  assert.deepEqual(recipients, [PASSENGER, DRIVER, OTHER_DRIVER].sort());
  assert.equal(projection.terminalState, 'CANCELLED');
  assert.equal(projection.terminalEventId, cancelled.event_id);
});

test('offer arriving after cancellation is not actionable and the driver gets one cancel notice', () => {
  const cancelled = sample('trip.cancelled', { payload: { affectedDriverIds: [], tripVersion: 2 }, aggregate_version: 2 });
  const offer = sample('matching.offer.created');
  const { projection, notifications } = run([cancelled, offer]);
  const toDriver = notifications.filter(n => n.recipientId === DRIVER);

  assert.deepEqual(toDriver.map(n => n.type).sort(), ['OFFER', 'TRIP_STATUS']);
  // Thông báo hủy dùng sự kiện hủy làm nguồn để không trùng với các lời mời đến muộn khác.
  assert.equal(toDriver.find(n => n.type === 'TRIP_STATUS').sourceEventId, cancelled.event_id);
  assert.equal(isActionable('OFFER', toDriver.find(n => n.type === 'OFFER').payload, projection, BEFORE_EXPIRY), false);
});

test('payment: success is final, an older failure neither overwrites nor is shown', () => {
  const failed = sample('payment.failed', { payload: { paymentVersion: 2 }, aggregate_version: 2 });
  const succeeded = sample('payment.succeeded', { payload: { attemptNo: 2, paymentVersion: 3 }, aggregate_version: 3 });
  const staleFailed = sample('payment.failed', { payload: { paymentVersion: 2 }, aggregate_version: 2 });
  const { projection, notifications } = run([failed, succeeded, staleFailed]);

  assert.equal(projection.paymentStatus, 'SUCCEEDED');
  assert.deepEqual(notifications.map(n => n.payload.paymentStatus), ['FAILED', 'SUCCEEDED']);
  assert.ok(notifications.every(n => n.recipientId === PASSENGER && n.type === 'PAYMENT_STATUS'));
});

test('no driver goes to the passenger only', () => {
  const { notifications, projection } = run([sample('trip.no_driver')]);

  assert.deepEqual(notifications.map(n => [n.recipientId, n.payload.tripStatus]), [[PASSENGER, 'NO_DRIVER']]);
  assert.equal(projection.terminalState, 'NO_DRIVER');
});

test('DTO only carries the fields of its variant', () => {
  const base = {
    id: randomUUID(),
    recipientId: PASSENGER,
    sourceEventId: randomUUID(),
    tripId: TRIP,
    title: 'x',
    readAt: null,
    createdAt: new Date('2026-10-11T02:00:00Z'),
  };
  const trip = toNotificationDto({ ...base, type: 'TRIP_STATUS', payload: { tripStatus: 'COMPLETED' } }, null, BEFORE_EXPIRY);
  const payment = toNotificationDto(
    { ...base, type: 'PAYMENT_STATUS', payload: { paymentStatus: 'FAILED', attemptNo: 1 }, readAt: new Date() },
    null,
    BEFORE_EXPIRY,
  );

  assert.equal(trip.tripStatus, 'COMPLETED');
  assert.equal(trip.actionable, false);
  assert.equal('offer' in trip, false);
  assert.equal(payment.paymentStatus, 'FAILED');
  assert.equal(payment.read, true);
  assert.equal('attemptNo' in payment, false);
});

test('cursor round-trips and rejects garbage', () => {
  const position = { createdAt: '2026-10-11T02:00:00.123456+00:00', id: randomUUID() };

  assert.deepEqual(decodeCursor(encodeCursor(position)), position);
  assert.throws(() => decodeCursor('not-a-cursor'), error => error.getResponse().code === 'INVALID_CURSOR');
});
