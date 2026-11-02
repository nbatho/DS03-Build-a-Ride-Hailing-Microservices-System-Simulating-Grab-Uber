import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { MatchingDatabaseModule } from './database/database.module';
import { MatchingModule } from './matching/matching.module';

@Module({
  imports: [RuntimeModule.forRoot('matching-service'), MatchingDatabaseModule, MatchingModule],
})
export class AppModule {}
