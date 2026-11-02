const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { testEvidence } = require('../helpers/test-evidence.cjs');
const { account, call, createQuote, expectStatus, poll, queryDb } = require('../helpers/e2e-client.cjs');

const POINT = { lat: 10.8, lng: 106.72, zoneId: 'ZONE_B' };

test('a trip is created from a real quote exactly once', { timeout: 180000 }, async t => {
  const evidence = testEvidence('trip-create-from-quote', {
    purpose: 'Chuyến chỉ được tạo từ quote còn hạn của chính khách, gửi lại cùng Idempotency-Key không tạo chuyến thứ hai, và giá được chốt theo quote',
    setup: 'Stack Compose đầy đủ, quote thật từ Pricing. Tạo quote hết hạn bằng cách ghi expires_at trực tiếp vào pricing-db',
    steps: 'Gửi POST /api/v1/trips với quote hợp lệ, gửi lại cùng key, đổi body, dùng lại quote với key khác, dùng quote của khách khác, dùng quote hết hạn',
    expected: '201 và giá đúng; cùng key trả cùng chuyến, 1 trip.requested, 1 job; đổi body 409 IDEMPOTENCY_CONFLICT; dùng lại quote 409 QUOTE_ALREADY_USED; quote người khác 403 RESOURCE_FORBIDDEN; quote hết hạn 409 QUOTE_EXPIRED',
  });

  t.after(() => evidence.write());

  const passenger = await account('PASSENGER');
  const other = await account('PASSENGER');
  const book = (quoteId, key = randomUUID(), user = passenger) =>
    call('/trips', { method: 'POST', token: user.token, key, body: { quoteId } });
  const expectError = (result, status, code) => {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.code, code);
    evidence.record({ status, code });
  };

  try {
    const quote = await createQuote(passenger, POINT);
    const key = randomUUID();
    const trip = await expectStatus(book(quote.id, key), 201);
    const fare = queryDb(
      'trip-db',
      'trip_db',
      `SELECT amount || '|' || rule_version FROM trip_schema.fare_snapshots WHERE trip_id = '${trip.id}'`,
    );

    assert.equal(trip.quoteId, quote.id);
    assert.equal(trip.status, 'MATCHING');
    assert.equal(trip.amount, quote.amount);
    assert.equal(fare, quote.amount + '|' + quote.ruleVersion);

    const replay = await expectStatus(book(quote.id, key), 201);

    assert.deepEqual(replay, trip);

    const trips = queryDb(
      'trip-db',
      'trip_db',
      `SELECT count(*) FROM trip_schema.trips WHERE quote_id = '${quote.id}'`,
    );
    const requested = queryDb(
      'trip-db',
      'trip_db',
      `SELECT count(*) FROM trip_schema.outbox_events WHERE aggregate_id = '${trip.id}' AND type = 'trip.requested'`,
    );
    const jobs = await poll(
      async () =>
        queryDb('matching-db', 'matching_db', `SELECT count(*) FROM matching_schema.matching_jobs WHERE trip_id = '${trip.id}'`),
      count => count !== '0',
      30000,
      'the matching job',
    );

    assert.equal(trips, '1');
    assert.equal(requested, '1');
    assert.equal(jobs, '1');
    evidence.record({ tripId: trip.id, quoteId: quote.id, amount: trip.amount, trips, requested, jobs });

    const another = await createQuote(passenger, POINT);

    expectError(await book(another.id, key), 409, 'IDEMPOTENCY_CONFLICT');
    expectError(await book(quote.id), 409, 'QUOTE_ALREADY_USED');
    expectError(await book(another.id, randomUUID(), other), 403, 'RESOURCE_FORBIDDEN');

    const expired = await createQuote(passenger, POINT);

    queryDb(
      'pricing-db',
      'pricing_db',
      `UPDATE pricing_schema.quotes SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' WHERE id = '${expired.id}'`,
    );
    expectError(await book(expired.id), 409, 'QUOTE_EXPIRED');

    evidence.set({
      dbAfter: {
        tripsFromRefusedQuotes: queryDb(
          'trip-db',
          'trip_db',
          `SELECT count(*) FROM trip_schema.trips WHERE quote_id IN ('${another.id}', '${expired.id}')`,
        ),
      },
      summary: 'Một quote tạo đúng một chuyến; mọi yêu cầu sai đều bị từ chối và không tạo chuyến',
    });
    assert.equal(evidence.get('dbAfter').tripsFromRefusedQuotes, '0');
  } catch (error) {
    evidence.fail(error);
    throw error;
  }
});
