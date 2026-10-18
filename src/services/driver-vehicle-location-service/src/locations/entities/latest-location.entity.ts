// TODO: Ánh xạ driver_schema.latest_locations bằng ORM và đăng ký với kết nối DB.
// TODO: NUMERIC(9,6); sequence BIGINT chuyển number có kiểm soát; CAS không refresh GPS cũ.
export class LatestLocationEntity {
  declare driverId: string;
  declare lat: string;
  declare lng: string;
  declare zoneId: 'ZONE_A' | 'ZONE_B';
  declare sequence: number;
  declare recordedAt: Date;
  declare receivedAt: Date;
}
