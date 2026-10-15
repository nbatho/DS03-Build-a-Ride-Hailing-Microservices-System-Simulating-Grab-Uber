// TODO: expectedVersion >= 1; Idempotency-Key bắt buộc.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class AvailabilityDto {
  declare online: boolean;
  declare expectedVersion: number;
}
