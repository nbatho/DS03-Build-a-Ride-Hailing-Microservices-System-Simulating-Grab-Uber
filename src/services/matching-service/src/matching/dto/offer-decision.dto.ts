// TODO: assignmentId là decision ID; body không có commandId.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class OfferDecisionDto {
  declare assignmentId: string;
  declare tripId: string;
  declare driverId: string;
  declare action: 'ACCEPT' | 'REJECT';
}
