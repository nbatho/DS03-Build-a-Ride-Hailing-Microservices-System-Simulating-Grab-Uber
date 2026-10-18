// TODO: UUID; reservationId=assignmentId lấy từ path; body không có commandId.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class ReserveReservationDto {
  declare tripId: string;
  declare driverId: string;
  declare offerId: string;
}
