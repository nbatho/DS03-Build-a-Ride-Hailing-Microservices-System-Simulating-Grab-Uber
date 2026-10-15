// TODO: transform/validate query limit; candidates sort driverId ASC.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class CandidatesQueryDto {
  declare zoneId: 'ZONE_A' | 'ZONE_B';
  declare limit?: number;
}
