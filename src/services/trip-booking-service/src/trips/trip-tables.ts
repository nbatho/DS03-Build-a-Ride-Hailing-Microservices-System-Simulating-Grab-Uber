// Bảng hạ tầng của Trip dùng với @app/messaging; service, Saga và relay cùng đọc từ đây.

export const TRIP_OUTBOX_TABLE = 'trip_schema.outbox_events';

export const TRIP_INBOX = {
  table: 'trip_schema.processed_events',
  consumerName: 'trip-booking-service',
} as const;
