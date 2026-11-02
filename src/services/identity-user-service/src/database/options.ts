export function databaseOptions(env: NodeJS.ProcessEnv, migration = false) {
  const name = migration ? 'IDENTITY_MIGRATION_DATABASE_URL' : 'IDENTITY_DATABASE_URL';
  const role = migration ? 'identity_migrator' : 'identity_app';

  if (env.IDENTITY_DB_SCHEMA !== 'identity_schema') {
    throw new Error('IDENTITY_DB_SCHEMA must be identity_schema');
  }

  const url = env[name];

  try {
    const parsed = new URL(url ?? '');

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role ||
      !parsed.password ||
      !parsed.pathname.slice(1) ||
      parsed.search
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(name + ': invalid PostgreSQL URL or incorrect application role');
  }

  return {
    type: 'postgres' as const,
    url,
    schema: 'identity_schema',
    synchronize: false,
    migrationsRun: false,
    logging: false as const,
    connectTimeoutMS: 2000,
    extra: {
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=identity_schema,pg_catalog',
    },
  };
}
