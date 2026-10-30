import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser, Roles } from '@app/auth';
import type { Actor, Operation } from '@app/contracts';
import { uuidParam } from '@app/runtime';
import { TripsService } from './trips.service';

@Controller('operations')
@Roles('PASSENGER', 'DRIVER')
export class OperationsController {
  constructor(private readonly trips: TripsService) {}

  @Get(':operationId')
  getOne(
    @CurrentUser() actor: Actor,
    @Param('operationId', uuidParam('operationId')) operationId: string,
  ): Promise<Operation> {
    return this.trips.getOperation(actor, operationId);
  }
}
