// TODO: UUID và ownership; commandId ổn định khi retry.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class ConfirmReservationDto {
  declare commandId: string;
  declare tripId: string;
  declare driverId: string;
}
