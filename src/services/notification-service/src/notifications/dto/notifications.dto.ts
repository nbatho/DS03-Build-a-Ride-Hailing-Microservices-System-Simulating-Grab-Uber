import { Transform, Type } from 'class-transformer';
import { Equals, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** GET /api/v1/notifications (API-36). */
export class ListNotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  unreadOnly?: boolean;
}

/** PATCH /api/v1/notifications/{notificationId}/read (API-37): chỉ nhận read=true. */
export class ReadNotificationDto {
  @Equals(true)
  read!: true;
}
