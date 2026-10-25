import { Type } from 'class-transformer';
import {
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ZONE_IDS, type ZoneId } from '@app/contracts';

class PositionDto {
  @IsNumber()
  lat!: number;

  @IsNumber()
  lng!: number;

  @IsIn(ZONE_IDS)
  zoneId!: ZoneId;
}

export class LocationDto {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PositionDto)
  position!: PositionDto;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sequence!: number;

  @IsDateString({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  recordedAt!: string;
}
