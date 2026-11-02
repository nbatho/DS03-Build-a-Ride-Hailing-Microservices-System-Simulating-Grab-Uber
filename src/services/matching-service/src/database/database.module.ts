import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReadinessRegistry } from '@app/runtime';
import { databaseOptions } from './options';
import { MatchingJobEntity } from '../matching/entities/matching-job.entity';
import { OfferEntity } from '../matching/entities/offer.entity';
import { AttemptedCandidateEntity } from '../matching/entities/attempted-candidate.entity';
import { OutboxEventEntity } from '../matching/entities/outbox-event.entity';
import { ProcessedEventEntity } from '../matching/entities/processed-event.entity';
import { CommandResultEntity } from '../matching/entities/command-result.entity';

@Injectable()
class MatchingReadiness implements OnModuleInit {
  constructor(
    private readonly database: DataSource,
    private readonly registry: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.add(async () => {
      const [row] = await this.database.query(
        'SELECT current_user AS role, current_database() AS database',
      );

      if (row?.role !== 'matching_app' || row?.database !== 'matching_db') {
        throw new Error('Matching database not ready');
      }

      for (const table of [
        'matching_jobs',
        'offers',
        'attempted_candidates',
        'outbox_events',
        'processed_events',
        'command_results',
      ]) {
        await this.database.query('SELECT 1 FROM matching_schema.' + table + ' LIMIT 0');
      }
    });
  }
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (_config: ConfigService) => ({
        ...databaseOptions(process.env),
        entities: [
          MatchingJobEntity,
          OfferEntity,
          AttemptedCandidateEntity,
          OutboxEventEntity,
          ProcessedEventEntity,
          CommandResultEntity,
        ],
        retryAttempts: 1,
      }),
    }),
  ],
  providers: [MatchingReadiness],
})
export class MatchingDatabaseModule {}
