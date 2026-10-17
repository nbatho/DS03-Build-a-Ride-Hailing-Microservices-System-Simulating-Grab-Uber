import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReadinessRegistry } from '@app/runtime';
import { databaseOptions } from './options';

@Injectable()
class IdentityReadiness implements OnModuleInit {
  constructor(
    private readonly database: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(async () => {
      const rows = await this.database.query(
        "SELECT current_user AS role, to_regclass('identity_schema.users') AS users",
      );

      if (rows[0]?.role !== 'identity_app' || !rows[0]?.users) {
        throw new Error('Identity database not ready');
      }

      await this.database.query('SELECT id FROM identity_schema.users LIMIT 0');
    });
  }
}
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (_config: ConfigService) => ({
        ...databaseOptions(process.env),
        autoLoadEntities: true,
        retryAttempts: 1,
      }),
    }),
  ],
  providers: [IdentityReadiness],
})
export class IdentityDatabaseModule {}
