// TODO: Ánh xạ pricing_schema.quotes bằng ORM và đăng ký với kết nối DB.
// TODO: snapshot bất biến; owner/expiry index; không query DB Trip.
export class QuoteEntity {
  declare id: string;
  declare passengerId: string;
  declare pickupLat: string;
  declare pickupLng: string;
  declare pickupZoneId: 'ZONE_A' | 'ZONE_B';
  declare dropoffLat: string;
  declare dropoffLng: string;
  declare dropoffZoneId: 'ZONE_A' | 'ZONE_B';
  declare distanceMeters: number;
  declare durationSeconds: number;
  declare amount: string;
  declare currency: 'VND';
  declare ruleVersion: string;
  declare createdAt: Date;
  declare expiresAt: Date;
}
