// P01 — test tải (BA mục 12.1 test 15, chỉ tiêu mục 10.2) chạy trên stack Compose thật qua Gateway:
// nạp 20 tài xế tự nhận chuyến; 10, 25, 50 client báo giá + đặt chuyến + đọc chuyến, mỗi mức 60 giây.
// Đo request/giây, thời gian ở mốc 50/95/99%, tỉ lệ lỗi; đo riêng thời gian nghiệp vụ (ghép, hoàn thành, thanh toán)
// từ DB vì trả 201/202 nhanh không chứng minh quy trình xong. "Không có tài xế" là kết quả hợp lệ, không tính là lỗi.
// Sau mỗi mức chờ mọi chuyến về trạng thái cuối rồi kiểm tra ràng buộc trong DB của từng service.
//
// Cấu hình qua env: P01_LEVELS=10,25,50  P01_DURATION_SECONDS=60  P01_DRIVERS=20  P01_PASSENGERS=10  P01_SETTLE_SECONDS=180
// Gateway được tạm tắt giới hạn request (một máy gửi hết tải) rồi bật lại khi xong.
const assert = require('node:assert/strict');
const { execFile, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { promisify } = require('node:util');
const { test } = require('node:test');
const {
  GATEWAY,
  ROOT,
  account,
  bringOnline,
  call,
  compose,
  findNotification,
  finishedOperation,
  queryDb,
  sendLocation,
  setOnline,
} = require('../helpers/e2e-client.cjs');

const execFileAsync = promisify(execFile);

const LEVELS = (process.env.P01_LEVELS ?? '10,25,50').split(',').map(Number);
const DURATION_MS = Number(process.env.P01_DURATION_SECONDS ?? 60) * 1000;
const DRIVERS = Number(process.env.P01_DRIVERS ?? 20);
const PASSENGERS = Number(process.env.P01_PASSENGERS ?? 10);
const SETTLE_MS = Number(process.env.P01_SETTLE_SECONDS ?? 180) * 1000;
const TARGET_P95_MS = 1000;
const PICKUP = { lat: 10.77, lng: 106.69, zoneId: 'ZONE_A' };
const DROPOFF = { lat: 10.78, lng: 106.7, zoneId: 'ZONE_A' };
const ACTIVE_TRIP = ['MATCHING', 'ASSIGNING', 'ASSIGNED', 'IN_PROGRESS', 'CANCELLING'];
// P01_MODE=flood: client đặt liên tục, không chờ chuyến xong (đo giới hạn của Ghép chuyến); ghi ra p01-flood.json.
const FLOOD = process.env.P01_MODE === 'flood';
const evidenceFile = path.join(ROOT, 'docs/test-evidence/performance/' + (FLOOD ? 'p01-flood.json' : 'p01-load.json'));

/** Mốc phần trăm theo nearest-rank: phần tử thứ ceil(p/100 * n) của dãy đã sắp xếp. */
function percentile(sorted, p) {
  return sorted.length ? Math.round(sorted[Math.ceil((p / 100) * sorted.length) - 1]) : null;
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);

  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
  };
}

function rows(service, database, sql) {
  const out = queryDb(service, database, sql);

  return out ? out.split('\n').map(line => line.split('|')) : [];
}

const scalar = (service, database, sql) => Number(queryDb(service, database, sql));
const inList = ids => "'" + ids.join("','") + "'";

/** Một request có đo thời gian; lỗi mạng hoặc quá 15 giây ghi status 0. */
async function timed(samples, name, route, options) {
  const started = performance.now();
  let result;

  try {
    result = await call(route, options);
  } catch {
    result = { status: 0 };
  }

  samples.push({ name, ms: performance.now() - started, status: result.status });

  return result;
}

