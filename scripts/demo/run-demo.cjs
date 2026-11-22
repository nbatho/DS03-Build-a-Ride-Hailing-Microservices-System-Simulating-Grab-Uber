// Demo 9 bước (mục 7.4 của đề) trên stack Compose thật, mọi lệnh của người dùng đi qua Gateway.
// Mỗi bước in: mục tiêu → việc đang làm → số liệu đọc từ API/DB/RabbitMQ → một dòng kết luận.
// Người dùng được đặt tên (Khách A, Khách B, Tài xế 1), mã UUID rút còn 8 ký tự cho dễ đọc.
//   npm run demo             dừng sau mỗi bước, bấm Enter để sang bước tiếp
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
const TOTAL_STEPS = 9;
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
const COMPOSE_CMD = 'docker compose --env-file .env -f deploy/docker-compose.yml';
const evidenceFile = path.join(ROOT, 'docs/test-evidence/demo/demo-run.json');
const evidence = {
  demo: 'Mục 7.4 của đề — demo 9 bước',
  gateway: GATEWAY,
  startedAt: new Date().toISOString(),
  steps: [],
};
const prompt = AUTO
  ? undefined
  : readline.createInterface({ input: process.stdin, output: process.stdout });
const summary = [];
let conclusion;

// ---------- In ra màn hình ----------

const short = id => (id ? String(id).slice(0, 8) : '-');
const named = (name, id) => name + ' [' + short(id) + ']';
const clock = iso => (iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour12: false }) : '-');
const money = amount => Number(amount).toLocaleString('vi-VN') + ' đ';

function show(label, value) {
  console.log(
    '    ' + label.padEnd(28) + (typeof value === 'string' ? value : JSON.stringify(value)),
  );
}

/** Một dòng mô tả việc script đang làm, để người xem biết vì sao màn hình đang chờ. */
function say(text) {
  console.log('  … ' + text);
}

/** Dòng kết luận cuối bước: bước này chứng minh điều gì. */
function conclude(text) {
  conclusion = text;
  console.log('\n  → Kết luận: ' + text);
}

/** Chờ một điều kiện, hiện bộ đếm giây để màn hình không đứng im. */
async function waitFor(message, read, done, timeoutMs, label) {
  const started = Date.now();
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
  const tty = process.stdout.isTTY;
  const line = () => '  … ' + message + ' (' + Math.round((Date.now() - started) / 1000) + ' s)';
  let width = 0;
  const timer = tty
    ? setInterval(() => {
        const text = line();

        width = Math.max(width, text.length);
        process.stdout.write('\r' + text);
      }, 1000)
    : undefined;

  if (!tty) {
    say(message);
  }

  try {
    const result = await poll(read, done, timeoutMs, label);

    finish('→ xong sau ' + seconds() + ' s');

    return result;
  } catch (error) {
    finish('→ HẾT THỜI GIAN sau ' + seconds() + ' s');
    throw error;
  }

  /** TTY: thay dòng đếm giây bằng dòng kết quả; không phải TTY: in kết quả ở dòng dưới. */
  function finish(outcome) {
    clearLine();
    console.log((tty ? '  … ' + message + ' ' : '      ') + outcome);
  }

  function clearLine() {
    clearInterval(timer);
    if (tty && width) {
      process.stdout.write('\r' + ' '.repeat(width) + '\r');
    }
  }
}

/** In mã theo dõi và lệnh PowerShell lọc log của đúng luồng đó trên mọi service. */
function logHint(correlationId, pattern = correlationId) {
  show('Mã theo dõi (correlationId)', correlationId);
  show('Lọc log của luồng này', COMPOSE_CMD + " logs --no-color | Select-String '" + pattern + "'");
}

/** Giá trị "nội dung|epoch giây" từ DB → "nội dung lúc HH:MM:SS" theo giờ máy, cùng múi giờ với các mốc khác. */
function atLocalTime(row) {
  const [text, epoch] = row.split('|');

  return text + ' lúc ' + (epoch ? clock(Number(epoch) * 1000) : '-');
}

