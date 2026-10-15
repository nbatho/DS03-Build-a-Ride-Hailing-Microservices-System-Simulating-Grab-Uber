// TODO: Ánh xạ matching_schema.offers bằng ORM và đăng ký với kết nối DB.
// TODO: một OPEN/CLAIMED mỗi job; assignment unique; CLAIMED không tự expire theo OPEN TTL.
export class OfferEntity {
  declare id: string;
  declare jobId: string;
  declare tripId: string;
  declare driverId: string;
  declare status: 'OPEN' | 'CLAIMED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  declare assignmentId: string | null;
  declare decisionAction: 'ACCEPT' | 'REJECT' | null;
  declare resolutionResult: 'ASSIGNED' | 'RETRY' | 'CANCELLED' | null;
  declare expiresAt: Date;
  declare version: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}