async function client(passenger, until, samples, booked) {
  while (Date.now() < until) {
    const quote = await timed(samples, 'quote', '/quotes', {
      method: 'POST',
      token: passenger.token,
      key: randomUUID(),
      body: { pickup: PICKUP, dropoff: DROPOFF, distanceMeters: 3000, durationSeconds: 600 },
    });

    if (quote.status !== 201) {
      await sleep(100);
      continue;
    }

    const trip = await timed(samples, 'book', '/trips', {
      method: 'POST',
      token: passenger.token,
      key: randomUUID(),
      body: { quoteId: quote.body.id },
    });

    if (trip.status !== 201) {
      await sleep(100);
      continue;
    }

    booked.push(trip.body.id);

    // Khách thật chờ chuyến của mình xong (hỏi mỗi giây như polling của app) rồi mới đặt chuyến mới.
    while (Date.now() < until) {
      if (FLOOD) {
        await timed(samples, 'read', '/trips/' + trip.body.id, { token: passenger.token });
        break;
      }

      const read = await timed(samples, 'read', '/trips/' + trip.body.id, { token: passenger.token });

      if (read.status === 200 && finished(read.body)) {
        break;
      }

      await sleep(1000);
    }
  }
}

const finished = trip =>
  ['NO_DRIVER', 'CANCELLED'].includes(trip.status) ||
  (trip.status === 'COMPLETED' && ['SUCCEEDED', 'FAILED'].includes(trip.paymentStatus));

/** Tài xế mô phỏng: gửi GPS 5 giây/lần; hỏi lời mời mỗi giây, nhận rồi chạy hết chuyến để được mời tiếp. */
function startDriver(driver, stats) {
  let running = true;
  const tried = new Set();
  const gps = (async () => {
    while (running) {
      try {
        await sendLocation(driver, PICKUP);
      } catch {
        stats.gpsErrors += 1;
      }

      await sleep(5000);
    }
  })();
  const work = (async () => {
    while (running) {
      try {
        const offer = await findNotification(
          driver,
          item => item.type === 'OFFER' && item.actionable && !tried.has(item.offer.id),
        );

        if (!offer) {
          await sleep(1000);
          continue;
        }

        tried.add(offer.offer.id);

        const accepted = await call('/trips/' + offer.tripId + '/accept', {
          method: 'POST',
          token: driver.token,
          key: randomUUID(),
          body: { offerId: offer.offer.id },
        });

        // Lời mời vừa hết hạn hoặc chuyến đã đổi trạng thái: hợp lệ, chờ lời mời sau.
        if (accepted.status !== 202 || (await finishedOperation(driver, accepted.body.id)).status !== 'SUCCEEDED') {
          stats.acceptRefused += 1;
          continue;
        }

        const command = action =>
          call('/trips/' + offer.tripId + '/' + action, {
            method: 'POST',
            token: driver.token,
            key: randomUUID(),
            body: {},
          });

        assert.equal((await command('start')).status, 200);

        const completing = await command('complete');

        assert.equal(completing.status, 202);
        await finishedOperation(driver, completing.body.id);
        stats.completed += 1;
      } catch (error) {
        stats.errors += 1;
        stats.lastError = error.message;
        await sleep(1000);
      }
    }
  })();

  return async () => {
    running = false;
    await Promise.all([gps, work]);
  };
}

function parseMiB(text) {
  const match = /([\d.]+)\s*([KMG]i?B)/.exec(text);

  if (!match) {
    return 0;
  }

  return Number(match[1]) * { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[match[2]];
}

/** Lấy CPU/RAM các container của stack mỗi 5 giây (bất đồng bộ, không chặn client). */
function sampleResources(samples) {
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const { stdout } = await execFileAsync('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
          timeout: 20000,
        });
        const at = Date.now();

        for (const line of stdout.trim().split('\n')) {
          const item = JSON.parse(line);

          if (item.Name.startsWith('ds03-')) {
            samples.push({ at, name: item.Name, cpu: parseFloat(item.CPUPerc), memMiB: parseMiB(item.MemUsage) });
          }
        }
      } catch {
        // docker stats chậm khi máy quá tải: bỏ mẫu đó.
      }

      await sleep(5000);
    }
  })();

  return async () => {
    running = false;
    await loop;
  };
}

