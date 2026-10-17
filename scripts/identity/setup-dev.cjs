const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { generateKeys } = require('./generate-keys.cjs');
const root = path.resolve(__dirname, '../..');
const envFile = path.join(root, '.env');

if (fs.existsSync(envFile)) {
  console.error(
    '.env already exists; setup will not overwrite it. See .env.example and docs/identity.md.',
  );

  process.exitCode = 1;
} else {
  const bootstrap = randomBytes(24).toString('hex');
  const application = randomBytes(24).toString('hex');
  const migration = randomBytes(24).toString('hex');
  const keyDir = path.join(root, 'deploy/secrets');
  const privateFile = path.join(keyDir, 'identity-private.pem');
  const publicFile = path.join(keyDir, 'identity-public.pem');

  if (!fs.existsSync(privateFile) && !fs.existsSync(publicFile)) {
    generateKeys(keyDir);
  }

  if (!fs.existsSync(privateFile) || !fs.existsSync(publicFile)) {
    throw new Error('Incomplete key pair; repair manually without overwriting existing keys');
  }

  fs.writeFileSync(
    envFile,
    [
      'HOST=127.0.0.1',
      'GATEWAY_PORT=8081',
      'IDENTITY_PORT=3001',
      'DRIVER_PORT=3002',
      'TRIP_PORT=3003',
      'PAYMENT_PORT=3004',
      'NOTIFICATION_PORT=3005',
      'MATCHING_PORT=3006',
      'PRICING_PORT=3007',
      'IDENTITY_BASE_URL=http://127.0.0.1:3001',
      'IDENTITY_DB_SCHEMA=identity_schema',
      'IDENTITY_BOOTSTRAP_PASSWORD=' + bootstrap,
      'IDENTITY_APP_PASSWORD=' + application,
      'IDENTITY_MIGRATOR_PASSWORD=' + migration,
      'IDENTITY_DATABASE_URL=postgresql://identity_app:' +
        application +
        '@127.0.0.1:5541/ride_hailing',
      'IDENTITY_MIGRATION_DATABASE_URL=postgresql://identity_migrator:' +
        migration +
        '@127.0.0.1:5541/ride_hailing',
      'JWT_ISSUER=ride-hailing',
      'JWT_AUDIENCE=ride-api',
      'JWT_ACCESS_TTL_SECONDS=3600',
      'JWT_PUBLIC_KEY_FILE=deploy/secrets/identity-public.pem',
      'JWT_PRIVATE_KEY_FILE=deploy/secrets/identity-private.pem',
      'BCRYPT_ROUNDS=10',
      'IDENTITY_TRUSTED_PROXY_CIDRS=loopback',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );

  console.log(
    'Created ignored .env and RSA key pair. Gateway dev port: 8081; PostgreSQL: 5541. No secrets printed.',
  );
}
