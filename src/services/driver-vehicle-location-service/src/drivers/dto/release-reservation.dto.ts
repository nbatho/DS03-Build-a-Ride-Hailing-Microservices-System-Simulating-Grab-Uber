// TODO: UUID; release đúng assignment; tombstone khi reserve chưa đến.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class ReleaseReservationDto {
  declare commandId: string;
  declare tripId: string;
  declare driverId: string;
  declare reason: 'ASSIGNMENT_FAILED' | 'TRIP_CANCELLED' | 'TRIP_COMPLETED';
}
