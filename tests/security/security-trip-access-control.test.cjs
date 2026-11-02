const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JwtService } = require('@nestjs/jwt');
const { testEvidence } = require('../helpers/test-evidence.cjs');
const {
  GATEWAY,
  ROOT,
  acceptOffer,
  account,
  bringOnline,
  call,
  callTripDirectly,
  createQuote,
  expectStatus,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };

function tokenSigner() {
  const privateKey = fs.readFileSync(path.join(ROOT, 'deploy/secrets/identity-private.pem'));
  const jwt = new JwtService({});

  return (userId, role, options = {}) =>
    jwt.sign(
      { role },
      {
        privateKey,
        algorithm: 'RS256',
        subject: userId,
        issuer: 'ride-hailing',
        audience: 'ride-api',
        expiresIn: 600,
        ...options,
      },
    );
}

test('Trip refuses callers without the right identity, role or ownership', { timeout: 240000 }, async t => {
  const evidence = testEvidence('security-trip-access-control', {
    purpose: 'Chỉ đúng người, đúng vai trò và đúng dịch vụ mới đọc hoặc đổi được chuyến; lần gọi bị từ chối không làm đổi trạng thái',
    setup: 'Chuyến đã gán tài xế, stack Compose đầy đủ. Token thử ký bằng khóa dev trong deploy/secrets. Gọi thẳng Trip từ trong container vì Compose chỉ mở cổng Gateway',
    steps: 'Gọi các route của Trip qua Gateway và gọi thẳng service với JWT hỏng, sai vai trò, người khác, header giả, token dịch vụ sai, rồi đọc lại trạng thái chuyến',
    expected: '401 với JWT hoặc token dịch vụ hỏng; 403 với sai vai trò, người khác hoặc sai bên gọi; 404 với route nội bộ qua Gateway; trạng thái và version của chuyến không đổi',
  });

  t.after(() => evidence.write());

  const owner = await account('PASSENGER');
  const stranger = await account('PASSENGER');
  const driver = await account('DRIVER');
  const otherDriver = await account('DRIVER');
  const sign = tokenSigner();
  const refused = (label, result, status, code) => {
    assert.equal(result.status, status, label + ': ' + JSON.stringify(result.body));

    if (code) {
      assert.equal(result.body.code, code, label);
    }

    evidence.record({ check: label, status: result.status, code: result.body?.code });
  };
  const post = (route, token, body = {}, headers = {}) =>
    call(route, { method: 'POST', token, key: randomUUID(), body, headers });

  try {
    await bringOnline(driver, POINT);

    const quote = await createQuote(owner, POINT);
    const trip = await expectStatus(
      call('/trips', { method: 'POST', token: owner.token, key: randomUUID(), body: { quoteId: quote.id } }),
      201,
    );
    const tripPath = '/trips/' + trip.id;
    const offer = await poll(() => findOffer(driver, trip.id), Boolean, 30000, 'offer');

    refused(
      'another driver accepts the offer',
      await post(tripPath + '/accept', otherDriver.token, { offerId: offer.offer.id }),
      403,
      'RESOURCE_FORBIDDEN',
    );

    const { accepted, final } = await acceptOffer(driver, trip.id, offer.offer.id);

    assert.equal(final.status, 'SUCCEEDED', JSON.stringify(final));

    const state = () =>
      queryDb('trip-db', 'trip_db', `SELECT status || '|' || version FROM trip_schema.trips WHERE id = '${trip.id}'`);
    const before = state();

    evidence.set({ dbBefore: { trip: before } });

    await t.test('broken JWTs are refused at the Gateway and at the service', async () => {
      const valid = sign(owner.id, 'PASSENGER');
      const broken = [
        ['missing JWT', undefined],
        ['expired JWT', sign(owner.id, 'PASSENGER', { expiresIn: -10 })],
        ['wrong audience', sign(owner.id, 'PASSENGER', { audience: 'other-api' })],
        ['wrong issuer', sign(owner.id, 'PASSENGER', { issuer: 'someone-else' })],
        ['tampered signature', valid.slice(0, -4) + (valid.endsWith('AAAA') ? 'BBBB' : 'AAAA')],
      ];

      assert.equal((await call(tripPath, { token: valid })).status, 200);

      for (const [label, token] of broken) {
        refused('gateway: ' + label, await call(tripPath, { token }), 401);
        refused(
          'service: ' + label,
          callTripDirectly('/api/v1' + tripPath, { headers: token ? { Authorization: 'Bearer ' + token } : {} }),
          401,
          'INVALID_TOKEN',
        );
      }
    });

    await t.test('a valid token with the wrong role is refused', async () => {
      refused(
        'driver creates a trip',
        await post('/trips', driver.token, { quoteId: quote.id }),
        403,
        'ROLE_FORBIDDEN',
      );
      refused('passenger starts a trip', await post(tripPath + '/start', owner.token), 403, 'ROLE_FORBIDDEN');
      refused('passenger completes a trip', await post(tripPath + '/complete', owner.token), 403, 'ROLE_FORBIDDEN');
      refused(
        'passenger accepts an offer',
        await post(tripPath + '/accept', owner.token, { offerId: offer.offer.id }),
        403,
        'ROLE_FORBIDDEN',
      );
      refused(
        'driver cancels a trip',
        await post(tripPath + '/cancel', driver.token, { reason: 'CHANGE_PLAN' }),
        403,
        'ROLE_FORBIDDEN',
      );
    });

    await t.test('another passenger and another driver cannot touch the trip', async () => {
      refused('stranger reads the trip', await call(tripPath, { token: stranger.token }), 403, 'RESOURCE_FORBIDDEN');
      refused(
        'stranger cancels the trip',
        await post(tripPath + '/cancel', stranger.token, { reason: 'CHANGE_PLAN' }),
        403,
        'RESOURCE_FORBIDDEN',
      );
      refused(
        'stranger reads the operation',
        await call('/operations/' + accepted.id, { token: stranger.token }),
        403,
        'RESOURCE_FORBIDDEN',
      );
      refused('other driver reads the trip', await call(tripPath, { token: otherDriver.token }), 403, 'RESOURCE_FORBIDDEN');
      refused('other driver starts the trip', await post(tripPath + '/start', otherDriver.token), 403, 'RESOURCE_FORBIDDEN');
      refused('other driver completes the trip', await post(tripPath + '/complete', otherDriver.token), 403, 'RESOURCE_FORBIDDEN');

      const history = await expectStatus(call('/trips', { token: stranger.token }), 200);

      assert.equal(history.items.length, 0);
    });

    await t.test('forged actor headers do not change the caller', async () => {
      const forged = { 'X-User-Id': owner.id, 'X-Role': 'PASSENGER' };

      refused('forged headers with a stranger token', await call(tripPath, { token: stranger.token, headers: forged }), 403, 'RESOURCE_FORBIDDEN');
      refused('forged headers without a token', await call(tripPath, { headers: forged }), 401);
      refused(
        'forged headers at the service',
        callTripDirectly('/api/v1' + tripPath, {
          headers: { ...forged, Authorization: 'Bearer ' + stranger.token },
        }),
        403,
        'RESOURCE_FORBIDDEN',
      );
    });

    await t.test('internal routes stay behind the service token', async () => {
      const internalTrip = '/internal/v1/trips/' + trip.id;
      const retry = '/internal/v1/operations/' + accepted.id + '/retry';
      const retryBody = { commandId: randomUUID(), reason: 'Access check' };
      const fake = { 'X-Service-Token': 'f'.repeat(48) };
      const viaGateway = await fetch(GATEWAY + internalTrip, {
        headers: { Authorization: 'Bearer ' + owner.token },
        signal: AbortSignal.timeout(15000),
      });

      refused('internal trip through the Gateway', { status: viaGateway.status, body: await viaGateway.json() }, 404);

      const retryViaGateway = await fetch(GATEWAY + retry, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryBody),
        signal: AbortSignal.timeout(15000),
      });

      refused('operation retry through the Gateway', { status: retryViaGateway.status, body: await retryViaGateway.json() }, 404);

      refused('internal trip without a token', callTripDirectly(internalTrip), 401, 'INTERNAL_CALLER_FORBIDDEN');
      refused('internal trip with a fake token', callTripDirectly(internalTrip, { headers: fake }), 401, 'INTERNAL_CALLER_FORBIDDEN');
      refused('internal trip with a user JWT', callTripDirectly(internalTrip, { headers: { Authorization: 'Bearer ' + owner.token } }), 401, 'INTERNAL_CALLER_FORBIDDEN');
      refused('internal trip from ops', callTripDirectly(internalTrip, { tokenEnv: 'SVC_TOKEN_OPS_TRIP' }), 403, 'INTERNAL_CALLER_FORBIDDEN');
      assert.equal(callTripDirectly(internalTrip, { tokenEnv: 'SVC_TOKEN_MATCHING_TRIP' }).status, 200);

      refused('retry without a token', callTripDirectly(retry, { method: 'POST', body: retryBody }), 401, 'INTERNAL_CALLER_FORBIDDEN');
      refused('retry with a fake token', callTripDirectly(retry, { method: 'POST', body: retryBody, headers: fake }), 401, 'INTERNAL_CALLER_FORBIDDEN');
      refused('retry from Matching', callTripDirectly(retry, { method: 'POST', body: retryBody, tokenEnv: 'SVC_TOKEN_MATCHING_TRIP' }), 403, 'INTERNAL_CALLER_FORBIDDEN');
      refused('retry from ops on a finished operation', callTripDirectly(retry, { method: 'POST', body: retryBody, tokenEnv: 'SVC_TOKEN_OPS_TRIP' }), 409, 'OPERATION_NOT_RETRYABLE');
    });

    const after = state();

    assert.equal(after, before);
    evidence.set({
      dbAfter: { trip: after },
      summary: 'Mọi lần gọi sai đều bị từ chối, trạng thái và version của chuyến giữ nguyên',
    });

    await expectStatus(post(tripPath + '/start', driver.token), 200);

    const completing = await expectStatus(post(tripPath + '/complete', driver.token), 202);

    assert.equal((await finishedOperation(driver, completing.id)).status, 'SUCCEEDED');
  } catch (error) {
    evidence.fail(error);
    throw error;
  } finally {
    await setOnline(driver, false).catch(() => {});
  }
});
