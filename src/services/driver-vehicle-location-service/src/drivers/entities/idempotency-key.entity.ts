// TODO: Ánh xạ driver_schema.idempotency_keys bằng ORM và đăng ký với kết nối DB.
// TODO: unique actor/method/path/key, canonical hash; response cùng transaction; giữ >=24h.
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
