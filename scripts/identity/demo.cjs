const { randomUUID } = require('node:crypto');

require('dotenv').config({ quiet: true });

async function main() {
  const base =
    process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:' + (process.env.GATEWAY_PORT ?? '8081');

  for (const role of ['PASSENGER', 'DRIVER']) {
    const suffix = randomUUID();
    const email = role.toLowerCase() + '-' + suffix + '@example.test';
    const password = 'Demo!' + randomUUID();
    const correlationId = randomUUID();
    const headers = { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId };
    const registered = await fetch(base + '/api/v1/auth/register', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password, displayName: role + ' demo', role }),
    });

    if (registered.status !== 201) {
      throw new Error('Register failed: ' + registered.status);
    }

    const user = await registered.json();
    const response = await fetch(base + '/api/v1/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    });

    if (response.status !== 200) {
      throw new Error('Login failed: ' + response.status);
    }

    const login = await response.json();
    const me = await fetch(base + '/api/v1/users/me', {
      headers: { ...headers, Authorization: 'Bearer ' + login.accessToken },
    });

    if (me.status !== 200 || (await me.json()).id !== user.id) {
      throw new Error('/users/me did not match registered user');
    }

    console.log(
      JSON.stringify({
        role,
        userId: user.id,
        correlationId,
        register: 201,
        login: 200,
        me: 200,
        token: '[REDACTED]',
      }),
    );

    if (role === 'DRIVER') {
      const driverBase =
        process.env.DEMO_DRIVER_BASE_URL ??
        'http://127.0.0.1:' + (process.env.DRIVER_PORT ?? '3002');
      const verified = await fetch(driverBase + '/api/v1/drivers/me', {
        headers: { Authorization: 'Bearer ' + login.accessToken },
      });
      const result = await verified.json();

      if (verified.status !== 404 || result.code !== 'DRIVER_NOT_ONBOARDED') {
        throw new Error('Driver did not verify the real Identity token');
      }

      console.log('Driver verified DRIVER token; profile onboarding remains owned by B.');
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
