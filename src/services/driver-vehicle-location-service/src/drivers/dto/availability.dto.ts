import { IsBoolean, IsInt, Max, Min } from 'class-validator';

export class AvailabilityDto {
  @IsBoolean()
  online!: boolean;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion!: number;
}
