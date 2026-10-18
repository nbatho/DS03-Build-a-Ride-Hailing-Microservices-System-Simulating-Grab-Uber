// TODO: sequence tăng; recordedAt RFC3339 lệch tối đa 60s; canonical tọa độ.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class LocationDto {
  declare position: { lat: number; lng: number; zoneId: 'ZONE_A' | 'ZONE_B' };
  declare sequence: number;
  declare recordedAt: string;
}
