// TODO: Ánh xạ matching_schema.processed_events bằng ORM và đăng ký với kết nối DB.
// TODO: PK consumer/event; insert dedup cùng transaction business; ACK sau commit.
export class ProcessedEventEntity {
  declare consumerName: string;
  declare eventId: string;
  declare eventType: string;
  declare aggregateId: string;
  declare aggregateVersion: number;
  declare correlationId: string;
  declare processedAt: Date;
}