function summarizeResources(samples) {
  const byContainer = {};
  const totals = {};

  for (const item of samples) {
    const entry = (byContainer[item.name.replace(/^ds03-|-1$/g, '')] ??= { peakCpuPercent: 0, peakMemMiB: 0 });

    entry.peakCpuPercent = Math.max(entry.peakCpuPercent, item.cpu);
    entry.peakMemMiB = Math.max(entry.peakMemMiB, Math.round(item.memMiB));
    totals[item.at] = (totals[item.at] ?? 0) + item.memMiB;
  }

  return {
    samples: Object.keys(totals).length,
    peakTotalMemMiB: Math.round(Math.max(0, ...Object.values(totals))),
    byContainer,
  };
}

function summarizeRequests(samples, durationMs) {
  const result = {};

  for (const name of ['quote', 'book', 'read', 'all']) {
    const items = name === 'all' ? samples : samples.filter(item => item.name === name);
    const errors = {
      rateLimited: items.filter(item => item.status === 429).length,
      clientErrors: items.filter(item => item.status >= 400 && item.status < 500 && item.status !== 429).length,
      serverErrors: items.filter(item => item.status >= 500).length,
      networkOrTimeout: items.filter(item => item.status === 0).length,
    };
    const systemErrors = errors.serverErrors + errors.networkOrTimeout;

    result[name] = {
      requests: items.length,
      perSecond: Number((items.length / (durationMs / 1000)).toFixed(1)),
      latencyMs: distribution(items.map(item => item.ms)),
      errors,
      systemErrorRate: items.length ? Number((systemErrors / items.length).toFixed(4)) : 0,
    };
  }

  return result;
}

function tripWindow(passengerIds, startedAt, endedAt) {
  // Đồng hồ máy và container có thể lệch vài giây; các mức cách nhau ít nhất một lần chờ ổn định nên lề 10 giây an toàn.
  return (
    `t.passenger_id IN (${inList(passengerIds)}) AND t.created_at >= to_timestamp(${(startedAt - 10000) / 1000}) ` +
    `AND t.created_at < to_timestamp(${(endedAt + 10000) / 1000})`
  );
}

/** Chờ mọi chuyến của mức này về trạng thái cuối và thanh toán có kết quả. */
async function settle(where) {
  const started = Date.now();
  const pending = () =>
    scalar(
      'trip-db',
      'trip_db',
      `SELECT count(*) FROM trip_schema.trips t WHERE ${where} AND (t.status IN (${inList(ACTIVE_TRIP)}) ` +
        `OR (t.status = 'COMPLETED' AND t.payment_status NOT IN ('SUCCEEDED', 'FAILED')))`,
    );
  let left = pending();

  while (left > 0 && Date.now() - started < SETTLE_MS) {
    await sleep(3000);
    left = pending();
  }

  return { settleMs: Date.now() - started, unsettledTrips: left };
}

function businessTimings(where) {
  const sinceCreated = status =>
    rows(
      'trip-db',
      'trip_db',
      `SELECT extract(epoch FROM (min(h.occurred_at) - t.created_at)) * 1000 FROM trip_schema.trips t ` +
        `JOIN trip_schema.state_history h ON h.trip_id = t.id AND h.to_status = '${status}' WHERE ${where} GROUP BY t.id`,
    ).map(([ms]) => Number(ms));
  const byStatus = Object.fromEntries(
    rows('trip-db', 'trip_db', `SELECT t.status, count(*) FROM trip_schema.trips t WHERE ${where} GROUP BY t.status`).map(
      ([status, count]) => [status, Number(count)],
    ),
  );
  const paymentLag = rows(
    'trip-db',
    'trip_db',
    `SELECT extract(epoch FROM (t.updated_at - h.occurred_at)) * 1000 FROM trip_schema.trips t ` +
      `JOIN trip_schema.state_history h ON h.trip_id = t.id AND h.to_status = 'COMPLETED' ` +
      `WHERE ${where} AND t.payment_status = 'SUCCEEDED'`,
  ).map(([ms]) => Number(ms));

  return {
    tripsByStatus: byStatus,
    timeToAssignedMs: distribution(sinceCreated('ASSIGNED')),
    timeToNoDriverMs: distribution(sinceCreated('NO_DRIVER')),
    timeToCompletedMs: distribution(sinceCreated('COMPLETED')),
    completedToPaymentRecordedMs: distribution(paymentLag),
  };
}

