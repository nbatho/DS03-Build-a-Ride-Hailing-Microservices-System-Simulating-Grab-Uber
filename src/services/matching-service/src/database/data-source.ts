import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options';
import { InitialMatching1792368000000 } from '../../migrations/1792368000000-initial-matching';

config({ quiet: true });

export default new DataSource({
  ...databaseOptions(process.env, true),
  entities: [],
  migrations: [InitialMatching1792368000000],
  migrationsTableName: 'schema_migrations',
});
