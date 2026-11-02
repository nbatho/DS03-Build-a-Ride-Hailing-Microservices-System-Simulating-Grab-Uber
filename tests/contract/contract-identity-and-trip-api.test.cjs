const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const { GATEWAY_ROUTES } = require('../../src/apps/api-gateway/src/proxy/routes');
const identityApi = require('../../docs/api/identity.openapi.json');
const tripApi = require('../../docs/api/trip.openapi.json');
const { testEvidence } = require('../helpers/test-evidence.cjs');
const {
  account,
  bringOnline,
  call,
  callTripDirectly,
  createQuote,
  findOffer,
  finishedOperation,
  poll,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const POINT = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const ajv = new Ajv2020({ strict: false });

addFormats(ajv);

function schemaFor(document, method, route, status) {
  const reply = document.paths[route]?.[method]?.responses?.[status];

  assert.ok(reply, method.toUpperCase() + ' ' + route + ' does not document status ' + status);

  return { components: document.components, ...reply.content['application/json'].schema };
}

test('Identity and Trip answer exactly as their OpenAPI documents say', { timeout: 300000 }, async t => {
  const evidence = testEvidence('contract-identity-and-trip-api', {
    purpose: 'Response thật của Identity và Trip khớp method, path, status và schema đã công bố, để bên gọi không phải đoán dữ liệu',
    setup: 'Stack Compose đầy đủ. Schema lấy từ docs/api/identity.openapi.json và docs/api/trip.openapi.json',
    steps: 'Đi hết vòng đời một chuyến qua Gateway và gọi route nội bộ từ trong container Trip, kiểm tra mỗi response bằng Ajv, đối chiếu route public với danh sách của Gateway',
    expected: 'Mọi response đúng status đã công bố và đúng schema; trường có điều kiện xuất hiện đúng lúc; route public có trên Gateway, route nội bộ thì không',
  });

  t.after(() => evidence.write());

  const check = (document, method, route, result, status) => {
    assert.equal(result.status, status, method.toUpperCase() + ' ' + route + ': ' + JSON.stringify(result.body));

    const validate = ajv.compile(schemaFor(document, method, route, status));

    assert.ok(
      validate(result.body),
      method.toUpperCase() + ' ' + route + ' ' + status + ': ' + JSON.stringify(validate.errors),
    );
    evidence.record({ method: method.toUpperCase(), route, status, code: result.body?.code });

    return result.body;
  };
  const trips = (method, route, result, status) => check(tripApi, method, route, result, status);
  const identity = (method, route, result, status) => check(identityApi, method, route, result, status);
  const post = (route, token, body = {}, key = randomUUID()) => call(route, { method: 'POST', token, key, body });

  const passenger = await account('PASSENGER');
  const stranger = await account('PASSENGER');
  const first = await account('DRIVER');
  const second = await account('DRIVER');
  const drivers = [first, second];

  try {
    await t.test('public and internal routes are where the documents say', () => {
      const onGateway = new Set(GATEWAY_ROUTES.map(item => item.method + ' /api/v1' + item.path));
      const documented = new Set();

      for (const document of [identityApi, tripApi]) {
        for (const [route, operations] of Object.entries(document.paths)) {
          for (const method of Object.keys(operations)) {
            const name = method.toUpperCase() + ' ' + route.replace(/\{\w+\}/g, '{id}');

            documented.add(name);
            assert.equal(onGateway.has(name), route.startsWith('/api/v1'), name);
          }
        }
      }

      for (const item of GATEWAY_ROUTES.filter(entry => ['IDENTITY', 'TRIP'].includes(entry.upstream))) {
        assert.ok(documented.has(item.method + ' /api/v1' + item.path), 'not documented: ' + item.path);
      }
    });

    await t.test('Identity answers match the document', async () => {
      const email = 'contract-' + randomUUID() + '@e2e.test';
      const password = 'Contract-' + randomUUID();
      const register = '/api/v1/auth/register';
      const login = '/api/v1/auth/login';
      const me = '/api/v1/users/me';
      const profile = { email, password, displayName: 'Contract', role: 'PASSENGER' };
      const authCall = async (route, body) => {
        for (;;) {
          const result = await call(route.replace('/api/v1', ''), { method: 'POST', body });

          if (result.status !== 429) {
            return result;
          }

          await new Promise(resolve => setTimeout(resolve, result.retryAfter * 1000));
        }
      };

      identity('post', register, await authCall(register, profile), 201);
      identity('post', register, await authCall(register, profile), 409);
      identity('post', register, await authCall(register, { email }), 400);

      const session = identity('post', login, await authCall(login, { email, password }), 200);

      identity('post', login, await authCall(login, { email, password: password + 'x' }), 401);
      identity('get', me, await call('/users/me', { token: session.accessToken }), 200);
      identity('get', me, await call('/users/me'), 401);
    });

    await t.test('Trip answers match the document through a whole trip', async () => {
      const list = '/api/v1/trips';
      const one = '/api/v1/trips/{tripId}';
      const operation = '/api/v1/operations/{operationId}';
      const action = name => one + '/' + name;

      trips('post', list, await call('/trips', { method: 'POST', token: passenger.token, body: { quoteId: randomUUID() } }), 400);
      trips('post', list, await post('/trips', passenger.token, { quoteId: randomUUID() }), 404);
      trips('post', list, await post('/trips', undefined, { quoteId: randomUUID() }), 401);
      trips('post', list, await post('/trips', first.token, { quoteId: randomUUID() }), 403);

      for (const driver of drivers) {
        await bringOnline(driver, POINT);
      }

      const quote = await createQuote(passenger, POINT);
      const created = trips('post', list, await post('/trips', passenger.token, { quoteId: quote.id }), 201);
      const tripPath = '/trips/' + created.id;

      for (const field of ['driverId', 'assignmentId', 'paymentId']) {
        assert.equal(created[field], undefined, field + ' before assignment');
      }

      trips('get', list, await call('/trips?limit=1', { token: passenger.token }), 200);
      trips('get', list, await call('/trips?limit=0', { token: passenger.token }), 400);
      trips('get', one, await call(tripPath, { token: passenger.token }), 200);
      trips('get', one, await call(tripPath, { token: stranger.token }), 403);
      trips('get', one, await call('/trips/' + randomUUID(), { token: passenger.token }), 404);
      trips('get', operation, await call('/operations/' + randomUUID(), { token: passenger.token }), 404);
      trips('post', action('start'), await post(tripPath + '/start', first.token), 403);
      trips('post', action('accept'), await post(tripPath + '/accept', first.token, {}), 400);
      trips('post', action('accept'), await post('/trips/' + randomUUID() + '/accept', first.token, { offerId: randomUUID() }), 404);

      const offered = await poll(
        async () => {
          const offers = await Promise.all(drivers.map(item => findOffer(item, created.id)));
          const index = offers.findIndex(Boolean);

          return index >= 0 ? { driver: drivers[index], other: drivers[1 - index], item: offers[index] } : null;
        },
        Boolean,
        30000,
        'first offer',
      );
      const rejecting = trips(
        'post',
        action('reject'),
        await post(tripPath + '/reject', offered.driver.token, { offerId: offered.item.offer.id, reason: 'NOT_INTERESTED' }),
        202,
      );

      assert.equal((await finishedOperation(offered.driver, rejecting.id)).status, 'SUCCEEDED');
      trips('get', operation, await call('/operations/' + rejecting.id, { token: offered.driver.token }), 200);
      trips('get', operation, await call('/operations/' + rejecting.id, { token: stranger.token }), 403);

      const next = await poll(() => findOffer(offered.other, created.id), Boolean, 30000, 'second offer');
      const driver = offered.other;
      const key = randomUUID();
      const accepting = trips('post', action('accept'), await post(tripPath + '/accept', driver.token, { offerId: next.offer.id }, key), 202);

      assert.ok(accepting.assignmentId);
      assert.equal((await finishedOperation(driver, accepting.id)).status, 'SUCCEEDED');
      trips('post', action('accept'), await post(tripPath + '/accept', driver.token, { offerId: randomUUID() }, key), 409);

      const assigned = trips('get', one, await call(tripPath, { token: passenger.token }), 200);

      assert.equal(assigned.status, 'ASSIGNED');
      assert.equal(assigned.driverId, driver.id);
      assert.ok(assigned.assignmentId);
      assert.equal(assigned.paymentId, undefined);

      const internalTrip = '/internal/v1/trips/{tripId}';
      const internalPath = '/internal/v1/trips/' + created.id;
      const retry = '/internal/v1/operations/{operationId}/retry';
      const retryBody = { commandId: randomUUID(), reason: 'Contract check' };
      const retryPath = id => '/internal/v1/operations/' + id + '/retry';
      const direct = (route, options) => callTripDirectly(route, options);

      trips('get', internalTrip, direct(internalPath, { tokenEnv: 'SVC_TOKEN_MATCHING_TRIP' }), 200);
      trips('get', internalTrip, direct(internalPath), 401);
      trips('get', internalTrip, direct(internalPath, { tokenEnv: 'SVC_TOKEN_OPS_TRIP' }), 403);
      trips('get', internalTrip, direct('/internal/v1/trips/' + randomUUID(), { tokenEnv: 'SVC_TOKEN_DRIVER_TRIP' }), 404);
      trips('post', retry, direct(retryPath(accepting.id), { method: 'POST', body: retryBody, tokenEnv: 'SVC_TOKEN_OPS_TRIP' }), 409);
      trips('post', retry, direct(retryPath(randomUUID()), { method: 'POST', body: { ...retryBody, commandId: randomUUID() }, tokenEnv: 'SVC_TOKEN_OPS_TRIP' }), 404);
      trips('post', retry, direct(retryPath(accepting.id), { method: 'POST', body: { commandId: randomUUID() }, tokenEnv: 'SVC_TOKEN_OPS_TRIP' }), 400);
      trips('post', retry, direct(retryPath(accepting.id), { method: 'POST', body: retryBody }), 401);
      trips('post', retry, direct(retryPath(accepting.id), { method: 'POST', body: retryBody, tokenEnv: 'SVC_TOKEN_MATCHING_TRIP' }), 403);

      trips('post', action('cancel'), await post(tripPath + '/cancel', passenger.token, { reason: 'NOT_A_REASON' }), 400);
      trips('post', action('complete'), await post(tripPath + '/complete', driver.token), 409);

      const started = trips('post', action('start'), await post(tripPath + '/start', driver.token), 200);

      assert.equal(started.status, 'IN_PROGRESS');
      trips('post', action('cancel'), await post(tripPath + '/cancel', passenger.token, { reason: 'CHANGE_PLAN' }), 409);

      const completing = trips('post', action('complete'), await post(tripPath + '/complete', driver.token), 202);

      assert.equal((await finishedOperation(driver, completing.id)).status, 'SUCCEEDED');

      const completed = trips('get', one, await call(tripPath, { token: passenger.token }), 200);

      assert.equal(completed.status, 'COMPLETED');
      assert.ok(completed.paymentId);

      const leaving = await createQuote(passenger, POINT);
      const toCancel = trips('post', list, await post('/trips', passenger.token, { quoteId: leaving.id }), 201);
      const cancelling = trips(
        'post',
        action('cancel'),
        await post('/trips/' + toCancel.id + '/cancel', passenger.token, { reason: 'WAIT_TOO_LONG' }),
        202,
      );

      assert.equal((await finishedOperation(passenger, cancelling.id)).status, 'SUCCEEDED');
    });

    evidence.set({ summary: 'Mọi response đã kiểm tra đều đúng status và schema đã công bố' });
  } catch (error) {
    evidence.fail(error);
    throw error;
  } finally {
    for (const driver of drivers) {
      if (driver.sequence > 0) {
        await setOnline(driver, false).catch(() => {});
      }
    }
  }
});
