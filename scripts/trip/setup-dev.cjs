
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const root = path.resolve(__dirname, '../..');

const services = {
  trip: { container: 'trip-db', database: 'trip_db', port: 5543, prefix: 'TRIP' },
};

const envFile = path.join(root, '.env');

if (!fs.existsSync(envFile)) {
  console.error('.env not found; run npm run identity:setup:dev first, then run this again.');
  process.exitCode = 1;
} else {
  const original = fs.readFileSync(envFile, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const current = new Map();

  for (const line of lines) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);

    if (match) {
      current.set(match[1], match[2]);
    }
  }

  const appended = [];
  const replaced = new Set();

  for (const [name, service] of Object.entries(services)) {
    const p = service.prefix;
    const localUrl = '@127.0.0.1:' + service.port + '/' + service.database;
    const ready =
      (current.get(p + '_DATABASE_URL') ?? '').endsWith(localUrl) &&
      ['_BOOTSTRAP_PASSWORD', '_APP_PASSWORD', '_MIGRATOR_PASSWORD'].every(s => current.get(p + s));

    if (ready) {
      continue;
    }

    const bootstrap = randomBytes(24).toString('hex');
    const app = randomBytes(24).toString('hex');
    const migrator = randomBytes(24).toString('hex');
    const wanted = [
      [p + '_DB_SCHEMA', name + '_schema'],
      [p + '_BOOTSTRAP_PASSWORD', bootstrap],
      [p + '_APP_PASSWORD', app],
      [p + '_MIGRATOR_PASSWORD', migrator],
      [p + '_DATABASE_URL', 'postgresql://' + name + '_app:' + app + localUrl],
      [p + '_MIGRATION_DATABASE_URL', 'postgresql://' + name + '_migrator:' + migrator + localUrl],
    ];

    appended.push(
      '',
      '# ' +
        name +
        ': DB riêng ' +
        service.container +
        ' (deploy/trip-dev.compose.yml), tạo bởi npm run trip:setup:dev',
    );

    for (const [key, value] of wanted) {
      if (current.get(key) === value) {
        continue;
      }

      if (current.has(key)) {
        replaced.add(key);
      }

      appended.push(key + '=' + value);
    }
  }

  if (!appended.length) {
    console.log('Trip database variables already point to the local Docker DB.');
  } else {
    const output = lines.map(line => {
      const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];

      return key && replaced.has(key) ? '# cũ: ' + line : line;
    });

    while (output.length && output[output.length - 1] === '') {
      output.pop();
    }

    fs.writeFileSync(envFile, [...output, ...appended, ''].join(eol));
    console.log(
      'Updated .env for Trip (trip-db :5543). ' +
        (replaced.size ? replaced.size + ' old lines kept as comments. ' : '') +
        'No secrets printed.',
    );
  }
}
