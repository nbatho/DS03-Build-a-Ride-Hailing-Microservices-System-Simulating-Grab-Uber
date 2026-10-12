import { Module } from '@nestjs/common';
import { RuntimeModule } from '@app/runtime';
import { MatchingModule } from './matching/matching.module';

@Module({
  imports: [RuntimeModule.forRoot('matching-service'), MatchingModule],
})
export class AppModule {}
