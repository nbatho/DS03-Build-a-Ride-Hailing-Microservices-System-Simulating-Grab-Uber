// Kết nối tới DB riêng của Payment: payment-db / payment_db. Env sai DB hoặc sai user thì dừng ngay.
export function databaseOptions(env: NodeJS.ProcessEnv, migration = false) {
  const name = migration ? 'PAYMENT_MIGRATION_DATABASE_URL' : 'PAYMENT_DATABASE_URL';
  const role = migration ? 'payment_migrator' : 'payment_app';

  if (env.PAYMENT_DB_SCHEMA !== 'payment_schema') {
    throw new Error('PAYMENT_DB_SCHEMA must be payment_schema');
  }

  const url = env[name];

  try {
    const parsed = new URL(url ?? '');

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role ||
      !parsed.password ||
      parsed.pathname !== '/payment_db' ||
      parsed.search
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(name + ': invalid PostgreSQL URL, database must be payment_db and user ' + role);
  }

  return {
    type: 'postgres' as const,
    url,
    schema: 'payment_schema',
    synchronize: false,
    migrationsRun: false,
    logging: false as const,
    connectTimeoutMS: 2000,
    extra: {
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=payment_schema,pg_catalog',
    },
  };
}
