import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options';
import { InitialPayment1792454400000 } from '../../migrations/1792454400000-initial-payment';

config({ quiet: true });

export default new DataSource({
  ...databaseOptions(process.env, true),
  entities: [],
  migrations: [InitialPayment1792454400000],
  migrationsTableName: 'schema_migrations',
});
