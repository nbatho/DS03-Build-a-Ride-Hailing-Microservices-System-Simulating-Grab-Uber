import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options';
import { InitialUsers1791849600000 } from '../../migrations/1791849600000-initial-users';

export default new DataSource({
  ...databaseOptions(process.env, true),
  entities: [],
  migrations: [InitialUsers1791849600000],
  migrationsTableName: 'schema_migrations',
});
