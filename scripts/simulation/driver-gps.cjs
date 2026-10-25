const { setTimeout: sleep } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');

require('dotenv').config({ quiet: true });

async function main() {
  const email = process.env.DRIVER_DEMO_EMAIL;
  const password = process.env.DRIVER_DEMO_PASSWORD;
  const identityUrl = process.env.IDENTITY_BASE_URL || 'http://127.0.0.1:3001';
  const driverUrl = process.env.DRIVER_BASE_URL || 'http://127.0.0.1:3002';
  const once = process.argv.includes('--once');
  const controller = new AbortController();

  if (!email || !password) {
    throw new Error('Set DRIVER_DEMO_EMAIL and DRIVER_DEMO_PASSWORD before running this script');
  }

  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  async function request(origin, path, method = 'GET', body, token, key) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    });

    return { status: response.status, body: await response.json() };
  }

  function expect(result, status) {
    if (result.status !== status) {
      throw new Error('HTTP ' + result.status + ': ' + (result.body.code || 'REQUEST_FAILED'));
    }

    return result.body;
  }

  // Tài khoản/mã tài xế luôn do Identity thật tạo, không chèn dữ liệu trực tiếp vào DB.
  const signup = await request(identityUrl, '/api/v1/auth/register', 'POST', {
    email,
    password,
    displayName: 'Driver demo',
    role: 'DRIVER',
  });

  if (signup.status !== 201 && !(signup.status === 409 && signup.body.code === 'EMAIL_EXISTS')) {
    expect(signup, 201);
  }

  const login = expect(
    await request(identityUrl, '/api/v1/auth/login', 'POST', { email, password }),
    200,
  );
  const token = login.accessToken;
  const driverId = login.user.id;

  if (login.user.role !== 'DRIVER') {
    throw new Error('The demo account must have the DRIVER role');
  }

  const current = await request(driverUrl, '/api/v1/drivers/me', 'GET', undefined, token);

  if (current.status === 404 && current.body.code === 'DRIVER_NOT_ONBOARDED') {
    expect(
      await request(
        driverUrl,
        '/api/v1/drivers/me',
        'PUT',
        { licenseNumber: 'DEMO-' + driverId.slice(0, 8) },
        token,
      ),
      200,
    );
  } else {
    expect(current, 200);
  }

  const vehicle = await request(driverUrl, '/api/v1/vehicles/me', 'GET', undefined, token);

  if (vehicle.status === 404) {
    expect(
      await request(
        driverUrl,
        '/api/v1/vehicles',
        'POST',
        {
          plateNumber: 'DEMO-' + driverId.replaceAll('-', '').slice(0, 12),
          model: 'Demo sedan',
          color: 'White',
        },
        token,
        randomUUID(),
      ),
      201,
    );
  } else {
    expect(vehicle, 200);
  }

  do {
    // Đọc sequence mỗi lần, nên restart simulator không quay lại sequence=1.
    let profile = expect(
      await request(driverUrl, '/api/v1/drivers/me', 'GET', undefined, token),
      200,
    );
    const location = expect(
      await request(
        driverUrl,
        '/api/v1/drivers/me/location',
        'PUT',
        {
          position: {
            lat: Number(process.env.DRIVER_DEMO_LAT || '10.77'),
            lng: Number(process.env.DRIVER_DEMO_LNG || '106.69'),
            zoneId: process.env.DRIVER_DEMO_ZONE || 'ZONE_A',
          },
          sequence: profile.locationSequence + 1,
          recordedAt: new Date().toISOString(),
        },
        token,
      ),
      200,
    );

    if (!profile.online) {
      profile = expect(
        await request(driverUrl, '/api/v1/drivers/me', 'GET', undefined, token),
        200,
      );

      expect(
        await request(
          driverUrl,
          '/api/v1/drivers/me/status',
          'PATCH',
          {
            online: true,
            expectedVersion: profile.version,
          },
          token,
          randomUUID(),
        ),
        200,
      );
    }

    console.log('Driver ' + driverId + ': GPS sequence=' + location.sequence);

    if (!once) {
      await sleep(5000, undefined, { signal: controller.signal });
    }
  } while (!once && !controller.signal.aborted);
}

main().catch(error => {
  if (error.name === 'AbortError') {
    return;
  }

  console.error(error.message);
  process.exitCode = 1;
});
