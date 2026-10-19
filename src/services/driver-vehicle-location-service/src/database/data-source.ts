import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options';
import { InitialDriver1792368000000 } from '../../migrations/1792368000000-initial-driver';

config({ quiet: true });

export default new DataSource({
  ...databaseOptions(process.env, true),
  entities: [],
  migrations: [InitialDriver1792368000000],
  migrationsTableName: 'schema_migrations',
});
