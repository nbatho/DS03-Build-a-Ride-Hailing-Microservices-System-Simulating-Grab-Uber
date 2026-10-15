// TODO: Ánh xạ matching_schema.matching_jobs bằng ORM và đăng ký với kết nối DB.
// TODO: unique tripId; CANCELLED tombstone có snapshot/deadline NULL; current offer thuộc job.
export class MatchingJobEntity {
  declare id: string;
  declare tripId: string;
  declare status: 'SEARCHING' | 'OFFERING' | 'CLAIMED' | 'MATCHED' | 'FAILED' | 'CANCELLED';
  declare version: number;
  declare latestTripVersion: number;
  declare tripSnapshot: Record<string, unknown> | null;
  declare searchDeadline: Date | null;
  declare currentOfferId: string | null;
  declare nextRetryAt: Date;
  declare leaseToken: string | null;
  declare leaseUntil: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}
