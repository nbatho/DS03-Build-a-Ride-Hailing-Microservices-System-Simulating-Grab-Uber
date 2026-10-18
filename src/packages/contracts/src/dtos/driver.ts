import type { Point, VehicleType, ZoneId } from './common';

export const DRIVER_STATUSES = ['AVAILABLE', 'OFFLINE', 'RESERVED', 'BUSY'] as const;
export type DriverStatus = typeof DRIVER_STATUSES[number];

export const RESERVATION_STATUSES = ['HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED'] as const;
export type ReservationStatus = typeof RESERVATION_STATUSES[number];

export const RELEASE_REASONS = ['ASSIGNMENT_FAILED', 'TRIP_CANCELLED', 'TRIP_COMPLETED'] as const;
export type ReleaseReason = typeof RELEASE_REASONS[number];

// Hồ sơ: PUT/GET /api/v1/drivers/me. driverId = JWT sub của tài khoản DRIVER.

export interface DriverProfileRequest {
  /** 3–40 ký tự. */
  licenseNumber: string;
}

export interface DriverProfile {
  driverId: string;
  licenseNumber: string;
  online: boolean;
  status: DriverStatus;
  locationFresh: boolean;
  /** 0 khi chưa có GPS. */
  locationSequence: number;
  version: number;
}

// Xe: POST /api/v1/vehicles (bắt buộc Idempotency-Key, 201), GET /api/v1/vehicles/me.

export interface VehicleRequest {
  /** 3–20 ký tự; server chuẩn hóa uppercase, không trùng. */
  plateNumber: string;
  /** 1–80 ký tự. */
  model: string;
  /** 1–30 ký tự. */
  color: string;
}

export interface Vehicle {
  id: string;
  driverId: string;
  plateNumber: string;
  model: string;
  color: string;
  vehicleType: VehicleType;
}

// Bật/tắt nhận chuyến: PATCH /api/v1/drivers/me/status (bắt buộc Idempotency-Key), trả DriverProfile.

export interface AvailabilityRequest {
  online: boolean;
  expectedVersion: number;
}

// GPS: PUT /api/v1/drivers/me/location.

export interface LocationRequest {
  position: Point;
  /** >= 1, tăng đơn điệu theo tài xế. */
  sequence: number;
  /** Giờ client; lệch quá 60 giây so với server thì bị từ chối. */
  recordedAt: string;
}

export interface Location {
  driverId: string;
  position: Point;
  sequence: number;
  recordedAt: string;
  /** Giờ server, dùng tính độ mới 60 giây. */
  receivedAt: string;
}

// Tìm ứng viên: GET /internal/v1/drivers/candidates (chỉ Matching gọi).

export interface CandidatesQuery {
  zoneId: ZoneId;
  /** 1–10. */
  limit?: number;
}

export interface Candidate {
  driverId: string;
  vehicleId: string;
  zoneId: ZoneId;
  locationSequence: number;
  locationReceivedAt: string;
}

export interface Candidates {
  /** Sắp theo driverId tăng dần. */
  items: Candidate[];
}

// Giữ xe: /internal/v1/reservations/{reservationId}, reservationId = assignmentId do Trip sinh.

/** PUT /internal/v1/reservations/{reservationId}. */
export interface ReservationRequest {
  tripId: string;
  driverId: string;
  offerId: string;
}

/** POST /internal/v1/reservations/{reservationId}/confirm. */
export interface ConfirmReservationRequest {
  commandId: string;
  tripId: string;
  driverId: string;
}

/** POST /internal/v1/reservations/{reservationId}/release. */
export interface ReleaseReservationRequest {
  commandId: string;
  tripId: string;
  driverId: string;
  reason: ReleaseReason;
}

export interface Reservation {
  id: string;
  tripId: string;
  driverId: string;
  /** Không có ở dấu "đã trả" tạo trước khi lệnh giữ xe đến. */
  offerId?: string;
  status: ReservationStatus;
  /** Chỉ có ở HELD; CONFIRMED không tự hết hạn. */
  expiresAt?: string;
  version: number;
}
