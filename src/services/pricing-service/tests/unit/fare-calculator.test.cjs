require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { FareCalculator } = require('../../src/pricing/fare-calculator');

const calculator = new FareCalculator();
const rule = { baseFee: '12000', perKm: '8000', perMin: '500' };

test('CAR_V1: 3000 meters and 600 seconds costs 41000 VND', () => {
  assert.equal(calculator.calculateAmount(3000, 600, rule), '41000');
});

test('rounds each fee up: 1 meter and 1 second costs 12017 VND', () => {
  assert.equal(calculator.calculateAmount(1, 1, rule), '12017');
  assert.equal(calculator.calculateAmount(1001, 61, rule), '20517');
});

test('supports the maximum estimate without rounding kilometers or minutes first', () => {
  assert.equal(calculator.calculateAmount(100000, 14400, rule), '932000');
});

test('uses BigInt so large integer prices stay exact', () => {
  assert.equal(
    calculator.calculateAmount(1, 1, { ...rule, baseFee: '9007199254740993' }),
    '9007199254741010',
  );
});

test('rejects invalid distances and durations with INVALID_ESTIMATE', () => {
  for (const distance of [0, -1, 100001, 1.5, NaN, Infinity, '3000']) {
    assert.throws(
      () => calculator.calculateAmount(distance, 600, rule),
      error => error.getStatus() === 400 && error.getResponse().code === 'INVALID_ESTIMATE',
    );
  }

  for (const duration of [0, -1, 14401, 1.5, NaN, Infinity, '600']) {
    assert.throws(
      () => calculator.calculateAmount(3000, duration, rule),
      error => error.getStatus() === 400 && error.getResponse().code === 'INVALID_ESTIMATE',
    );
  }
});
