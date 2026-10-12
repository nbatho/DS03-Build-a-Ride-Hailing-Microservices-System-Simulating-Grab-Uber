import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';

@Module({
  imports: [RuntimeModule.forRoot('api-gateway')],
})
export class AppModule {}
