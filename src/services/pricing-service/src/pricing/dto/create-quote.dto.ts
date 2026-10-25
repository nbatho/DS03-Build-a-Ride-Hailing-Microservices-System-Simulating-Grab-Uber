import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ZONE_IDS, type Point, type QuoteRequest, type ZoneId } from '@app/contracts';

class PointDto implements Point {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsIn(ZONE_IDS)
  zoneId!: ZoneId;
}

export class CreateQuoteDto implements QuoteRequest {
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PointDto)
  pickup!: PointDto;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PointDto)
  dropoff!: PointDto;

  // Giới hạn mét/giây kiểm tra trong FareCalculator để trả mã INVALID_ESTIMATE.
  @IsInt()
  distanceMeters!: number;

  @IsInt()
  durationSeconds!: number;
}
