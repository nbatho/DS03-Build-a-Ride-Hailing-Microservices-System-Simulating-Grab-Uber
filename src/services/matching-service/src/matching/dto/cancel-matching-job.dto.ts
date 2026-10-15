// TODO: tripVersion >= 1; tripId lấy từ path; commandId UUID.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class CancelMatchingJobDto {
  declare commandId: string;
  declare tripVersion: number;
}
