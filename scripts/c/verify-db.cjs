// Kiểm tra hai DB của C sau khi migrate: đúng DB, đủ bảng, quyền hẹp, không đăng nhập chéo được.
// Dùng làm bằng chứng cho test DB-S01 (trien-khai-db-ds03.md mục 9.4). Không in mật khẩu.
const path = require('node:path');
const { Client } = require('pg');

const root = path.resolve(__dirname, '../..');
// Hai DB của C: container, database, cổng trên máy, tiền tố biến môi trường.
const services = {
  payment: { container: 'payment-db', database: 'payment_db', port: 5544, prefix: 'PAYMENT' },
  notification: { container: 'notification-db', database: 'notification_db', port: 5545, prefix: 'NOTIFICATION' },
};

require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const tables = {
  payment: ['payments', 'payment_attempts', 'processed_events', 'outbox_events'],
  notification: ['notifications', 'trip_projection', 'processed_events'],
};

// Một câu lệnh user ứng dụng không được phép chạy, để chứng minh quyền đã bị thu hẹp.
const forbidden = {
  payment: "UPDATE payment_schema.payment_attempts SET result = 'SUCCESS'",
  notification: 'DELETE FROM notification_schema.notifications',
};

let failed = 0;

function report(ok, label, detail = '') {
  if (!ok) {
    failed++;
  }

  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' - ' + detail : ''));
}

async function connect(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });

  await client.connect();

  return client;
}

async function denied(client, sql) {
  try {
    await client.query('BEGIN');
    await client.query(sql);

    return false;
  } catch (error) {
    return error.code === '42501';
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

async function verify(name) {
  const service = services[name];
  const schema = name + '_schema';
  const appUrl = process.env[service.prefix + '_DATABASE_URL'];
  const migratorUrl = process.env[service.prefix + '_MIGRATION_DATABASE_URL'];

  console.log('== ' + name + ' (' + service.container + ' :' + service.port + ')');

  let app;

  try {
    app = await connect(appUrl);
  } catch (error) {
    report(false, 'app user connects', error.message);

    return;
  }

  try {
    const who = (await app.query('SELECT current_user AS u, current_database() AS d')).rows[0];

    report(who.u === name + '_app' && who.d === service.database, 'app user is ' + who.u + ' on ' + who.d);

    const missing = [];

    for (const table of tables[name]) {
      const row = (await app.query('SELECT to_regclass($1) AS t', [schema + '.' + table])).rows[0];

      if (!row.t) {
        missing.push(table);
      }
    }

    report(!missing.length, tables[name].length + ' tables exist', missing.length ? 'missing ' + missing.join(', ') : '');
    report(await denied(app, 'CREATE TABLE ' + schema + '.should_not_exist (id INT)'), 'app user cannot create tables');
    report(await denied(app, forbidden[name]), 'app user denied: ' + forbidden[name].split(' WHERE')[0]);
  } finally {
    await app.end();
  }

  try {
    const migrator = await connect(migratorUrl);
    const applied = (await migrator.query('SELECT count(*)::int AS n FROM ' + schema + '.schema_migrations')).rows[0].n;

    report(applied >= 1, 'migrations applied: ' + applied);
    await migrator.end();
  } catch (error) {
    report(false, 'migrator reads schema_migrations', error.message);
  }

  // Dùng user/mật khẩu của service này đăng nhập vào DB của service khác: phải thất bại.
  for (const [other, target] of Object.entries(services)) {
    if (other === name) {
      continue;
    }

    const url = new URL(appUrl);

    url.port = String(target.port);
    url.pathname = '/' + target.database;

    try {
      const client = await connect(url.toString());

      await client.end();
      report(false, name + '_app cannot log in to ' + target.container, 'login succeeded');
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.log('SKIP ' + name + '_app cannot log in to ' + target.container + ' - container not running');
        continue;
      }

      report(['28P01', '28000', '3D000'].includes(error.code), name + '_app cannot log in to ' + target.container, error.code ?? error.message);
    }
  }
}

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(services);

  for (const name of names) {
    if (!services[name]) {
      throw new Error('Unknown service "' + name + '"; expected payment or notification');
    }

    await verify(name);
  }

  console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
