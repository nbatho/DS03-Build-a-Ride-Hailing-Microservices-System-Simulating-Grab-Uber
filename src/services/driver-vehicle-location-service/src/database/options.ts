// Kết nối tới DB riêng của Driver: driver-db / driver_db. Env sai DB hoặc sai user thì dừng ngay.
export function databaseOptions(env: NodeJS.ProcessEnv, migration = false) {
  const name = migration ? 'DRIVER_MIGRATION_DATABASE_URL' : 'DRIVER_DATABASE_URL';
  const role = migration ? 'driver_migrator' : 'driver_app';

  if (env.DRIVER_DB_SCHEMA !== 'driver_schema') {
    throw new Error('DRIVER_DB_SCHEMA must be driver_schema');
  }

  const url = env[name];

  try {
    const parsed = new URL(url ?? '');

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role ||
      !parsed.password ||
      parsed.pathname !== '/driver_db' ||
      parsed.search
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(name + ': invalid PostgreSQL URL, database must be driver_db and user ' + role);
  }

  return {
    type: 'postgres' as const,
    url,
    schema: 'driver_schema',
    synchronize: false,
    migrationsRun: false,
    logging: false as const,
    connectTimeoutMS: 2000,
    extra: {
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=driver_schema,pg_catalog',
    },
  };
}
