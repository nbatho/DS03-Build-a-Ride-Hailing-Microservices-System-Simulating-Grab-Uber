import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options';
import { InitialTrip1792540800000 } from '../../migrations/1792540800000-initial-trip';
import { TripCancelAndRetry1792627200000 } from '../../migrations/1792627200000-trip-cancel-and-retry';

config({ quiet: true });

export default new DataSource({
  ...databaseOptions(process.env, true),
  entities: [],
  migrations: [InitialTrip1792540800000, TripCancelAndRetry1792627200000],
  migrationsTableName: 'schema_migrations',
});
