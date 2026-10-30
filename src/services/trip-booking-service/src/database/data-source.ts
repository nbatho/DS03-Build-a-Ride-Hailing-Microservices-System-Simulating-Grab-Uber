import 'reflect-metadata';
import { config } from 'dotenv';
import { DataSource } from 'typeorm';
import { databaseOptions } from './options';
import { InitialTrip1792540800000 } from '../../migrations/1792540800000-initial-trip';

config({ quiet: true });

export default new DataSource({
  ...databaseOptions(process.env, true),
  entities: [],
  migrations: [InitialTrip1792540800000],
  migrationsTableName: 'schema_migrations',
});
