// Kết nối tới DB riêng của Pricing: pricing-db / pricing_db. Env sai DB hoặc sai user thì dừng ngay.
export function databaseOptions(env: NodeJS.ProcessEnv, migration = false) {
  const name = migration ? 'PRICING_MIGRATION_DATABASE_URL' : 'PRICING_DATABASE_URL';
  const role = migration ? 'pricing_migrator' : 'pricing_app';

  if (env.PRICING_DB_SCHEMA !== 'pricing_schema') {
    throw new Error('PRICING_DB_SCHEMA must be pricing_schema');
  }

  const url = env[name];

  try {
    const parsed = new URL(url ?? '');

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role ||
      !parsed.password ||
      parsed.pathname !== '/pricing_db' ||
      parsed.search
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(name + ': invalid PostgreSQL URL, database must be pricing_db and user ' + role);
  }

  return {
    type: 'postgres' as const,
    url,
    schema: 'pricing_schema',
    synchronize: false,
    migrationsRun: false,
    logging: false as const,
    connectTimeoutMS: 2000,
    extra: {
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=pricing_schema,pg_catalog',
    },
  };
}
