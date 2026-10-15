// TODO: trim/uppercase plate; CAR do server gán; Idempotency-Key bắt buộc.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class VehicleDto {
  declare plateNumber: string;
  declare model: string;
  declare color: string;
}
