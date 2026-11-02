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
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  @Utf8Bytes(72)
  password!: string;
}

export class RegisterRequest {
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(72)
  @Utf8Bytes(72)
  password!: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;

  @IsIn(USER_ROLES)
  role!: UserRole;
}