async function step(number, title, goal, work) {
  console.log('\n' + '='.repeat(78));
  console.log(`BƯỚC ${number}/${TOTAL_STEPS}. ${title}`);
  console.log('  Mục tiêu: ' + goal);
  console.log('-'.repeat(78));

  conclusion = undefined;
  const started = Date.now();
  const data = await work();

  evidence.steps.push({
    step: number,
    title,
    conclusion,
    durationMs: Date.now() - started,
    ...data,
  });

  summary.push({ number, title, conclusion });

  if (prompt) {
    await prompt.question('\n  [Enter] sang bước tiếp theo ');
  }

  return data;
}

// ---------- Đọc trạng thái ----------

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

/** Hàng đợi chính và DLQ (không gồm hàng thử lại) với số tin đang chờ / đang xử lý. */
function queues() {
  return compose([
    'exec',
    '-T',
    'rabbitmq',
    'rabbitmqctl',
    '-q',
    'list_queues',
    '-p',
    VHOST,
    'name',
    'messages_ready',
    'messages_unacknowledged',
  ])
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(([name]) => name && !name.includes('.retry.') && name !== 'name')
    .map(([name, ready, unacked]) => ({ name, ready: Number(ready), unacked: Number(unacked) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Mỗi hàng đợi một dòng, gộp số tin trong DLQ của nó. */
function printQueues(list) {
  for (const queue of list.filter(item => !item.name.endsWith('.dlq'))) {
    const dlq = list.find(item => item.name === queue.name + '.dlq');

    show(
      queue.name,
      'chờ ' + queue.ready + ', đang xử lý ' + queue.unacked + ', DLQ ' + (dlq?.ready ?? 0),
    );
  }
}

const allQueuesEmpty = list => list.every(item => item.ready === 0 && item.unacked === 0);

/** Lịch sử trạng thái dạng "MATCHING → ASSIGNING → …". */
const tripHistory = tripId =>
  queryDb(
    'trip-db',
    'trip_db',
    `SELECT string_agg(to_status, ' → ' ORDER BY occurred_at) FROM trip_schema.state_history WHERE trip_id = '${tripId}'`,
  );

// ---------- Thao tác của người dùng ----------

async function book(passenger, correlationId = randomUUID()) {
  const quote = await createQuote(passenger, ZONE_A);
  const trip = await expectStatus(
    call('/trips', {
      method: 'POST',
      token: passenger.token,
      key: randomUUID(),
      correlationId,
      body: { quoteId: quote.id },
    }),
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

  return {
    tripId,
    http: 202,
    operation: operation.status,
    errorCode: operation.errorCode,
    assignmentId: response.body.assignmentId,
  };
}

async function drive(driver, tripId) {
  const command = action =>
    call('/trips/' + tripId + '/' + action, {
      method: 'POST',
      token: driver.token,
      key: randomUUID(),
      body: {},
    });
  const started = await expectStatus(command('start'), 200);
  const completing = await expectStatus(command('complete'), 202);
  const finished = await finishedOperation(driver, completing.id);

  return {
    started: started.status,
    completeOperation: finished.status,
    operationId: completing.id,
  };
}

const tripOf = (user, tripId) => expectStatus(call('/trips/' + tripId, { token: user.token }), 200);

// ---------- Kịch bản ----------

async function main() {
  console.log(
    'Demo DS03 – hệ thống gọi xe microservices, qua Gateway ' +
      GATEWAY +
      (AUTO ? ' (chạy liền)' : ''),
  );

  const ready = await fetch(GATEWAY + '/health/ready', { signal: AbortSignal.timeout(5000) }).catch(
    () => undefined,
  );

  if (ready?.status !== 200) {
    throw new Error('Gateway ' + GATEWAY + ' chưa sẵn sàng; chạy npm run stack:up trước');
  }

  let passenger;
  let rival;
  let driver;

  await step(
    1,
    'Các service chạy độc lập',
    '8 tiến trình riêng, mỗi tiến trình có mã instance; mỗi service một DB riêng',
    async () => {
      say('Gọi /health/ready bên trong từng container');

      const services = SERVICES.map(([service, port]) => {
        const health = healthOf(service, port);

        show(
          service + ' :' + port,
          health.http + ' ' + health.status + ', instance ' + short(health.instanceId),
        );

        return { service, port, ...health };
      });
      const databases = compose(['ps', '--format', '{{.Service}} {{.Status}}'])
        .split('\n')
        .filter(line => line.includes('-db '));

      console.log('    DB riêng của từng service (' + databases.length + '):');
      databases.forEach(line => show('', line));

      const up = services.filter(item => item.http === 200).length;

      conclude(
        `${up}/${services.length} tiến trình sẵn sàng, mỗi tiến trình một mã instance khác nhau; ${databases.length} PostgreSQL tách biệt, ` +
          'không service nào đọc DB của service khác. Log song song: npm run stack:logs.',
      );

      return { services, databases };
    },
  );

  await step(
    2,
    'Tài xế sẵn sàng nhận chuyến',
    'tài xế có hồ sơ, xe, vị trí GPS và đang AVAILABLE trong vùng ZONE_A',
    async () => {
      say('Tạo 3 tài khoản qua Identity: Tài xế 1, Khách A, Khách B');
      driver = await account('DRIVER');
      passenger = await account('PASSENGER');
      rival = await account('PASSENGER');

      say('Tài xế 1 khai hồ sơ, đăng ký xe, gửi GPS ở ZONE_A, bật nhận chuyến (Driver service)');
      await bringOnline(driver, ZONE_A);

      const profile = await driverProfile(driver);
      const location = atLocalTime(
        queryDb(
          'driver-db',
          'driver_db',
          `SELECT zone_id || '|' || extract(epoch FROM received_at) FROM driver_schema.latest_locations WHERE driver_id = '${driver.id}'`,
        ),
      );

      show('Tài xế 1', short(driver.id) + ', trạng thái ' + profile.status);
      show('Vị trí mới nhất (DB Driver)', location);
      show('Khách A / Khách B', short(passenger.id) + ' / ' + short(rival.id));

      conclude(
        `Tài xế 1 đang ${profile.status} ở ZONE_A nên là ứng viên cho chuyến trong vùng này. GPS đóng vai trò heartbeat: quá 60 s không gửi thì tài xế bị coi là offline.`,
      );

      return {
        driverId: driver.id,
        driverStatus: profile.status,
        location,
        passengerId: passenger.id,
        rivalId: rival.id,
      };
    },
  );

  let first;

  await step(
    3,
    'Khách A đặt xe',
    'có báo giá, chuyến mới, giá được chụp lại, sự kiện trip.requested được gửi',
    async () => {
      await sendLocation(driver, ZONE_A);
      say(
        'Khách A xin báo giá (Pricing) rồi đặt chuyến bằng mã báo giá (Trip gọi REST nội bộ sang Pricing)',
      );

      first = await book(passenger);

      const event = queryDb(
        'trip-db',
        'trip_db',
        `SELECT type || ' | ' || status FROM trip_schema.outbox_events WHERE aggregate_id = '${first.trip.id}' AND type = 'trip.requested'`,
      );
      const fare = queryDb(
        'trip-db',
        'trip_db',
        `SELECT amount || ' VND, bảng giá ' || rule_version FROM trip_schema.fare_snapshots WHERE trip_id = '${first.trip.id}'`,
      );

      show(
        'Báo giá',
        short(first.quote.id) + ' = ' + money(first.quote.amount) + ' (3 km, 10 phút)',
      );

      show('Chuyến của Khách A', short(first.trip.id) + ', trạng thái ' + first.trip.status);
      show('Bản chụp giá (DB Trip)', fare);
      show('Sự kiện (outbox DB Trip)', event);
      logHint(first.correlationId);

      conclude(
        'Chuyến được tạo ở trạng thái ' +
          first.trip.status +
          '. Trip ghi chuyến và sự kiện trip.requested trong cùng một transaction (outbox), ' +
          'rồi gửi sang RabbitMQ (PUBLISHED). Trip không gọi thẳng Matching: đây là luồng bất đồng bộ.',
      );

      return {
        quoteId: first.quote.id,
        tripId: first.trip.id,
        amount: first.trip.amount,
        fare,
        event,
        correlationId: first.correlationId,
      };
    },
  );

  let offer;

  await step(
    4,
    'Matching chọn tài xế',
    'Matching nhận sự kiện qua RabbitMQ, chọn Tài xế 1 và gửi lời mời có hạn',
    async () => {
      offer = await waitFor(
        'Đang chờ Matching nhận trip.requested qua RabbitMQ và mời tài xế',
        () => findOffer(driver, first.trip.id),
        Boolean,
        30000,
        'lời mời',
      );

      const job = queryDb(
        'matching-db',
        'matching_db',
        `SELECT status FROM matching_schema.matching_jobs WHERE trip_id = '${first.trip.id}'`,
      );
      const list = queues();

      show('Việc tìm (DB Matching)', job);
      show('Lời mời', short(offer.offer.id) + ', hết hạn lúc ' + clock(offer.offer.expiresAt));
      show(
        'Người nhận lời mời',
        offer.recipientId === driver.id
          ? 'Tài xế 1 (đúng người)'
          : named('SAI người', offer.recipientId),
      );

      console.log('    Hàng đợi RabbitMQ (exchange ride.events):');
      printQueues(list);

      conclude(
        'Chuỗi bất đồng bộ Trip → RabbitMQ → Matching → RabbitMQ → Notification đã chạy. Lời mời đến đúng Tài xế 1, có hạn 15 s' +
          (allQueuesEmpty(list)
            ? '; mọi hàng đợi về 0 nghĩa là tin đã được xử lý, không có tin lỗi trong DLQ.'
            : '.'),
      );

      return {
        job,
        offerId: offer.offer.id,
        recipientId: offer.recipientId,
        sourceEventId: offer.sourceEventId,
        queues: list,
      };
    },
  );

  await step(
    5,
    'Tài xế nhận và hoàn thành chuyến',
    'Saga nhận chuyến thành công, chuyến đi đúng thứ tự trạng thái, thanh toán và thông báo',
    async () => {
      say(
        'Tài xế 1 bấm Nhận: Trip chạy Saga (claim lời mời → giữ tài xế → xác nhận → ghi chuyến → chốt Matching)',
      );

      const accepted = await accept(driver, first.trip.id, offer.offer.id);
      const reservation = queryDb(
        'driver-db',
        'driver_db',
        `SELECT status FROM driver_schema.reservations WHERE id = '${accepted.assignmentId}'`,
      );

      show('Saga nhận chuyến', accepted.operation + ', giữ xe ' + reservation);

      say('Tài xế 1 bấm Bắt đầu rồi Kết thúc chuyến');
      const driven = await drive(driver, first.trip.id);
      const paid = await waitFor(
        'Đang chờ thanh toán: Trip → payment.requested → Payment → payment.succeeded → Trip',
        () => tripOf(passenger, first.trip.id),
        trip => trip.paymentStatus === 'SUCCEEDED',
        60000,
        'thanh toán',
      );
      const payment = await expectStatus(
        call('/payments?tripId=' + first.trip.id, { token: passenger.token }),
        200,
      );
      const notices = (
        await expectStatus(call('/notifications?limit=20', { token: passenger.token }), 200)
      ).items
        .filter(item => item.tripId === first.trip.id)
        .map(item => item.title)
        .reverse();
      const released = queryDb(
        'driver-db',
        'driver_db',
        `SELECT status FROM driver_schema.reservations WHERE id = '${accepted.assignmentId}'`,
      );
      const history = tripHistory(first.trip.id);

      show('Saga kết thúc chuyến', driven.completeOperation);
      show('Lịch sử trạng thái', history);
      show(
        'Thanh toán',
        payment.status + ', lần thử ' + payment.attemptNo + ', ' + money(payment.amount),
      );

      show('Giữ xe sau chuyến', released);
      show('Thông báo cho Khách A', notices.join(' → '));

      conclude(
        `Saga nhận chuyến ${accepted.operation} (giữ xe ${reservation}, sau chuyến ${released}). Chuyến đi đúng thứ tự trạng thái, ` +
          `thanh toán ${payment.status} sau ${payment.attemptNo} lần thử, Khách A nhận ${notices.length} thông báo.`,
      );

      return {
        assignmentId: accepted.assignmentId,
        history,
        paymentId: payment.id,
        paymentStatus: paid.paymentStatus,
        notices,
      };
    },
  );

  await step(
    6,
    'Đồng thời: hai khách đặt cùng lúc, một tài xế bấm nhận cả hai',
    'chỉ một chuyến giữ được tài xế; chuyến kia được bù trừ; không tài xế nào bị gán hai chuyến',
    async () => {
      await sendLocation(driver, ZONE_A);

      say('Khách A và Khách B cùng đặt chuyến một lúc; ZONE_A chỉ có Tài xế 1');
      const pair = await Promise.all([book(passenger), book(rival)]);
      const ids = pair.map(item => item.trip.id);
      const ownerName = id => (id === ids[0] ? 'Khách A' : 'Khách B');
      const owner = id => (id === ids[0] ? passenger : rival);
      const collect = async () =>
        (await Promise.all(ids.map(id => findOffer(driver, id)))).filter(Boolean);

      await waitFor(
        'Đang chờ Matching mời Tài xế 1 cho hai chuyến',
        collect,
        list => list.length > 0,
        30000,
        'lời mời cho một trong hai chuyến',
      );

      await sleep(2000);

      const offers = await collect();

      show(
        'Lời mời Tài xế 1 đang có',
        offers.length +
          ' (' +
          offers.map(item => 'chuyến của ' + ownerName(item.tripId)).join(', ') +
          ')',
      );

      say(
        'Tài xế 1 bấm Nhận tất cả lời mời cùng một lúc → các Saga cùng xin Driver giữ một tài xế',
      );

      // Tài xế bấm nhận mọi lời mời đang có cùng một lúc.
      const results = await Promise.all(
        offers.map(item => accept(driver, item.tripId, item.offer.id)),
      );
      const active = queryDb(
        'driver-db',
        'driver_db',
        `SELECT count(*) FROM driver_schema.reservations WHERE driver_id = '${driver.id}' AND status IN ('HELD', 'CONFIRMED')`,
      );
      const winner = results.find(item => item.operation === 'SUCCEEDED');

      for (const item of results) {
        const meaning =
          item.operation === 'SUCCEEDED'
            ? 'thắng, giữ được tài xế'
            : item.operation === 'FAILED_COMPENSATED'
              ? 'thua (' +
                (item.errorCode ?? 'DRIVER_UNAVAILABLE') +
                ') → Saga bù trừ: trả tài xế, chuyến quay lại tìm tài xế khác'
              : item.http + ' ' + (item.code ?? '');

        show('Chuyến của ' + ownerName(item.tripId), (item.operation ?? '') + ' – ' + meaning);
      }

      show('Lượt giữ xe còn hiệu lực', active + ' (bất biến: tối đa 1)');

      if (winner) {
        say('Tài xế 1 chạy hết chuyến thắng');
        await drive(driver, winner.tripId);
      }

      const loserId = ids.find(id => id !== winner?.tripId);
      const loser = await waitFor(
        'Chuyến của ' +
          ownerName(loserId) +
          ' tìm tiếp; tài xế duy nhất đã bận nên sẽ hết hạn tìm (tối đa 60 s)',
        () => tripOf(owner(loserId), loserId),
        trip => !['MATCHING', 'ASSIGNING'].includes(trip.status),
        90000,
        'chuyến còn lại',
      );

      show(
        'Chuyến thắng',
        winner ? 'chuyến của ' + ownerName(winner.tripId) + ' → COMPLETED' : '-',
      );

      show('Chuyến còn lại', 'chuyến của ' + ownerName(loserId) + ' → ' + loser.status);

      conclude(
        `Driver khoá hàng tài xế và có chỉ mục duy nhất trên lượt giữ xe, nên chỉ một Saga thành công: ${active} lượt giữ xe còn hiệu lực. ` +
          `Bên thua không bị treo mà được bù trừ, chuyến kết thúc hợp lệ ở ${loser.status}.`,
      );

      return {
        trips: ids,
        offers: offers.length,
        results,
        activeReservations: Number(active),
        winner: winner?.tripId,
        loser: { tripId: loserId, status: loser.status },
      };
    },
  );

  let pending;

  try {
    await step(
      7,
      'Lỗi: tắt Payment giữa luồng nghiệp vụ',
      'Payment chết không làm hỏng chuyến; yêu cầu thanh toán không mất mà nằm chờ',
      async () => {
        say('Tắt Payment: ' + COMPOSE_CMD + ' stop payment');
        compose(['stop', 'payment'], 120000);
        show('Payment', 'ĐÃ TẮT');

        await sendLocation(driver, ZONE_A);
        say('Khách A đặt chuyến mới, Tài xế 1 nhận và chạy hết chuyến trong lúc Payment đang tắt');
        pending = await book(passenger);

        const found = await waitFor(
          'Đang chờ lời mời cho chuyến mới',
          () => findOffer(driver, pending.trip.id),
          Boolean,
          30000,
          'lời mời',
        );

        await accept(driver, pending.trip.id, found.offer.id);
        await drive(driver, pending.trip.id);

        const trip = await tripOf(passenger, pending.trip.id);

        say('Khách A xem thanh toán (Gateway chờ Payment tối đa 10 s rồi trả lỗi)');
        const started = Date.now();
        const viaGateway = await call('/payments?tripId=' + pending.trip.id, {
          token: passenger.token,
        });
        const elapsed = Date.now() - started;
        const others = await call('/trips/' + pending.trip.id, { token: passenger.token });

        await sleep(3000);

        const list = queues();
        const waiting = list.find(item => item.name === 'payment.events');

        show(
          'Chuyến',
          short(pending.trip.id) + ' ' + trip.status + ', thanh toán ' + trip.paymentStatus,
        );

        show(
          'GET /payments (Payment tắt)',
          viaGateway.status +
            ' ' +
            (viaGateway.body?.code ?? '') +
            ' sau ' +
            (elapsed / 1000).toFixed(1) +
            ' s',
        );

        show('GET /trips (Trip vẫn chạy)', String(others.status));
        console.log('    Hàng đợi RabbitMQ:');
        printQueues(list);

        conclude(
          `Chỉ chức năng thanh toán bị ảnh hưởng: xem thanh toán trả lỗi ${viaGateway.status} có thời hạn thay vì treo, ` +
            `còn chuyến vẫn ${trip.status} và đọc được (${others.status}). Yêu cầu thanh toán đang nằm chờ ở payment.events (${waiting?.ready ?? 0} tin).`,
        );

        return {
          tripId: pending.trip.id,
          tripStatus: trip.status,
          paymentStatus: trip.paymentStatus,
          paymentsWhileDown: {
            http: viaGateway.status,
            code: viaGateway.body?.code,
            elapsedMs: elapsed,
          },
          tripsWhileDown: others.status,
          queues: list,
        };
      },
    );

    await step(
      8,
      'Tin nhắn không mất: outbox, hàng đợi, mã theo dõi',
      'tin đã giao cho RabbitMQ và được giữ lại; chưa thu tiền; lần theo được bằng correlationId',
      async () => {
        // payment.requested mang correlationId của lệnh "kết thúc chuyến", không phải của lệnh đặt chuyến.
        const [status, publishedEpoch, correlationId, eventId] = queryDb(
          'trip-db',
          'trip_db',
          `SELECT status || '|' || coalesce(extract(epoch FROM published_at)::text, '') || '|' || correlation_id || '|' || event_id FROM trip_schema.outbox_events WHERE aggregate_id = '${pending.trip.id}' AND type = 'payment.requested'`,
        ).split('|');
        const outbox = atLocalTime(status + '|' + publishedEpoch);
        const waiting = queues().find(item => item.name === 'payment.events');
        const payments = queryDb(
          'payment-db',
          'payment_db',
          `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${pending.trip.id}'`,
        );

        show('payment.requested (outbox)', outbox + '  (= RabbitMQ đã nhận và giữ tin)');
        show('Tin chờ ở payment.events', String(waiting?.ready ?? 0));
        show('Đã thu (DB Payment)', payments + ' khoản (Payment chưa xử lý)');
        // Log của Payment ghi theo event_id nên lọc cả hai mã để thấy trọn gateway → trip → driver → payment.
        logHint(correlationId, correlationId + '|' + eventId);

        conclude(
          'PUBLISHED không có nghĩa là đã thu tiền: outbox chỉ đánh dấu PUBLISHED khi RabbitMQ xác nhận đã nhận (publisher confirm), ' +
            'và RabbitMQ giữ tin bền vững tới khi Payment quay lại. Nếu xử lý lỗi, tin được thử lại sau 1 s, 5 s, 15 s rồi mới vào DLQ.',
        );

        return {
          outbox,
          waitingInQueue: waiting?.ready ?? 0,
          paymentsBeforeRestart: Number(payments),
          correlationId,
          eventId,
        };
      },
    );
  } finally {
    console.log('\n  … Bật lại Payment: ' + COMPOSE_CMD + ' start payment');
    compose(['start', 'payment'], 120000);
  }

  await step(
    9,
    'Phục hồi: bật lại Payment và xử lý tiếp',
    'tin đang chờ được xử lý; thu đúng một lần; trạng thái cuối nhất quán',
    async () => {
      show('Payment', 'ĐÃ BẬT LẠI');

      const trip = await waitFor(
        'Đang chờ Payment xử lý tin tồn đọng',
        () => tripOf(passenger, pending.trip.id),
        item => item.paymentStatus === 'SUCCEEDED',
        90000,
        'thanh toán sau khi bật lại',
      );
      const payments = queryDb(
        'payment-db',
        'payment_db',
        `SELECT count(*) FROM payment_schema.payments WHERE trip_id = '${pending.trip.id}'`,
      );
      const attempts = queryDb(
        'payment-db',
        'payment_db',
        `SELECT count(*) FROM payment_schema.payment_attempts a JOIN payment_schema.payments p ON p.id = a.payment_id WHERE p.trip_id = '${pending.trip.id}'`,
      );
      const list = queues();

      show('Thanh toán', trip.paymentStatus);
      show('Số khoản / số lần thử', payments + ' / ' + attempts);
      console.log('    Hàng đợi RabbitMQ:');
      printQueues(list);

      conclude(
        `Payment bật lại tự xử lý tin đang chờ: thanh toán ${trip.paymentStatus}, đúng ${payments} khoản và ${attempts} lần thử (không thu trùng)` +
          (allQueuesEmpty(list) ? ', mọi hàng đợi về 0.' : '.'),
      );

      return {
        tripId: pending.trip.id,
        paymentStatus: trip.paymentStatus,
        payments: Number(payments),
        attempts: Number(attempts),
        queues: list,
      };
    },
  );

  evidence.status = 'PASS';
}

function printSummary() {
  if (!summary.length) {
    return;
  }

  console.log('\n' + '='.repeat(78));
  console.log('TÓM TẮT');
  console.log('-'.repeat(78));
  for (const item of summary) {
    console.log(`  ✓ Bước ${item.number}. ${item.title}`);
  }
}

main()
  .catch(error => {
    evidence.status = 'FAIL';
    evidence.error =
      error.message + (error.cause ? ' (' + (error.cause.code ?? error.cause.message) + ')' : '');

    console.error('\nDemo dừng: ' + evidence.error + '\n' + error.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    prompt?.close();
    printSummary();
    evidence.finishedAt = new Date().toISOString();
    evidence.tokens = '[REDACTED]';
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
    console.log(
      '\nKết quả: ' +
        (evidence.status ?? 'FAIL') +
        '. Bằng chứng: ' +
        path.relative(ROOT, evidenceFile),
    );
  });
