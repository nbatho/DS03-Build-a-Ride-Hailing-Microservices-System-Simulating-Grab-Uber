import { Controller, Get } from '@nestjs/common';
import { Roles } from '@app/auth';
import { ApiError } from '@app/runtime';
@Controller('drivers')
@Roles('DRIVER')
export class DriversController {
  @Get('me')
  me(): never {
    // Identity only creates accounts. B implements onboarding/profile persistence next.
    throw new ApiError(404, 'DRIVER_NOT_ONBOARDED', 'Driver profile has not been created');
  }
}
