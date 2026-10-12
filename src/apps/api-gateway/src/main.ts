import { bootstrap } from '@app/runtime';
import { AppModule } from './app.module';

void bootstrap(AppModule, 'api-gateway').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
