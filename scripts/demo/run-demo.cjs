// Demo 9 bước (BA mục 13.3) trên stack Compose thật, mọi lệnh của người dùng đi qua Gateway.
// Mỗi bước in ra mã, trạng thái, sự kiện và hàng đợi để người trình bày chỉ vào; dừng chờ Enter giữa các bước.
//   npm run demo          dừng sau mỗi bước
//   npm run demo -- --auto   chạy liền một mạch (tập dượt, lấy bằng chứng)
// Kết quả lưu ở docs/test-evidence/demo/demo-run.json (không ghi token hay mật khẩu).
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const dotenv = require('dotenv');
const {
  GATEWAY,
  ROOT,
  account,
  bringOnline,
  call,
  compose,
  createQuote,
  driverProfile,
  expectStatus,
  findOffer,
  finishedOperation,
  poll,
  queryDb,
  sendLocation,
} = require('../../tests/helpers/e2e-client.cjs');

const AUTO = process.argv.includes('--auto');
const ZONE_A = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const SERVICES = [
  ['gateway', 8080],
  ['identity', 3001],
  ['driver', 3002],
  ['trip', 3003],
  ['payment', 3004],
  ['notification', 3005],
  ['matching', 3006],
  ['pricing', 3007],
];
const env = (() => {
  try {
    return dotenv.parse(fs.readFileSync(path.join(ROOT, '.env')));
  } catch {
    return {};
  }
})();
const VHOST = env.RABBITMQ_VHOST || 'ride';
const evidenceFile = path.join(ROOT, 'docs/test-evidence/demo/demo-run.json');
const evidence = { demo: 'BA mục 13.3 — demo 9 bước', gateway: GATEWAY, startedAt: new Date().toISOString(), steps: [] };
const prompt = AUTO ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });

function show(label, value) {
  console.log('  ' + label.padEnd(30) + (typeof value === 'string' ? value : JSON.stringify(value)));
}

async function step(number, title, mustShow, work) {
  console.log('\n' + '='.repeat(78));
  console.log(`Bước ${number}. ${title}`);
  console.log('  Cần cho thấy: ' + mustShow);
  console.log('-'.repeat(78));

  const started = Date.now();
  const data = await work();

  evidence.steps.push({ step: number, title, durationMs: Date.now() - started, ...data });

  if (prompt) {
    await prompt.question('\n  [Enter] sang bước tiếp theo ');
  }

  return data;
}

function healthOf(service, port) {
  const script = `fetch('http://127.0.0.1:${port}/health/ready').then(async r => console.log(r.status + ' ' + await r.text())).catch(e => console.log('000 ' + e.message))`;
  const [http, ...body] = compose(['exec', '-T', service, 'node', '-e', script]).split(' ');
  let parsed;

  try {
    parsed = JSON.parse(body.join(' '));
  } catch {
    parsed = { status: body.join(' ') };
  }

  return { http: Number(http), status: parsed.status, instanceId: parsed.instanceId };
}

