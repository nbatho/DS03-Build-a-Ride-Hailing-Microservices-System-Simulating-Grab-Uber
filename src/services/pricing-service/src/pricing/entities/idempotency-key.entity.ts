// TODO: Ánh xạ pricing_schema.idempotency_keys bằng ORM và đăng ký với kết nối DB.
// TODO: unique actor/method/path/key; giữ quoteId/TTL cũ khi replay; retention >=24h.
export class IdempotencyKeyEntity {
  declare actorId: string;
  declare method: string;
  declare path: string;
  declare key: string;
  declare requestHash: string;
  declare responseStatus: number;
  declare responseBody: unknown;
  declare createdAt: Date;
  declare expiresAt: Date;
}
