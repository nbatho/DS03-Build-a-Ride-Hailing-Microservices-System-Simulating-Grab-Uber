import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { RetryOperationRequest } from '@app/contracts';

export class RetryOperationDto implements RetryOperationRequest {
  @IsUUID()
  commandId!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}
