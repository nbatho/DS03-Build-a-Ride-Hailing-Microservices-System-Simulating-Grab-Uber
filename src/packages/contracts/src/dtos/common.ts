// Kiểu dùng chung giữa Driver, Pricing, Trip và sự kiện (openapi: Point; BA mục 4.1, 15).
export const ZONE_IDS = ['ZONE_A', 'ZONE_B'] as const;
export type ZoneId = typeof ZONE_IDS[number];

export const VEHICLE_TYPES = ['CAR'] as const;
export type VehicleType = typeof VEHICLE_TYPES[number];

export const CURRENCIES = ['VND'] as const;
export type Currency = typeof CURRENCIES[number];

/** Số nguyên VND dạng chuỗi, 1–14 chữ số, ví dụ "41000". */
export type MoneyAmount = string;

export interface Point {
  lat: number;
  lng: number;
  zoneId: ZoneId;
}
