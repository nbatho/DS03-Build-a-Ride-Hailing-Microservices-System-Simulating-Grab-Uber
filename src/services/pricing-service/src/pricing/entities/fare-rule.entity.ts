// TODO: Ánh xạ pricing_schema.fare_rules bằng ORM và đăng ký với kết nối DB.
// TODO: BIGINT tiền giữ dạng string; CAR_V1 seed 12000/8000/500; rule bất biến.
export class FareRuleEntity {
  declare ruleVersion: string;
  declare vehicleType: 'CAR';
  declare baseFee: string;
  declare perKm: string;
  declare perMin: string;
  declare currency: 'VND';
  declare createdAt: Date;
}
