import { Controller } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { ReserveReservationDto } from './dto/reserve-reservation.dto';
import { ConfirmReservationDto } from './dto/confirm-reservation.dto';
import { ReleaseReservationDto } from './dto/release-reservation.dto';

// TODO: Thêm định tuyến HTTP, xác thực và xử lý dữ liệu đầu vào.
// TODO: Xác thực service gọi và cấu hình prefix riêng cho route nội bộ.
@Controller('internal/v1/reservations')
export class ReservationsInternalController {
  constructor(private readonly service: ReservationsService) {}

  // TODO: Tạo API giữ tài xế cho assignment, chỉ cho phép Trip gọi.
  reserve(reservationId: string, dto: ReserveReservationDto): never {
    return this.service.reserve(reservationId, dto);
  }

  // TODO: Tạo API đọc trạng thái reservation để Trip đối soát.
  getReservation(reservationId: string): never {
    return this.service.getReservation(reservationId);
  }

  // TODO: Tạo API xác nhận reservation và trả trạng thái HTTP thành công theo contract.
  confirm(reservationId: string, dto: ConfirmReservationDto): never {
    return this.service.confirm(reservationId, dto);
  }

  // TODO: Tạo API giải phóng reservation và trả trạng thái HTTP thành công theo contract.
  release(reservationId: string, dto: ReleaseReservationDto): never {
    return this.service.release(reservationId, dto);
  }
}
