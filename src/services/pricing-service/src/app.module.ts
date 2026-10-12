import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';

@Module({
  imports: [RuntimeModule.forRoot('pricing-service')],
})
export class AppModule {}
