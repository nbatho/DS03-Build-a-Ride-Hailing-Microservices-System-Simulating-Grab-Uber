import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';

@Module({
  imports: [RuntimeModule.forRoot('notification-service')],
})
export class AppModule {}
