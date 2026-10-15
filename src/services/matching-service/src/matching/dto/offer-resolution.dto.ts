// TODO: đúng assignment đã claim; UUID; result không được mâu thuẫn.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class OfferResolutionDto {
  declare commandId: string;
  declare assignmentId: string;
  declare tripId: string;
  declare result: 'ASSIGNED' | 'RETRY' | 'CANCELLED';
}
