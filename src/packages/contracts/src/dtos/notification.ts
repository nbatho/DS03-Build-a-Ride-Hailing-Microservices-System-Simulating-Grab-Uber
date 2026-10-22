import type { Currency, MoneyAmount, Point } from './common';
import type { Offer } from './matching';
import type { PaymentStatus } from './payment';

// Thông báo (Phụ lục A API-36, 37; Phụ lục B "Notification", "NotificationsPage", "ReadNotificationRequest").

export const NOTIFICATION_TYPES = ['OFFER', 'TRIP_STATUS', 'PAYMENT_STATUS'] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const TRIP_STATUSES = [
  'MATCHING',
  'ASSIGNING',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLING',
  'CANCELLED',
  'NO_DRIVER',
] as const;
export type TripStatus = typeof TRIP_STATUSES[number];

/**
 * Field theo loại (bắt buộc trong đúng biến thể): OFFER có offer/pickup/dropoff/amount/currency;
 * TRIP_STATUS có tripStatus; PAYMENT_STATUS có paymentStatus. title chỉ để hiển thị, client không đọc mã từ title.
 */
export interface Notification {
  id: string;
  recipientId: string;
  type: NotificationType;
  sourceEventId: string;
  tripId: string;
  title: string;
  read: boolean;
  /** Chỉ OFFER còn hạn, chuyến chưa có tài xế và chưa kết thúc mới là true. */
  actionable: boolean;
  createdAt: string;
  offer?: Offer;
  pickup?: Point;
  dropoff?: Point;
  amount?: MoneyAmount;
  currency?: Currency;
  tripStatus?: TripStatus;
  paymentStatus?: PaymentStatus;
}

/** GET /api/v1/notifications; nextCursor là chuỗi mờ, bỏ field khi hết dữ liệu. */
export interface NotificationsPage {
  items: Notification[];
  nextCursor?: string;
}

/** PATCH /api/v1/notifications/{notificationId}/read */
export interface ReadNotificationRequest {
  read: true;
}
