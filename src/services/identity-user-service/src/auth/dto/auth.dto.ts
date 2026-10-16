import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { USER_ROLES, type UserRole } from '@app/contracts';
import { ApiProperty } from '@nestjs/swagger';

function Utf8Bytes(max: number, options?: ValidationOptions): PropertyDecorator {
  return (target, property) =>
    registerDecorator({
      name: 'utf8Bytes',
      target: target.constructor,
      propertyName: String(property),
      options,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
        defaultMessage: () => 'password must not exceed 72 UTF-8 bytes',
      },
    });
}

const normalize = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginRequest {
  @ApiProperty({
    format: 'email',
    maxLength: 254,
    example: 'passenger.manual01@example.com',
    description: 'Email được trim và chuyển thành chữ thường.',
  })
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 72,
    writeOnly: true,
    example: 'ManualTest!2026',
    description: 'Tối đa 72 byte UTF-8; không trim password.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  @Utf8Bytes(72)
  password!: string;
}

export class RegisterRequest {
  @ApiProperty({
    format: 'email',
    maxLength: 254,
    example: 'passenger.manual01@example.com',
    description: 'Email được trim, chuyển lowercase và phải duy nhất.',
  })
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    minLength: 10,
    maxLength: 72,
    writeOnly: true,
    example: 'ManualTest!2026',
    description: 'Tối thiểu 10 ký tự, tối đa 72 byte UTF-8; không trim password.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(72)
  @Utf8Bytes(72)
  password!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 80,
    example: 'Hành khách test',
    description: 'Tên hiển thị được trim, không được rỗng.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;

  @ApiProperty({
    enum: [...USER_ROLES],
    example: 'PASSENGER',
    description: 'Chỉ hỗ trợ PASSENGER hoặc DRIVER.',
  })
  @IsIn(USER_ROLES)
  role!: UserRole;
}
