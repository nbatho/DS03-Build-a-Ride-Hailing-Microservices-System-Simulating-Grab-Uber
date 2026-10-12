import { bootstrap } from '@app/runtime';
import { AppModule } from './app.module';

void bootstrap(AppModule, 'simulated-payment-service').catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
