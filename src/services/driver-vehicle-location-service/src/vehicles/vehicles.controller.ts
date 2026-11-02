import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, Vehicle } from '@app/contracts';
import { IdempotencyKey } from '@app/runtime';
import { VehiclesService } from './vehicles.service';
import { VehicleDto } from './dto/vehicle.dto';

@Controller('vehicles')
@Roles('DRIVER')
export class VehiclesController {
  constructor(private readonly service: VehiclesService) {}

  @Post()
  registerVehicle(
    @CurrentUser() actor: Actor,
    @Body() dto: VehicleDto,
    @IdempotencyKey() key: string,
  ): Promise<Vehicle> {
    return this.service.registerVehicle(actor.userId, dto, key);
  }

  @Get('me')
  getMyVehicle(@CurrentUser() actor: Actor): Promise<Vehicle> {
    return this.service.getMyVehicle(actor.userId);
  }
}
