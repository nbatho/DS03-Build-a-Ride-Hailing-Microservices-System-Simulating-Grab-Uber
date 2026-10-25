import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, DriverProfile } from '@app/contracts';
import { IdempotencyKey } from '@app/runtime';
import { DriversService } from './drivers.service';
import { DriverProfileDto } from './dto/driver-profile.dto';
import { AvailabilityDto } from './dto/availability.dto';

@Controller('drivers')
@Roles('DRIVER')
export class DriversController {
  constructor(private readonly service: DriversService) {}

  @Put('me')
  upsertProfile(
    @CurrentUser() actor: Actor,
    @Body() dto: DriverProfileDto,
  ): Promise<DriverProfile> {
    return this.service.upsertProfile(actor.userId, dto);
  }

  @Get('me')
  getProfile(@CurrentUser() actor: Actor): Promise<DriverProfile> {
    return this.service.getProfile(actor.userId);
  }

  @Patch('me/status')
  updateAvailability(
    @CurrentUser() actor: Actor,
    @Body() dto: AvailabilityDto,
    @IdempotencyKey() key: string,
  ): Promise<DriverProfile> {
    return this.service.updateAvailability(actor.userId, dto, key);
  }
}
