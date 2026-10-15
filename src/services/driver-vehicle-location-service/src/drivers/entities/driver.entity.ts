// TODO: Ánh xạ driver_schema.drivers bằng ORM và đăng ký với kết nối DB.
// TODO: id=userId; không FK sang Identity; version tăng khi availability/reservation thay đổi.
export class DriverEntity {
  declare id: string;
  declare licenseNumber: string;
  declare online: boolean;
  declare version: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}
