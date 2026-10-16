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

export const PUBLIC_ROUTE_METADATA = 'ds03.public';
