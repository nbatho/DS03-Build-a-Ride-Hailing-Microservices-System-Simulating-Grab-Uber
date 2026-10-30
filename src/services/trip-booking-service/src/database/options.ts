export function databaseOptions(env: NodeJS.ProcessEnv, migration = false) {
  const name = migration ? 'TRIP_MIGRATION_DATABASE_URL' : 'TRIP_DATABASE_URL';
  const role = migration ? 'trip_migrator' : 'trip_app';

  if (env.TRIP_DB_SCHEMA !== 'trip_schema') {
    throw new Error('TRIP_DB_SCHEMA must be trip_schema');
  }

  const url = env[name];

  try {
    const parsed = new URL(url ?? '');

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role ||
      !parsed.password ||
      parsed.pathname !== '/trip_db' ||
      parsed.search
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(name + ': invalid PostgreSQL URL, database must be trip_db and user ' + role);
  }

  return {
    type: 'postgres' as const,
    url,
    schema: 'trip_schema',
    synchronize: false,
    migrationsRun: false,
    logging: false as const,
    connectTimeoutMS: 2000,
    extra: {
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=trip_schema,pg_catalog',
    },
  };
}