/** Ràng buộc nghiệp vụ sau tải, đọc trên DB của đúng service (BA mục 10.2 "Đúng đắn", 12.2). */
function constraints(passengerIds, driverIds) {
  return {
    driversWithTwoActiveTrips: scalar(
      'trip-db',
      'trip_db',
      "SELECT count(*) FROM (SELECT driver_id FROM trip_schema.trips WHERE status IN ('ASSIGNED', 'IN_PROGRESS') " +
        'GROUP BY driver_id HAVING count(*) > 1) x',
    ),
    driversWithTwoActiveReservations: scalar(
      'driver-db',
      'driver_db',
      "SELECT count(*) FROM (SELECT driver_id FROM driver_schema.reservations WHERE status IN ('HELD', 'CONFIRMED') " +
        'GROUP BY driver_id HAVING count(*) > 1) x',
    ),
    activeReservationsLeft: scalar(
      'driver-db',
      'driver_db',
      `SELECT count(*) FROM driver_schema.reservations WHERE driver_id IN (${inList(driverIds)}) ` +
        "AND status IN ('HELD', 'CONFIRMED')",
    ),
    tripsWithTwoPayments: scalar(
      'payment-db',
      'payment_db',
      'SELECT count(*) FROM (SELECT trip_id FROM payment_schema.payments GROUP BY trip_id HAVING count(*) > 1) x',
    ),
    paymentsOverThreeAttempts: scalar(
      'payment-db',
      'payment_db',
      'SELECT count(*) FROM (SELECT payment_id FROM payment_schema.payment_attempts GROUP BY payment_id HAVING count(*) > 3) x',
    ),
    completedTrips: scalar(
      'trip-db',
      'trip_db',
      `SELECT count(*) FROM trip_schema.trips WHERE passenger_id IN (${inList(passengerIds)}) AND status = 'COMPLETED'`,
    ),
    payments: scalar(
      'payment-db',
      'payment_db',
      `SELECT count(*) FROM payment_schema.payments WHERE passenger_id IN (${inList(passengerIds)})`,
    ),
    paymentsForNonCompletedTrips: scalar(
      'trip-db',
      'trip_db',
      `SELECT count(*) FROM trip_schema.trips WHERE passenger_id IN (${inList(passengerIds)}) ` +
        "AND status <> 'COMPLETED' AND payment_status <> 'NOT_REQUESTED'",
    ),
    activeMatchingJobs: scalar(
      'matching-db',
      'matching_db',
      "SELECT count(*) FROM matching_schema.matching_jobs WHERE status IN ('SEARCHING', 'OFFERING', 'CLAIMED')",
    ),
    claimedOffersLeft: scalar(
      'matching-db',
      'matching_db',
      "SELECT count(*) FROM matching_schema.offers WHERE status = 'CLAIMED'",
    ),
    stateTransitions: rows(
      'trip-db',
      'trip_db',
      `SELECT coalesce(h.from_status, '-') || '->' || h.to_status, count(*) FROM trip_schema.state_history h ` +
        `JOIN trip_schema.trips t ON t.id = h.trip_id WHERE t.passenger_id IN (${inList(passengerIds)}) GROUP BY 1 ORDER BY 1`,
    ).map(([transition, count]) => ({ transition, count: Number(count) })),
  };
}

