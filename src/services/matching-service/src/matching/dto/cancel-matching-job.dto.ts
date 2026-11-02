import { Transform } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

export const normalizeUuid = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class CancelMatchingJobDto {
  @Transform(normalizeUuid)
  @IsUUID()
  commandId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  tripVersion!: number;
}
