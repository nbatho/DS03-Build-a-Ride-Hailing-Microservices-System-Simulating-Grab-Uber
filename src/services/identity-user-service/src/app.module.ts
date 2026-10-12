import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { UsersModule } from './users/users.module';

@Module({
  imports: [RuntimeModule.forRoot('identity-user-service'), UsersModule],
})
export class AppModule {}
