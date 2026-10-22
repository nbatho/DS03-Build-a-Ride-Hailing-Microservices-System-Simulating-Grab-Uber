// Kết nối tới DB riêng của Notification: notification-db / notification_db. Env sai DB hoặc sai user thì dừng ngay.
export function databaseOptions(env: NodeJS.ProcessEnv, migration = false) {
  const name = migration ? 'NOTIFICATION_MIGRATION_DATABASE_URL' : 'NOTIFICATION_DATABASE_URL';
  const role = migration ? 'notification_migrator' : 'notification_app';

  if (env.NOTIFICATION_DB_SCHEMA !== 'notification_schema') {
    throw new Error('NOTIFICATION_DB_SCHEMA must be notification_schema');
  }

  const url = env[name];

  try {
    const parsed = new URL(url ?? '');

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role ||
      !parsed.password ||
      parsed.pathname !== '/notification_db' ||
      parsed.search
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(name + ': invalid PostgreSQL URL, database must be notification_db and user ' + role);
  }

  return {
    type: 'postgres' as const,
    url,
    schema: 'notification_schema',
    synchronize: false,
    migrationsRun: false,
    logging: false as const,
    connectTimeoutMS: 2000,
    extra: {
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
      options: '-c search_path=notification_schema,pg_catalog',
    },
  };
}
