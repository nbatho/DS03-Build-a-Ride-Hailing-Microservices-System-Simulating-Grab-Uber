// Kết nối tới DB riêng của Matching: matching-db / matching_db. Env sai DB hoặc sai user thì dừng ngay.
export function databaseOptions(env: NodeJS.ProcessEnv, migration = false) {
  const name = migration ? 'MATCHING_MIGRATION_DATABASE_URL' : 'MATCHING_DATABASE_URL';
  const role = migration ? 'matching_migrator' : 'matching_app';

  if (env.MATCHING_DB_SCHEMA !== 'matching_schema') {
    throw new Error('MATCHING_DB_SCHEMA must be matching_schema');
  }

  const url = env[name];

  try {
    const parsed = new URL(url ?? '');

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role ||
      !parsed.password ||
      parsed.pathname !== '/matching_db' ||
      parsed.search
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(name + ': invalid PostgreSQL URL, database must be matching_db and user ' + role);
  }

  return {
    type: 'postgres' as const,
    url,
    schema: 'matching_schema',
    synchronize: false,
    migrationsRun: false,
    logging: false as const,
    connectTimeoutMS: 2000,
    extra: {
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=matching_schema,pg_catalog',
    },
  };
}
