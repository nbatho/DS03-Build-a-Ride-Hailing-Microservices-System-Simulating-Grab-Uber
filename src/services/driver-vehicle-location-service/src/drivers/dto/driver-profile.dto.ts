import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class DriverProfileDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 40)
  licenseNumber!: string;
}
