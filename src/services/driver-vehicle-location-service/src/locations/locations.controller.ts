import { Body, Controller, Put } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, Location } from '@app/contracts';
import { LocationsService } from './locations.service';
import { LocationDto } from './dto/location.dto';

@Controller('drivers/me/location')
@Roles('DRIVER')
export class LocationsController {
  constructor(private readonly service: LocationsService) {}

  @Put()
  updateLocation(@CurrentUser() actor: Actor, @Body() dto: LocationDto): Promise<Location> {
    return this.service.updateLocation(actor.userId, dto);
  }
}
