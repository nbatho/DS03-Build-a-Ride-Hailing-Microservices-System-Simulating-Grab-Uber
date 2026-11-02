import type { Currency, MoneyAmount, Point } from './common';

/** POST /api/v1/quotes (bắt buộc Idempotency-Key). Mã khách lấy từ JWT, không gửi trong body. */
export interface QuoteRequest {
  pickup: Point;
  dropoff: Point;
  /** 1–100000 mét, dữ liệu mô phỏng. */
  distanceMeters: number;
  /** 1–14400 giây, dữ liệu mô phỏng. */
  durationSeconds: number;
}

/**
 * Trả về từ POST /api/v1/quotes (201), GET /api/v1/quotes/{quoteId}
 * và GET /internal/v1/quotes/{quoteId} (chỉ Trip gọi).
 */
export interface Quote {
  id: string;
  passengerId: string;
  pickup: Point;
  dropoff: Point;
  distanceMeters: number;
  durationSeconds: number;
  amount: MoneyAmount;
  currency: Currency;
  ruleVersion: string;
  /** Hạn 300 giây từ lúc tạo; báo giá hết hạn vẫn đọc được. */
  expiresAt: string;
}
