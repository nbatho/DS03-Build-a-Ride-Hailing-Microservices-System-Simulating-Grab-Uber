// TODO: mét 1–100000, giây 1–14400; actor/CAR/VND do server xác định.
// TODO: Thêm kiểm tra và chuẩn hóa dữ liệu đầu vào theo contract đã thống nhất.
export class CreateQuoteDto {
  declare pickup: { lat: number; lng: number; zoneId: 'ZONE_A' | 'ZONE_B' };
  declare dropoff: { lat: number; lng: number; zoneId: 'ZONE_A' | 'ZONE_B' };
  declare distanceMeters: number;
  declare durationSeconds: number;
}
