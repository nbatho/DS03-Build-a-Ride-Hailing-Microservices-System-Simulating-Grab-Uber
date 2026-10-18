// TODO: Ánh xạ driver_schema.vehicles bằng ORM và đăng ký với kết nối DB.
// TODO: FK local driver; unique driverId và plate canonical.
export class VehicleEntity {
  declare id: string;
  declare driverId: string;
  declare plateNumber: string;
  declare model: string;
  declare color: string;
  declare vehicleType: 'CAR';
  declare createdAt: Date;
}
