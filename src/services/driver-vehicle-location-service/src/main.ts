import { bootstrap } from '@app/runtime';
import { AppModule } from './app.module';

void bootstrap(AppModule, 'driver-vehicle-location-service').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
