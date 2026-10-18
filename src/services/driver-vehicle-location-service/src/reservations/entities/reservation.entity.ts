// TODO: Ánh xạ driver_schema.reservations bằng ORM và đăng ký với kết nối DB.
// TODO: unique active driver/trip HELD/CONFIRMED; giữ tombstone; CONFIRMED không TTL.
export class ReservationEntity {
  declare id: string;
  declare tripId: string;
  declare driverId: string;
  declare offerId: string | null;
  declare status: 'HELD' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED';
  declare expiresAt: Date | null;
  declare version: number;
  declare releaseReason: 'ASSIGNMENT_FAILED' | 'TRIP_CANCELLED' | 'TRIP_COMPLETED' | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}
