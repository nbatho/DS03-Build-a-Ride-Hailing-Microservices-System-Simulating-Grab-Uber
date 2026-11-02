// Ghi biến DB của B vào .env (không in mật khẩu). Chạy lại nhiều lần không đổi gì nếu đã cấu hình.
// Dòng cũ khác giá trị (ví dụ URL Supabase) được giữ lại dạng comment, không bị xóa.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
// Ba DB của B: container, database, cổng trên máy, tiền tố biến môi trường.
const services = {
  driver: { container: 'driver-db', database: 'driver_db', port: 5542, prefix: 'DRIVER' },
  matching: { container: 'matching-db', database: 'matching_db', port: 5546, prefix: 'MATCHING' },
  pricing: { container: 'pricing-db', database: 'pricing_db', port: 5547, prefix: 'PRICING' },
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
  const configured = [];

  for (const [name, service] of Object.entries(services)) {
    const p = service.prefix;
    const localUrl = '@127.0.0.1:' + service.port + '/' + service.database;
    const ready =
      (current.get(p + '_DATABASE_URL') ?? '').endsWith(localUrl) &&
      ['_BOOTSTRAP_PASSWORD', '_APP_PASSWORD', '_MIGRATOR_PASSWORD'].every(s => current.get(p + s));

    if (ready) {
      configured.push(name);
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

    appended.push('', '# ' + name + ': DB riêng ' + service.container + ' (deploy/b-dev.compose.yml), tạo bởi npm run b:setup:dev');

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
    console.log('B database variables already point to local Docker DBs: ' + configured.join(', '));
  } else {
    const output = lines.map(line => {
      const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];

      return key && replaced.has(key) ? '# cũ (trước khi chuyển sang Docker local): ' + line : line;
    });

    while (output.length && output[output.length - 1] === '') {
      output.pop();
    }

    fs.writeFileSync(envFile, [...output, ...appended, ''].join(eol));
    console.log(
      'Updated .env for B databases (driver :5542, matching :5546, pricing :5547). ' +
        (replaced.size ? replaced.size + ' old lines kept as comments. ' : '') +
        'No secrets printed.',
    );
  }
}
