import { Injectable, NotImplementedException } from '@nestjs/common';
import { VehicleDto } from './dto/vehicle.dto';

@Injectable()
export class VehiclesService {
  registerVehicle(driverId: string, dto: VehicleDto, idempotencyKey: string): never {
    // TODO: canonical plate; một CAR/driver; unique conflict; key+vehicle+response cùng transaction.
    throw new NotImplementedException('VehiclesService.registerVehicle TODO');
  }

  getMyVehicle(driverId: string): never {
    // TODO: đọc xe của JWT.sub; map not-found theo contract.
    throw new NotImplementedException('VehiclesService.getMyVehicle TODO');
  }
}
