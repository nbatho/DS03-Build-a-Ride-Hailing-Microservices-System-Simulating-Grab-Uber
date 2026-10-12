import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';

@Module({
  imports: [RuntimeModule.forRoot('matching-service')],
})
export class AppModule {}
