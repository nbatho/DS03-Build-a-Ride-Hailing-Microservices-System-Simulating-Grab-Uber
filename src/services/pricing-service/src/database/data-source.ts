import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options';
import { InitialPricing1792368000000 } from '../../migrations/1792368000000-initial-pricing';

config({ quiet: true });

export default new DataSource({
  ...databaseOptions(process.env, true),
  entities: [],
  migrations: [InitialPricing1792368000000],
  migrationsTableName: 'schema_migrations',
});
