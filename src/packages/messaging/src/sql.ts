// Tên bảng nối thẳng vào SQL nên chỉ nhận dạng "schema.table" chữ thường.
const QUALIFIED_TABLE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

export function assertTableName(table: string): string {
  if (!QUALIFIED_TABLE.test(table)) {
    throw new Error('Invalid table name: ' + table);
  }

  return table;
}

function assertSchemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error('Invalid schema name: ' + schema);
  }

  return schema;
}

/** DDL bảng "sự kiện chờ gửi" chuẩn (giống matching_schema.outbox_events) để migration của service dùng lại. */
export function outboxTableDdl(schema: string): string[] {
  const s = assertSchemaName(schema);

  return [
    `CREATE TABLE ${s}.outbox_events (
      event_id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      aggregate_version INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      correlation_id UUID NOT NULL,
      causation_id UUID NOT NULL,
      envelope_json JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_token UUID NULL,
      lease_until TIMESTAMPTZ NULL,
      last_error TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ NULL,
      CONSTRAINT ck_outbox_events_status CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED')),
      CONSTRAINT ck_outbox_events_versions CHECK (aggregate_version >= 1 AND schema_version >= 1),
      CONSTRAINT ck_outbox_events_attempts CHECK (attempts >= 0),
      CONSTRAINT ck_outbox_events_envelope CHECK (jsonb_typeof(envelope_json) = 'object'),
      CONSTRAINT ck_outbox_events_published CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL)),
      CONSTRAINT ck_outbox_events_lease CHECK ((lease_token IS NULL) = (lease_until IS NULL))
    )`,
    `CREATE INDEX ix_outbox_events_dispatch ON ${s}.outbox_events (next_retry_at) WHERE status IN ('PENDING', 'PUBLISHING')`,
  ];
}

/** DDL bảng "sự kiện đã xử lý" chuẩn, khóa (consumer_name, event_id). */
export function processedEventsTableDdl(schema: string): string[] {
  const s = assertSchemaName(schema);

  return [
    `CREATE TABLE ${s}.processed_events (
      consumer_name TEXT NOT NULL,
      event_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      aggregate_version INTEGER NOT NULL,
      correlation_id UUID NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pk_processed_events PRIMARY KEY (consumer_name, event_id),
      CONSTRAINT ck_processed_events_version CHECK (aggregate_version >= 1)
    )`,
  ];
}
