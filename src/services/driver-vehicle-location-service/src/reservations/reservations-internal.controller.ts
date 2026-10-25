import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { CurrentCaller, InternalRoute, type ContextRequest } from '@app/runtime';
import type { InternalCaller } from '@app/shared-types';
import type { Reservation } from '@app/contracts';
import { ReservationsService } from './reservations.service';
import { ReserveReservationDto } from './dto/reserve-reservation.dto';
import { ConfirmReservationDto } from './dto/confirm-reservation.dto';
import { ReleaseReservationDto } from './dto/release-reservation.dto';

@InternalRoute('TRIP')
@Controller('internal/v1/reservations')
export class ReservationsInternalController {
  constructor(private readonly service: ReservationsService) {}

  @Put(':reservationId')
  reserve(
    @Param('reservationId', new ParseUUIDPipe()) id: string,
    @Body() dto: ReserveReservationDto,
    @CurrentCaller() caller: InternalCaller,
    @Req() req: ContextRequest,
  ): Promise<Reservation> {
    return this.service.reserve(id.toLowerCase(), dto, caller, req.correlationId);
  }

  @Get(':reservationId')
  getReservation(@Param('reservationId', new ParseUUIDPipe()) id: string): Promise<Reservation> {
    return this.service.getReservation(id);
  }

  @Post(':reservationId/confirm')
  @HttpCode(200)
  confirm(
    @Param('reservationId', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmReservationDto,
    @CurrentCaller() caller: InternalCaller,
    @Req() req: ContextRequest,
  ): Promise<Reservation> {
    return this.service.confirm(id.toLowerCase(), dto, caller, req.correlationId);
  }

  @Post(':reservationId/release')
  @HttpCode(200)
  release(
    @Param('reservationId', new ParseUUIDPipe()) id: string,
    @Body() dto: ReleaseReservationDto,
    @CurrentCaller() caller: InternalCaller,
    @Req() req: ContextRequest,
  ): Promise<Reservation> {
    return this.service.release(id.toLowerCase(), dto, caller, req.correlationId);
  }
}