function machine() {
  const text = (command, args) => spawnSync(command, args, { encoding: 'utf8' }).stdout?.trim() ?? '';
  const [dockerCpus, dockerMem] = text('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}']).split(' ');
  let images = [];

  try {
    const raw = compose(['images', '--format', 'json']);
    const parsed = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').map(line => JSON.parse(line));

    images = parsed.map(item => ({ container: item.ContainerName, image: item.Repository + ':' + item.Tag, id: item.ID }));
  } catch {
    // Không đọc được danh sách image thì vẫn ghi phần còn lại.
  }

  return {
    os: os.type() + ' ' + os.release() + ' (' + os.platform() + ')',
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    node: process.version,
    docker: text('docker', ['version', '--format', '{{.Server.Version}}']),
    dockerVmCpus: Number(dockerCpus),
    dockerVmMemGiB: Number((Number(dockerMem) / 1024 ** 3).toFixed(1)),
    images,
  };
}

function setGatewayLimits(disabled) {
  for (const name of ['GATEWAY_RATE_LIMIT_PER_MINUTE', 'GATEWAY_AUTH_RATE_LIMIT']) {
    if (disabled) {
      process.env[name] = '0';
    } else {
      delete process.env[name];
    }
  }

  compose(['up', '-d', '--no-deps', '--wait', 'gateway'], 180000);
}

