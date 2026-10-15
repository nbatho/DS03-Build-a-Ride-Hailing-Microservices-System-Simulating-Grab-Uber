import { Injectable, NotImplementedException } from '@nestjs/common';

// TODO: Đăng ký lịch chạy và dừng worker an toàn sau khi có DB, lease và kiểm thử phục hồi.
@Injectable()
export class ReservationExpiryWorker {
  expireHeldReservations(): never {
    // TODO: scan HELD hết lease; mỗi transaction khóa driver trước reservation; không tự release CONFIRMED.
    throw new NotImplementedException('ReservationExpiryWorker.expireHeldReservations TODO');
  }
}
