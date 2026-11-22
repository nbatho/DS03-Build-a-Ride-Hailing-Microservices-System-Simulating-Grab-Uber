const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TRIP_STATUSES } = require('@app/contracts');
const {
  TRIP_TRANSITIONS,
  canTransition,
  sourcesOf,
} = require('../../src/trips/trip-transition');

test('every trip status has an entry and only targets known statuses', () => {
  assert.deepEqual(Object.keys(TRIP_TRANSITIONS).sort(), [...TRIP_STATUSES].sort());

  for (const targets of Object.values(TRIP_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(TRIP_STATUSES.includes(to), to);
    }
  }
});

test('source states derived for each target match the trip lifecycle', () => {
  assert.deepEqual(sourcesOf('ASSIGNING'), ['MATCHING']);
  assert.deepEqual(sourcesOf('ASSIGNED'), ['ASSIGNING']);
  assert.deepEqual(sourcesOf('MATCHING'), ['ASSIGNING']);
  assert.deepEqual(sourcesOf('NO_DRIVER'), ['MATCHING']);
  assert.deepEqual(sourcesOf('IN_PROGRESS'), ['ASSIGNED']);
  assert.deepEqual(sourcesOf('COMPLETED'), ['IN_PROGRESS']);
  assert.deepEqual(sourcesOf('CANCELLING'), ['MATCHING', 'ASSIGNING', 'ASSIGNED']);
  assert.deepEqual(sourcesOf('CANCELLED'), ['CANCELLING']);
});

test('terminal states never move again', () => {
  for (const terminal of ['COMPLETED', 'CANCELLED', 'NO_DRIVER']) {
    for (const to of TRIP_STATUSES) {
      assert.equal(canTransition(terminal, to), false, terminal + ' -> ' + to);
    }
  }
});

test('a started trip cannot be cancelled and cancelling cannot be undone', () => {
  assert.equal(canTransition('IN_PROGRESS', 'CANCELLING'), false);
  assert.equal(canTransition('CANCELLING', 'MATCHING'), false);
  assert.equal(canTransition('CANCELLING', 'ASSIGNED'), false);
  assert.equal(canTransition('ASSIGNED', 'MATCHING'), false);
});
