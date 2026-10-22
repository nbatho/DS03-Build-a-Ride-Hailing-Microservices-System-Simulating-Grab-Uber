import type {
  Notification as NotificationDto,
  NotificationType,
  PaymentStatus,
  RideEvent,
  TripStatus,
} from '@app/contracts';

// Quy tắc của Notification (BA mục 8.3, Phụ lục C), tách khỏi DB để test được:
// từ bản sao trạng thái chuyến + một sự kiện -> bản sao mới + các thông báo cần tạo.

export const NOTIFICATION_EVENT_TYPES = [
  'matching.offer.created',
  'trip.no_driver',
  'trip.accepted',
  'trip.started',
  'trip.completed',
  'trip.cancelled',
  'payment.succeeded',
  'payment.failed',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationEvent = RideEvent<NotificationEventType>;

export type TerminalState = 'COMPLETED' | 'CANCELLED' | 'NO_DRIVER';

export interface TripProjectionState {
  tripId: string;
  /** 0 khi chưa nhận sự kiện nào của Trip. */
  tripVersion: number;
  tripStatus: TripStatus | null;
  terminalState: TerminalState | null;
  terminalEventId: string | null;
  knownDriverIds: string[];
  passengerId: string | null;
  paymentId: string | null;
  /** Dãy phiên bản riêng của thanh toán, không so với tripVersion. */
  paymentVersion: number;
  paymentStatus: PaymentStatus | 'NOT_REQUESTED' | null;
}

export interface NewNotification {
  recipientId: string;
  /** Cùng (recipientId, sourceEventId, type) thì không tạo lần hai. */
  sourceEventId: string;
  tripId: string;
  type: NotificationType;
  title: string;
  payload: Record<string, unknown>;
}

export interface ApplyResult {
  projection: TripProjectionState;
  notifications: NewNotification[];
}

export function emptyProjection(tripId: string): TripProjectionState {
  return {
    tripId,
    tripVersion: 0,
    tripStatus: null,
    terminalState: null,
    terminalEventId: null,
    knownDriverIds: [],
    passengerId: null,
    paymentId: null,
    paymentVersion: 0,
    paymentStatus: null,
  };
}

/** Mã chuyến của sự kiện (offer.created mang tripId trong offer). */
export function tripIdOf(event: NotificationEvent): string {
  return event.type === 'matching.offer.created' ? event.payload.offer.tripId : event.payload.tripId;
}

const TRIP_TITLES: Record<TripStatus, string> = {
  MATCHING: 'Đang tìm tài xế',
  ASSIGNING: 'Đang xác nhận tài xế',
  ASSIGNED: 'Đã có tài xế nhận chuyến',
  IN_PROGRESS: 'Chuyến đi đã bắt đầu',
  COMPLETED: 'Chuyến đi đã hoàn thành',
  CANCELLING: 'Chuyến đi đang được hủy',
  CANCELLED: 'Chuyến đi đã bị hủy',
  NO_DRIVER: 'Không tìm được tài xế',
};

const PAYMENT_TITLES: Record<PaymentStatus, string> = {
  PENDING: 'Đang xử lý thanh toán',
  SUCCEEDED: 'Thanh toán thành công',
  FAILED: 'Thanh toán thất bại',
};

const TERMINAL: Partial<Record<TripStatus, TerminalState>> = {
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_DRIVER: 'NO_DRIVER',
};

function unique(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

function tripStatusNotification(
  recipientId: string,
  sourceEventId: string,
  tripId: string,
  status: TripStatus,
): NewNotification {
  return {
    recipientId,
    sourceEventId,
    tripId,
    type: 'TRIP_STATUS',
    title: TRIP_TITLES[status],
    payload: { tripStatus: status },
  };
}

export function applyEvent(current: TripProjectionState, event: NotificationEvent): ApplyResult {
  switch (event.type) {
    case 'matching.offer.created':
      return applyOffer(current, event);
    case 'payment.succeeded':
    case 'payment.failed':
      return applyPayment(current, event);
    default:
      return applyTripStatus(current, event);
  }
}

function applyOffer(current: TripProjectionState, event: RideEvent<'matching.offer.created'>): ApplyResult {
  const { offer, pickup, dropoff, amount, currency } = event.payload;
  const projection = { ...current, knownDriverIds: unique([...current.knownDriverIds, offer.driverId]) };
  // Lời mời luôn được lưu để tài xế thấy; nhận được hay không tính lúc đọc (isActionable).
  const notifications: NewNotification[] = [
    {
      recipientId: offer.driverId,
      sourceEventId: event.event_id,
      tripId: offer.tripId,
      type: 'OFFER',
      title: 'Có đề nghị nhận chuyến',
      payload: { offer, pickup, dropoff, amount, currency },
    },
  ];

  // "Chuyến bị hủy" đến trước lời mời: báo hủy cho tài xế vừa biết, không trùng theo người nhận + sự kiện hủy.
  if (current.terminalState === 'CANCELLED' && current.terminalEventId) {
    notifications.push(
      tripStatusNotification(offer.driverId, current.terminalEventId, offer.tripId, 'CANCELLED'),
    );
  }

  return { projection, notifications };
}

function applyTripStatus(
  current: TripProjectionState,
  event: RideEvent<'trip.no_driver' | 'trip.accepted' | 'trip.started' | 'trip.completed' | 'trip.cancelled'>,
): ApplyResult {
  const payload = event.payload;

  // Phiên bản cũ hơn hoặc bằng bản đã biết: không hiển thị trạng thái cũ.
  if (payload.tripVersion <= current.tripVersion) {
    return { projection: current, notifications: [] };
  }

  let status: TripStatus;
  let recipients: string[];
  let knownDriverIds = current.knownDriverIds;

  switch (event.type) {
    case 'trip.no_driver':
      status = 'NO_DRIVER';
      recipients = [event.payload.passengerId];
      break;
    case 'trip.cancelled':
      status = 'CANCELLED';
      knownDriverIds = unique([...knownDriverIds, ...event.payload.affectedDriverIds]);
      // Khách + tài xế do Trip gửi kèm + tài xế từng nhận lời mời theo bản sao; không gửi cho tất cả.
      recipients = unique([event.payload.passengerId, ...knownDriverIds]);
      break;
    default:
      status = event.payload.status;
      knownDriverIds = unique([...knownDriverIds, event.payload.driverId]);
      recipients = unique([event.payload.passengerId, event.payload.driverId]);
  }

  const terminal = TERMINAL[status] ?? null;
  const projection: TripProjectionState = {
    ...current,
    tripVersion: payload.tripVersion,
    tripStatus: status,
    passengerId: payload.passengerId,
    knownDriverIds,
    terminalState: terminal ?? current.terminalState,
    terminalEventId: terminal ? event.event_id : current.terminalEventId,
  };

  return {
    projection,
    notifications: recipients.map(recipient =>
      tripStatusNotification(recipient, event.event_id, payload.tripId, status),
    ),
  };
}

function applyPayment(
  current: TripProjectionState,
  event: RideEvent<'payment.succeeded' | 'payment.failed'>,
): ApplyResult {
  const payload = event.payload;

  // Thành công là trạng thái cuối; kết quả cũ hơn không ghi đè và không được hiển thị.
  if (payload.paymentVersion <= current.paymentVersion || current.paymentStatus === 'SUCCEEDED') {
    return { projection: current, notifications: [] };
  }

  const status: PaymentStatus = event.type === 'payment.succeeded' ? 'SUCCEEDED' : 'FAILED';

  return {
    projection: {
      ...current,
      paymentId: payload.paymentId,
      paymentVersion: payload.paymentVersion,
      paymentStatus: status,
      passengerId: current.passengerId ?? payload.passengerId,
    },
    notifications: [
      {
        recipientId: payload.passengerId,
        sourceEventId: event.event_id,
        tripId: payload.tripId,
        type: 'PAYMENT_STATUS',
        title: PAYMENT_TITLES[status],
        payload: {
          paymentStatus: status,
          paymentId: payload.paymentId,
          attemptNo: payload.attemptNo,
          ...(event.type === 'payment.failed' ? { retryable: event.payload.retryable } : {}),
        },
      },
    ],
  };
}

/** Trạng thái chuyến mà từ đó lời mời cũ không còn nhận được. */
const OFFER_CLOSED_STATUSES: ReadonlySet<TripStatus> = new Set([
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLING',
  'CANCELLED',
  'NO_DRIVER',
]);

/**
 * Lời mời nhận được khi: còn hạn, chuyến chưa kết thúc và chưa có tài xế. Bản sao có thể trễ,
 * nên API nhận chuyến ở Trip vẫn kiểm tra trạng thái thật.
 */
export function isActionable(
  type: NotificationType,
  payload: Record<string, unknown>,
  projection: Pick<TripProjectionState, 'terminalState' | 'tripStatus'> | null,
  now: Date,
): boolean {
  if (type !== 'OFFER') {
    return false;
  }

  const offer = payload.offer as { expiresAt?: string; status?: string } | undefined;

  if (!offer?.expiresAt || offer.status !== 'OPEN' || Date.parse(offer.expiresAt) <= now.getTime()) {
    return false;
  }

  if (projection?.terminalState) {
    return false;
  }

  return !(projection?.tripStatus && OFFER_CLOSED_STATUSES.has(projection.tripStatus));
}

export interface StoredNotification {
  id: string;
  recipientId: string;
  sourceEventId: string;
  tripId: string;
  type: NotificationType;
  title: string;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

/** Dựng DTO theo đúng biến thể: chỉ đưa field của loại thông báo đó. */
export function toNotificationDto(
  row: StoredNotification,
  projection: Pick<TripProjectionState, 'terminalState' | 'tripStatus'> | null,
  now: Date,
): NotificationDto {
  const base: NotificationDto = {
    id: row.id,
    recipientId: row.recipientId,
    type: row.type,
    sourceEventId: row.sourceEventId,
    tripId: row.tripId,
    title: row.title,
    read: row.readAt !== null,
    actionable: isActionable(row.type, row.payload, projection, now),
    createdAt: row.createdAt.toISOString(),
  };
  const p = row.payload;

  if (row.type === 'OFFER') {
    return {
      ...base,
      offer: p.offer as NotificationDto['offer'],
      pickup: p.pickup as NotificationDto['pickup'],
      dropoff: p.dropoff as NotificationDto['dropoff'],
      amount: p.amount as string,
      currency: p.currency as NotificationDto['currency'],
    };
  }

  if (row.type === 'TRIP_STATUS') {
    return { ...base, tripStatus: p.tripStatus as TripStatus };
  }

  return { ...base, paymentStatus: p.paymentStatus as PaymentStatus };
}