/** Hàng đợi chính (không gồm hàng thử lại) với số tin đang chờ / đang xử lý. */
function queues() {
  return compose(['exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q', 'list_queues', '-p', VHOST, 'name', 'messages_ready', 'messages_unacknowledged'])
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(([name]) => name && !name.includes('.retry.') && name !== 'name')
    .map(([name, ready, unacked]) => ({ name, ready: Number(ready), unacked: Number(unacked) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function printQueues(list) {
  for (const queue of list) {
    show(queue.name, 'chờ ' + queue.ready + ', đang xử lý ' + queue.unacked);
  }
}

const tripHistory = tripId =>
  queryDb(
    'trip-db',
    'trip_db',
    `SELECT string_agg(coalesce(from_status, '-') || '->' || to_status, ', ' ORDER BY occurred_at) FROM trip_schema.state_history WHERE trip_id = '${tripId}'`,
  );

async function book(passenger, correlationId = randomUUID()) {
  const quote = await createQuote(passenger, ZONE_A);
  const trip = await expectStatus(
    call('/trips', { method: 'POST', token: passenger.token, key: randomUUID(), correlationId, body: { quoteId: quote.id } }),
    201,
  );

  return { quote, trip, correlationId };
}

async function accept(driver, tripId, offerId) {
  const response = await call('/trips/' + tripId + '/accept', {
    method: 'POST',
    token: driver.token,
    key: randomUUID(),
    body: { offerId },
  });

  if (response.status !== 202) {
    return { tripId, http: response.status, code: response.body?.code };
  }

  const operation = await finishedOperation(driver, response.body.id);

  return { tripId, http: 202, operation: operation.status, assignmentId: response.body.assignmentId };
}

async function drive(driver, tripId) {
  const command = action =>
    call('/trips/' + tripId + '/' + action, { method: 'POST', token: driver.token, key: randomUUID(), body: {} });
  const started = await expectStatus(command('start'), 200);
  const completing = await expectStatus(command('complete'), 202);
  const finished = await finishedOperation(driver, completing.id);

  return { started: started.status, completeOperation: finished.status, operationId: completing.id };
}

const tripOf = (user, tripId) => expectStatus(call('/trips/' + tripId, { token: user.token }), 200);

async function main() {
  console.log('Demo DS03 qua Gateway ' + GATEWAY + (AUTO ? ' (chạy liền)' : ''));

  const ready = await fetch(GATEWAY + '/health/ready', { signal: AbortSignal.timeout(5000) }).catch(() => undefined);

  if (ready?.status !== 200) {
    throw new Error('Gateway ' + GATEWAY + ' chưa sẵn sàng; chạy npm run stack:up trước');
  }

  let passenger;
  let rival;
  let driver;

  await step(1, 'Chạy cả hệ thống bằng Compose', 'tên service, mã instance, cổng, health; 7 container DB riêng', async () => {
    const services = SERVICES.map(([service, port]) => {
      const health = healthOf(service, port);

      show(service + ' :' + port, health.http + ' ' + health.status + ', instance ' + health.instanceId);

      return { service, port, ...health };
    });
    const databases = compose(['ps', '--format', '{{.Service}} {{.Status}}'])
      .split('\n')
      .filter(line => line.includes('-db '));

    console.log('  DB riêng của từng service (' + databases.length + '):');
    databases.forEach(line => show('', line));
    console.log('  Xem log song song: npm run stack:logs');

    return { services, databases };
  });

  await step(2, 'Tài xế đăng ký, có xe, gửi vị trí, bật nhận chuyến', 'dữ liệu hợp lệ; tài xế là ứng viên đúng vùng', async () => {
    driver = await account('DRIVER');
    passenger = await account('PASSENGER');
    rival = await account('PASSENGER');
    await bringOnline(driver, ZONE_A);

    const profile = await driverProfile(driver);
    const location = queryDb(
      'driver-db',
      'driver_db',
      `SELECT zone_id || ' lúc ' || to_char(received_at, 'HH24:MI:SS') FROM driver_schema.latest_locations WHERE driver_id = '${driver.id}'`,
    );

    show('Tài xế', driver.id);
    show('Trạng thái', profile.status);
    show('Vị trí mới nhất (DB)', location);
    show('Khách', passenger.id);

    return { driverId: driver.id, driverStatus: profile.status, location, passengerId: passenger.id };
  });

  let first;

  await step(3, 'Khách báo giá rồi đặt chuyến qua Gateway', 'mã báo giá, mã chuyến, bản chụp giá, sự kiện chuyến mới', async () => {
    await sendLocation(driver, ZONE_A);
    first = await book(passenger);

    const event = queryDb(
      'trip-db',
      'trip_db',
      `SELECT type || ' ' || event_id || ' ' || status FROM trip_schema.outbox_events WHERE aggregate_id = '${first.trip.id}' AND type = 'trip.requested'`,
    );
    const fare = queryDb(
      'trip-db',
      'trip_db',
      `SELECT amount || ' VND, ' || rule_version FROM trip_schema.fare_snapshots WHERE trip_id = '${first.trip.id}'`,
    );

    show('Báo giá', first.quote.id + ' = ' + first.quote.amount + ' ' + first.quote.currency);
    show('Chuyến', first.trip.id + ' (' + first.trip.status + ')');
    show('Bản chụp giá (Trip DB)', fare);
    show('Sự kiện gửi đi', event);
    show('Mã theo dõi', first.correlationId);

    return { quoteId: first.quote.id, tripId: first.trip.id, amount: first.trip.amount, fare, event, correlationId: first.correlationId };
  });

  let offer;

  await step(4, 'Ghép chuyến chọn tài xế, Thông báo hiện lời mời', 'việc tìm, lời mời, người nhận, đường đi qua RabbitMQ', async () => {
    offer = await poll(() => findOffer(driver, first.trip.id), Boolean, 30000, 'lời mời');

    const job = queryDb(
      'matching-db',
      'matching_db',
      `SELECT id || ' ' || status FROM matching_schema.matching_jobs WHERE trip_id = '${first.trip.id}'`,
    );

    show('Việc tìm (Matching DB)', job);
    show('Lời mời', offer.offer.id + ' hết hạn ' + offer.offer.expiresAt);
    show('Người nhận', offer.recipientId + (offer.recipientId === driver.id ? ' (đúng tài xế)' : ' (SAI)'));
    show('Sự kiện nguồn', offer.sourceEventId);
    console.log('  Hàng đợi RabbitMQ (exchange ride.events):');
    printQueues(queues());

    return { job, offerId: offer.offer.id, recipientId: offer.recipientId, sourceEventId: offer.sourceEventId };
  });

  await step(5, 'Tài xế nhận → bắt đầu → kết thúc; thanh toán mô phỏng', 'quy trình nhận chuyến, giữ xe, thanh toán, trạng thái và thông báo', async () => {
    const accepted = await accept(driver, first.trip.id, offer.offer.id);
    const reservation = queryDb(
      'driver-db',
      'driver_db',
      `SELECT status FROM driver_schema.reservations WHERE id = '${accepted.assignmentId}'`,
    );

    show('Nhận chuyến (thao tác nền)', accepted.operation + ', giữ xe ' + reservation);

    const driven = await drive(driver, first.trip.id);
    const paid = await poll(() => tripOf(passenger, first.trip.id), trip => trip.paymentStatus === 'SUCCEEDED', 60000, 'thanh toán');
    const payment = await expectStatus(call('/payments?tripId=' + first.trip.id, { token: passenger.token }), 200);
    const notices = (await expectStatus(call('/notifications?limit=20', { token: passenger.token }), 200)).items
      .filter(item => item.tripId === first.trip.id)
      .map(item => item.title);

    show('Kết thúc (thao tác nền)', driven.completeOperation);
    show('Lịch sử trạng thái', tripHistory(first.trip.id));
    show('Thanh toán', payment.id + ' ' + payment.status + ', lần thử ' + payment.attemptNo + ', ' + payment.amount + ' VND');
    show('Xe sau chuyến', queryDb('driver-db', 'driver_db', `SELECT status FROM driver_schema.reservations WHERE id = '${accepted.assignmentId}'`));
    show('Thông báo cho khách', notices.join(' | '));

    return { assignmentId: accepted.assignmentId, history: tripHistory(first.trip.id), paymentId: payment.id, paymentStatus: paid.paymentStatus, notices };
  });

  await step(6, 'Hai khách cùng lúc tranh một tài xế', 'một người thắng; người còn lại được xử lý hợp lệ; DB không giữ một tài xế cho hai chuyến', async () => {
    await sendLocation(driver, ZONE_A);

    const pair = await Promise.all([book(passenger), book(rival)]);
    const ids = pair.map(item => item.trip.id);
    const collect = async () => (await Promise.all(ids.map(id => findOffer(driver, id)))).filter(Boolean);

    await poll(collect, list => list.length > 0, 30000, 'lời mời cho một trong hai chuyến');
    await sleep(2000);

    const offers = await collect();
    // Tài xế bấm nhận mọi lời mời đang có cùng một lúc.
    const results = await Promise.all(offers.map(item => accept(driver, item.tripId, item.offer.id)));
    const active = queryDb(
      'driver-db',
      'driver_db',
      `SELECT count(*) FROM driver_schema.reservations WHERE driver_id = '${driver.id}' AND status IN ('HELD', 'CONFIRMED')`,
    );
    const winner = results.find(item => item.operation === 'SUCCEEDED');

    show('Lời mời tài xế nhận được', offers.length + ' (' + offers.map(item => item.tripId.slice(0, 8)).join(', ') + ')');
    results.forEach(item => show('Nhận chuyến ' + item.tripId.slice(0, 8), item.operation ?? item.http + ' ' + item.code));
    show('Lượt giữ xe còn hiệu lực', active + ' (tối đa 1)');

    if (winner) {
      await drive(driver, winner.tripId);
    }

    const loserId = ids.find(id => id !== winner?.tripId);
    const owner = loserId === pair[0].trip.id ? passenger : rival;

    console.log('  Chuyến còn lại tiếp tục tìm tài xế; tài xế duy nhất đang bận nên tối đa 60 giây sẽ thành NO_DRIVER...');

    const loser = await poll(() => tripOf(owner, loserId), trip => !['MATCHING', 'ASSIGNING'].includes(trip.status), 90000, 'chuyến còn lại');

    show('Chuyến thắng', (winner?.tripId ?? '-') + ' → COMPLETED');
    show('Chuyến còn lại', loserId + ' → ' + loser.status);

    return { trips: ids, offers: offers.length, results, activeReservations: Number(active), winner: winner?.tripId, loser: { tripId: loserId, status: loser.status } };
  });

  let pending;

  try {
    await step(7, 'Tắt Thanh toán ngay trước khi kết thúc chuyến', 'quá thời gian, trạng thái chờ, hàng đợi; phần còn lại vẫn chạy', async () => {
      compose(['stop', 'payment'], 120000);
      show('Payment', 'đã tắt (docker compose stop payment)');
      await sendLocation(driver, ZONE_A);
      pending = await book(passenger);

      const found = await poll(() => findOffer(driver, pending.trip.id), Boolean, 30000, 'lời mời');

      await accept(driver, pending.trip.id, found.offer.id);
      await drive(driver, pending.trip.id);

      const trip = await tripOf(passenger, pending.trip.id);
      const started = Date.now();
      const viaGateway = await call('/payments?tripId=' + pending.trip.id, { token: passenger.token });
      const elapsed = Date.now() - started;
      const others = await call('/trips/' + pending.trip.id, { token: passenger.token });

      await sleep(3000);

      const list = queues();

      show('Chuyến', pending.trip.id + ' ' + trip.status + ', thanh toán ' + trip.paymentStatus);
      show('GET /payments khi tắt', viaGateway.status + ' ' + (viaGateway.body?.code ?? '') + ' sau ' + elapsed + ' ms');
      show('GET /trips vẫn chạy', String(others.status));
      console.log('  Hàng đợi: yêu cầu thanh toán nằm chờ trong payment.events');
      printQueues(list);

      return {
        tripId: pending.trip.id,
        tripStatus: trip.status,
        paymentStatus: trip.paymentStatus,
        paymentsWhileDown: { http: viaGateway.status, code: viaGateway.body?.code, elapsedMs: elapsed },
        tripsWhileDown: others.status,
        queues: list,
      };
    });

    await step(8, 'Quan sát việc tồn đọng, thử lại và mã theo dõi', 'giới hạn thử lại, mã theo dõi, không mất và không thu trùng', async () => {
      const outbox = queryDb(
        'trip-db',
        'trip_db',
        `SELECT type || ' ' || event_id || ' ' || status || ' ' || coalesce(to_char(published_at, 'HH24:MI:SS'), '') FROM trip_schema.outbox_events WHERE aggregate_id = '${pending.trip.id}' AND type = 'payment.requested'`,
      );
      const waiting = queues().find(item => item.name === 'payment.events');

      show('Sự kiện yêu cầu thanh toán', outbox);
      show('Tin chờ ở payment.events', String(waiting?.ready ?? 0));
      show('Payment DB của chuyến', queryDb('payment-db', 'payment_db', `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${pending.trip.id}'`) + ' khoản (chưa xử lý)');
      show('Mã theo dõi', pending.correlationId + ' (tìm trong npm run stack:logs)');
      console.log('  Quy tắc: mỗi chuyến tối đa 3 lần thử, cùng một mã thanh toán; tin lỗi cấu trúc vào payment.events.dlq.');

      return { outbox, waitingInQueue: waiting?.ready ?? 0, correlationId: pending.correlationId };
    });
  } finally {
    compose(['start', 'payment'], 120000);
  }

  await step(9, 'Bật lại Thanh toán và chạy phục hồi', 'tin nhắn chạy tiếp; trạng thái cuối nhất quán; lưu bằng chứng', async () => {
    show('Payment', 'đã bật lại (docker compose start payment)');

    const started = Date.now();
    const trip = await poll(() => tripOf(passenger, pending.trip.id), item => item.paymentStatus === 'SUCCEEDED', 90000, 'thanh toán sau khi bật lại');
    const payments = queryDb('payment-db', 'payment_db', `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${pending.trip.id}'`);
    const attempts = queryDb(
      'payment-db',
      'payment_db',
      `SELECT count(*) FROM payment_schema.payment_attempts a JOIN payment_schema.payments p ON p.id = a.payment_id WHERE p.trip_id = '${pending.trip.id}'`,
    );

    show('Thanh toán sau phục hồi', trip.paymentStatus + ' sau ' + Math.round((Date.now() - started) / 1000) + ' giây');
    show('Số khoản / lần thử', payments + ' / ' + attempts + ' (không thu trùng)');
    printQueues(queues());

    return { tripId: pending.trip.id, paymentStatus: trip.paymentStatus, recoveredInMs: Date.now() - started, payments: Number(payments), attempts: Number(attempts) };
  });

  evidence.status = 'PASS';
}

main()
  .catch(error => {
    evidence.status = 'FAIL';
    evidence.error = error.message + (error.cause ? ' (' + (error.cause.code ?? error.cause.message) + ')' : '');
    console.error('\nDemo dừng: ' + evidence.error + '\n' + error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    prompt?.close();
    evidence.finishedAt = new Date().toISOString();
    evidence.tokens = '[REDACTED]';
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
    console.log('\nBằng chứng: ' + path.relative(ROOT, evidenceFile));
  });