test('P01: quote and booking under 10, 25 and 50 clients', { timeout: 60 * 60 * 1000 }, async t => {
  const evidence = {
    test: FLOOD ? 'P01-flood' : 'P01',
    mode: FLOOD ? 'flood: mỗi client lặp POST /quotes → POST /trips → GET /trips/{id} không nghỉ, không chờ chuyến xong' : 'khách chờ chuyến của mình xong rồi mới đặt chuyến mới',
    requirement: 'BA mục 12.1 test 15 (tải) và mục 10.2: 95% request đọc, báo giá, đặt chuyến dưới 1 giây; không giữ một tài xế cho hai chuyến; không chuyến nào có hơn một khoản thanh toán',
    setup: `Stack Compose đầy đủ trên một máy; ${DRIVERS} tài xế mô phỏng ở ZONE_A (GPS 5 giây/lần, hỏi lời mời mỗi giây, nhận rồi chạy hết chuyến); ${PASSENGERS} tài khoản khách dùng chung cho các client; Gateway tạm tắt giới hạn request`,
    steps: `Mỗi mức ${LEVELS.join(', ')} client chạy ${DURATION_MS / 1000} giây; mỗi client là một khách lặp: POST /quotes → POST /trips → GET /trips/{id} mỗi giây tới khi chuyến xong (NO_DRIVER, hoặc COMPLETED và có kết quả thanh toán) rồi đặt chuyến mới. Sau mỗi mức chờ mọi chuyến về trạng thái cuối (tối đa ${SETTLE_MS / 1000} giây) rồi đọc DB`,
    method: 'Thời gian request đo ở client từ lúc gửi tới lúc đọc xong body, tính trên mọi request kể cả lỗi; mốc phần trăm theo nearest-rank. Lỗi hệ thống = HTTP 5xx, lỗi mạng hoặc quá 15 giây. NO_DRIVER là kết quả hợp lệ. Thời gian nghiệp vụ lấy từ trip_schema.state_history so với created_at của chuyến',
    gateway: GATEWAY,
    machine: machine(),
    levels: [],
    constraints: undefined,
    executedAt: new Date().toISOString(),
    status: 'FAIL',
    error: undefined,
    commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown',
    tokens: '[REDACTED]',
  };

  t.after(() => {
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  });

  const health = await fetch(GATEWAY + '/health/ready', { signal: AbortSignal.timeout(5000) }).catch(() => undefined);

  assert.equal(health?.status, 200, 'Gateway ' + GATEWAY + ' is not ready; run npm run stack:up first');
  setGatewayLimits(true);

  const driverStats = { completed: 0, acceptRefused: 0, gpsErrors: 0, errors: 0, lastError: undefined };
  const stopDrivers = [];
  const drivers = [];

  try {
    // Tài khoản bị Identity giới hạn 10 đăng ký + 10 đăng nhập mỗi phút: tạo lần lượt, account() tự chờ khi gặp 429.
    console.log('Creating ' + PASSENGERS + ' passengers and ' + DRIVERS + ' drivers (about 1 minute per 10 accounts)');

    const passengers = [];

    for (let i = 0; i < PASSENGERS; i += 1) {
      passengers.push(await account('PASSENGER'));
    }

    for (let i = 0; i < DRIVERS; i += 1) {
      const driver = await account('DRIVER');

      await bringOnline(driver, PICKUP);
      drivers.push(driver);
      stopDrivers.push(startDriver(driver, driverStats));
    }

    const passengerIds = passengers.map(item => item.id);

    for (const clients of LEVELS) {
      console.log('Level ' + clients + ' clients for ' + DURATION_MS / 1000 + ' s');

      const samples = [];
      const booked = [];
      const resources = [];
      const stopSampling = sampleResources(resources);
      const completedBefore = driverStats.completed;
      const startedAt = Date.now();
      const until = startedAt + DURATION_MS;

      await Promise.all(
        Array.from({ length: clients }, (_, index) => client(passengers[index % passengers.length], until, samples, booked)),
      );

      const endedAt = Date.now();

      await stopSampling();

      const where = tripWindow(passengerIds, startedAt, endedAt);
      const settled = await settle(where);
      const business = businessTimings(where);
      const dbTrips = Object.values(business.tripsByStatus).reduce((sum, count) => sum + count, 0);
      const requests = summarizeRequests(samples, endedAt - startedAt);

      evidence.levels.push({
        clients,
        durationMs: endedAt - startedAt,
        requests,
        p95UnderTarget: requests.all.latencyMs.p95 !== null && requests.all.latencyMs.p95 < TARGET_P95_MS,
        bookedTrips: booked.length,
        tripsInDb: dbTrips,
        ...settled,
        ...business,
        tripsCompletedByDrivers: driverStats.completed - completedBefore,
        resources: summarizeResources(resources),
      });

      console.log(
        'Level ' + clients + ': ' + requests.all.perSecond + ' req/s, p95 ' + requests.all.latencyMs.p95 + ' ms, system errors ' +
          (requests.all.errors.serverErrors + requests.all.errors.networkOrTimeout) + ', trips ' + JSON.stringify(business.tripsByStatus),
      );

      // Mỗi 201 ứng với đúng một chuyến trong DB, không mất và không tạo thừa.
      assert.equal(dbTrips, booked.length, 'trips in DB differ from 201 responses at level ' + clients);
    }

    for (const stop of stopDrivers.splice(0)) {
      await stop();
    }

    evidence.driverBots = driverStats;
    evidence.constraints = constraints(passengerIds, drivers.map(item => item.id));

    const c = evidence.constraints;

    assert.equal(c.driversWithTwoActiveTrips, 0);
    assert.equal(c.driversWithTwoActiveReservations, 0);
    assert.equal(c.activeReservationsLeft, 0);
    assert.equal(c.tripsWithTwoPayments, 0);
    assert.equal(c.paymentsOverThreeAttempts, 0);
    assert.equal(c.paymentsForNonCompletedTrips, 0);
    assert.equal(c.payments, c.completedTrips, 'every completed trip has exactly one payment');
    // Chuyến còn chạy sau thời gian chờ là việc bị kẹt/tồn đọng, không phải kết quả hợp lệ.
    assert.deepEqual(
      evidence.levels.map(level => level.unsettledTrips),
      evidence.levels.map(() => 0),
      'trips still not finished ' + SETTLE_MS / 1000 + ' s after each level',
    );

    evidence.status = 'PASS';
  } catch (error) {
    evidence.error = error.message;
    throw error;
  } finally {
    for (const stop of stopDrivers) {
      await stop().catch(() => undefined);
    }

    for (const driver of drivers) {
      await setOnline(driver, false).catch(() => undefined);
    }

    setGatewayLimits(false);
  }
});
