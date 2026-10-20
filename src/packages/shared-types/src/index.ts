export const SERVICE_CONFIG = {
  'api-gateway': { portEnv: 'GATEWAY_PORT', defaultPort: 8080 },
  'identity-user-service': { portEnv: 'IDENTITY_PORT', defaultPort: 3001 },
  'driver-vehicle-location-service': { portEnv: 'DRIVER_PORT', defaultPort: 3002 },
  'trip-booking-service': { portEnv: 'TRIP_PORT', defaultPort: 3003 },
  'simulated-payment-service': { portEnv: 'PAYMENT_PORT', defaultPort: 3004 },
  'notification-service': { portEnv: 'NOTIFICATION_PORT', defaultPort: 3005 },
  'matching-service': { portEnv: 'MATCHING_PORT', defaultPort: 3006 },
  'pricing-service': { portEnv: 'PRICING_PORT', defaultPort: 3007 },
} as const;

export type ServiceName = keyof typeof SERVICE_CONFIG;

// Tên bên gọi/bên nhận trong token nội bộ SVC_TOKEN_<BÊN GỌI>_<BÊN NHẬN> (BA mục 9.2, 11.2).
// OPS là người vận hành, không phải service; Gateway không gọi API nội bộ nên không có tên.
export const INTERNAL_CALLERS = [
  'IDENTITY', 'DRIVER', 'TRIP', 'PAYMENT', 'NOTIFICATION', 'MATCHING', 'PRICING', 'OPS',
] as const;

export type InternalCaller = (typeof INTERNAL_CALLERS)[number];

export const SERVICE_CALLER_NAME: Record<ServiceName, InternalCaller | undefined> = {
  'api-gateway': undefined,
  'identity-user-service': 'IDENTITY',
  'driver-vehicle-location-service': 'DRIVER',
  'trip-booking-service': 'TRIP',
  'simulated-payment-service': 'PAYMENT',
  'notification-service': 'NOTIFICATION',
  'matching-service': 'MATCHING',
  'pricing-service': 'PRICING',
};

export const PUBLIC_ROUTE_METADATA = 'ds03.public';
