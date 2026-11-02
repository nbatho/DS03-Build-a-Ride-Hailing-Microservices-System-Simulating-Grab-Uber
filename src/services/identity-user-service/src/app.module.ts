import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { AuthVerifierModule } from '@app/auth';
import { IdentityDatabaseModule } from './database/database.module';
import { IdentityAuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    RuntimeModule.forRoot('identity-user-service'),
    IdentityDatabaseModule,
    AuthVerifierModule,
    UsersModule,
    IdentityAuthModule,
  ],
})
export class AppModule {}
