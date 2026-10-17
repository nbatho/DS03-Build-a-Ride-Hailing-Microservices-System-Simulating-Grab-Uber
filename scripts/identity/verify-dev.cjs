const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { start, stop, healthy, root } = require('../../tests/helpers/identity-environment.cjs');

require('dotenv').config({ quiet: true });
(async () => {
  const applications = [];

  try {
    const identityUrl = process.env.IDENTITY_BASE_URL ?? 'http://127.0.0.1:3001';
    const ready = await fetch(identityUrl + '/health/ready');

    assert.equal(ready.status, 200, 'Docker Identity must be ready');
    const gateway = start('api-gateway', { GATEWAY_PORT: process.env.GATEWAY_PORT ?? '8081' });
    const driver = start('driver-vehicle-location-service', {
      DRIVER_PORT: process.env.DRIVER_PORT ?? '3002',
    });

    applications.push(gateway, driver);
    await healthy(gateway, 'http://127.0.0.1:' + (process.env.GATEWAY_PORT ?? '8081'));
    await healthy(driver, 'http://127.0.0.1:' + (process.env.DRIVER_PORT ?? '3002'));
    const result = spawnSync(process.execPath, ['scripts/identity/demo.cjs'], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 60000,
    });

    assert.equal(result.status, 0, 'Dev Gateway/Driver demo failed');
    console.log(result.stdout.trim());
    const directory = path.join(root, 'docs/test-evidence/identity');

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'docker-demo.json'),
      JSON.stringify(
        {
          executedAt: new Date().toISOString(),
          status: 'PASS',
          flow: 'Gateway (host) -> Identity (Docker non-root) -> PostgreSQL dev; Driver (independent host process) verifies real token',
          output: result.stdout.trim().split('\n'),
          token: '[REDACTED]',
          password: '[REDACTED]',
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    for (const app of applications) {
      await stop(app);
    }
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
