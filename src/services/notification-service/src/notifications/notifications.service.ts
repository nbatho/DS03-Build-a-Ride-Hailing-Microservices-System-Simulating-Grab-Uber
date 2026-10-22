import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { Notification, NotificationsPage } from '@app/contracts';
import { processEventOnce } from '@app/messaging';
import { ApiError } from '@app/runtime';
import { decodeCursor, encodeCursor } from './cursor';
import {
  applyEvent,
  toNotificationDto,
  tripIdOf,
  type NotificationEvent,
  type StoredNotification,
  type TripProjectionState,
} from './notification-rules';

export const NOTIFICATION_CONSUMER_NAME = 'notification-service';
export const NOTIFICATION_PROCESSED_EVENTS_TABLE = 'notification_schema.processed_events';
export const DEFAULT_PAGE_LIMIT = 20;

export interface ListOptions {
  limit?: number;
  cursor?: string;
  unreadOnly?: boolean;
}

interface NotificationRow {
  id: string;
  recipient_id: string;
  source_event_id: string;
  trip_id: string;
  type: StoredNotification['type'];
  title: string;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
  created_at_text: string;
  terminal_state: TripProjectionState['terminalState'];
  trip_status: TripProjectionState['tripStatus'];
}

const SELECT_NOTIFICATION = `
  SELECT n.id, n.recipient_id, n.source_event_id, n.trip_id, n.type, n.title, n.payload, n.read_at,
         n.created_at, to_json(n.created_at) #>> '{}' AS created_at_text, p.terminal_state, p.trip_status
    FROM notification_schema.notifications n
    LEFT JOIN notification_schema.trip_projection p ON p.trip_id = n.trip_id`;

function toDto(row: NotificationRow, now: Date): Notification {
  return toNotificationDto(
    {
      id: row.id,
      recipientId: row.recipient_id,
      sourceEventId: row.source_event_id,
      tripId: row.trip_id,
      type: row.type,
      title: row.title,
      payload: row.payload,
      readAt: row.read_at,
      createdAt: row.created_at,
    },
    { terminalState: row.terminal_state, tripStatus: row.trip_status },
    now,
  );
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationsService');

  constructor(private readonly dataSource: DataSource) {}

  /** Một sự kiện: ghi "đã xử lý", cập nhật bản sao chuyến, tạo thông báo; tất cả trong một transaction. */
  async handleEvent(event: NotificationEvent): Promise<number | 'DUPLICATE_EVENT'> {
    const result = await processEventOnce(
      this.dataSource,
      { table: NOTIFICATION_PROCESSED_EVENTS_TABLE, consumerName: NOTIFICATION_CONSUMER_NAME },
      event,
      manager => this.applyInTransaction(manager, event),
    );
    const outcome = result.duplicate ? 'DUPLICATE_EVENT' : result.result;

    this.logger.log(event.type + ' ' + event.event_id + ' -> ' + outcome + ' notification(s)');

    return outcome;
  }

  async list(recipientId: string, options: ListOptions, now = new Date()): Promise<NotificationsPage> {
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    const params: unknown[] = [recipientId];
    const where = ['n.recipient_id = $1'];

    if (options.unreadOnly) {
      where.push('n.read_at IS NULL');
    }

    if (options.cursor) {
      const position = decodeCursor(options.cursor);

      params.push(position.createdAt, position.id);
      where.push('(n.created_at, n.id) < ($2::timestamptz, $3::uuid)');
    }

    params.push(limit + 1);

    const rows: NotificationRow[] = await this.dataSource.query(
      SELECT_NOTIFICATION +
        ' WHERE ' +
        where.join(' AND ') +
        ' ORDER BY n.created_at DESC, n.id DESC LIMIT $' +
        params.length,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      items: page.map(row => toDto(row, now)),
      ...(rows.length > limit && last
        ? { nextCursor: encodeCursor({ createdAt: last.created_at_text, id: last.id }) }
        : {}),
    };
  }

  /** Đánh dấu đã đọc; gọi lặp vẫn 200 và giữ thời điểm đọc đầu tiên. Không đổi trạng thái chuyến. */
  async markRead(recipientId: string, notificationId: string, now = new Date()): Promise<Notification> {
    const row = await this.findRow(notificationId);

    if (row.recipient_id !== recipientId) {
      throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'Notification belongs to another user');
    }

    if (row.read_at) {
      return toDto(row, now);
    }

    await this.dataSource.query(
      'UPDATE notification_schema.notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL',
      [notificationId],
    );

    return toDto(await this.findRow(notificationId), now);
  }

  private async findRow(notificationId: string): Promise<NotificationRow> {
    const rows: NotificationRow[] = await this.dataSource.query(SELECT_NOTIFICATION + ' WHERE n.id = $1', [
      notificationId,
    ]);

    if (!rows[0]) {
      throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
    }

    return rows[0];
  }

  private async applyInTransaction(manager: EntityManager, event: NotificationEvent): Promise<number> {
    const tripId = tripIdOf(event);

    await manager.query(
      'INSERT INTO notification_schema.trip_projection (trip_id) VALUES ($1) ON CONFLICT (trip_id) DO NOTHING',
      [tripId],
    );

    const [row] = await manager.query(
      `SELECT trip_id, trip_version, trip_status, terminal_state, terminal_event_id, known_driver_ids,
              passenger_id, payment_id, payment_version, payment_status
         FROM notification_schema.trip_projection WHERE trip_id = $1 FOR UPDATE`,
      [tripId],
    );
    const current: TripProjectionState = {
      tripId: row.trip_id,
      tripVersion: row.trip_version,
      tripStatus: row.trip_status,
      terminalState: row.terminal_state,
      terminalEventId: row.terminal_event_id,
      knownDriverIds: row.known_driver_ids ?? [],
      passengerId: row.passenger_id,
      paymentId: row.payment_id,
      paymentVersion: row.payment_version,
      paymentStatus: row.payment_status,
    };
    const { projection: next, notifications } = applyEvent(current, event);

    await manager.query(
      `UPDATE notification_schema.trip_projection
          SET trip_version = $2, trip_status = $3, terminal_state = $4, terminal_event_id = $5,
              known_driver_ids = $6::uuid[], passenger_id = $7, payment_id = $8, payment_version = $9,
              payment_status = $10, updated_at = now()
        WHERE trip_id = $1`,
      [
        tripId,
        next.tripVersion,
        next.tripStatus,
        next.terminalState,
        next.terminalEventId,
        next.knownDriverIds,
        next.passengerId,
        next.paymentId,
        next.paymentVersion,
        next.paymentStatus,
      ],
    );

    let created = 0;

    for (const notification of notifications) {
      const inserted: unknown[] = await manager.query(
        `INSERT INTO notification_schema.notifications
           (recipient_id, source_event_id, trip_id, type, title, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (recipient_id, source_event_id, type) DO NOTHING
         RETURNING id`,
        [
          notification.recipientId,
          notification.sourceEventId,
          notification.tripId,
          notification.type,
          notification.title,
          JSON.stringify(notification.payload),
        ],
      );

      created += inserted.length;
    }

    return created;
  }
}
