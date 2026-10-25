require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { driverStatus, isLocationFresh } = require('../../src/drivers/driver-status');
const { toSequence } = require('../../src/locations/entities/latest-location.entity');

test('available only when online, with a vehicle and fresh GPS', () => {
  assert.equal(driverStatus(true, true, true), 'AVAILABLE');
  assert.equal(driverStatus(false, true, true), 'OFFLINE');
  assert.equal(driverStatus(true, false, true), 'OFFLINE');
  assert.equal(driverStatus(true, true, false), 'OFFLINE');
});

test('active reservation takes precedence over online and GPS freshness', () => {
  assert.equal(driverStatus(true, true, true, 'HELD'), 'RESERVED');
  assert.equal(driverStatus(false, true, false, 'CONFIRMED'), 'BUSY');
  assert.equal(driverStatus(true, true, true, 'RELEASED'), 'AVAILABLE');
  assert.equal(driverStatus(true, true, true, 'EXPIRED'), 'AVAILABLE');
});

test('GPS freshness includes 60 seconds, rejects missing and future timestamps', () => {
  const now = new Date('2026-10-25T00:01:00Z');

  assert.equal(isLocationFresh(new Date('2026-10-25T00:00:00Z'), now), true);
  assert.equal(isLocationFresh(new Date('2026-10-24T23:59:59.999Z'), now), false);
  assert.equal(isLocationFresh(new Date(now.getTime() + 1), now), false);
  assert.equal(isLocationFresh(undefined, now), false);
});

test('PostgreSQL BIGINT location sequence must be a safe positive JS integer', () => {
  assert.equal(toSequence('123'), 123);
  assert.equal(toSequence(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.throws(() => toSequence('9007199254740993'));
  assert.throws(() => toSequence('0'));
});
