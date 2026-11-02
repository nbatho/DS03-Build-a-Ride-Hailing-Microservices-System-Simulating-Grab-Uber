import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard, RolesGuard, JWT_VERIFIER_OPTIONS } from './guards';
import { verifierOptions } from './key-config';

@Module({
  imports: [JwtModule.register({})],
  providers: [
    {
      provide: JWT_VERIFIER_OPTIONS,
      inject: [ConfigService],
      useFactory: (_config: ConfigService) => verifierOptions(process.env),
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthVerifierModule {}
