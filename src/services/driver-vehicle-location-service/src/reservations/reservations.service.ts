import { Injectable, NotImplementedException } from '@nestjs/common';
import { ReserveReservationDto } from './dto/reserve-reservation.dto';
import { ConfirmReservationDto } from './dto/confirm-reservation.dto';
import { ReleaseReservationDto } from './dto/release-reservation.dto';

@Injectable()
export class ReservationsService {
  reserve(reservationId: string, dto: ReserveReservationDto): never {
    // TODO: reservationId=assignmentId; khóa driver rồi reservation; HELD30s; unique active driver/trip.
    throw new NotImplementedException('ReservationsService.reserve TODO');
  }

  getReservation(reservationId: string): never {
    // TODO: authoritative kể cả RELEASED/EXPIRED; 404 không chứng minh lệnh cũ không đến muộn.
    throw new NotImplementedException('ReservationsService.getReservation TODO');
  }

  confirm(reservationId: string, dto: ConfirmReservationDto): never {
    // TODO: ownership/command replay; HELD chưa hết lease -> CONFIRMED; bỏ TTL.
    throw new NotImplementedException('ReservationsService.confirm TODO');
  }

  release(reservationId: string, dto: ReleaseReservationDto): never {
    // TODO: idempotent; chưa tồn tại tạo RELEASED tombstone; không hồi sinh assignment.
    throw new NotImplementedException('ReservationsService.release TODO');
  }
}
