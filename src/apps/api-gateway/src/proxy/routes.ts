// Danh sách đường public qua Gateway (BA mục 9.1, Phụ lục A, cột "Gateway: có").
// Chỉ đúng từng cặp method + đường dẫn ở đây được chuyển tiếp; mọi đường khác, kể cả /internal/..., bị chặn.

export const UPSTREAMS = {
  IDENTITY: { env: 'IDENTITY_BASE_URL', fallback: 'http://127.0.0.1:3001' },
  DRIVER: { env: 'DRIVER_BASE_URL', fallback: 'http://127.0.0.1:3002' },
  TRIP: { env: 'TRIP_BASE_URL', fallback: 'http://127.0.0.1:3003' },
  PAYMENT: { env: 'PAYMENT_BASE_URL', fallback: 'http://127.0.0.1:3004' },
  NOTIFICATION: { env: 'NOTIFICATION_BASE_URL', fallback: 'http://127.0.0.1:3005' },
  PRICING: { env: 'PRICING_BASE_URL', fallback: 'http://127.0.0.1:3007' },
} as const;
export type Upstream = keyof typeof UPSTREAMS;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface GatewayRoute {
  api: string;
  method: HttpMethod;
  /** Đường dẫn sau /api/v1, {id} là một đoạn mã (UUID do service phía sau kiểm tra). */
  path: string;
  upstream: Upstream;
  /** Không cần JWT: chỉ đăng ký và đăng nhập. */
  public?: boolean;
}

export const GATEWAY_ROUTES: readonly GatewayRoute[] = [
  { api: 'API-01', method: 'POST', path: '/auth/register', upstream: 'IDENTITY', public: true },
  { api: 'API-02', method: 'POST', path: '/auth/login', upstream: 'IDENTITY', public: true },
  { api: 'API-03', method: 'GET', path: '/users/me', upstream: 'IDENTITY' },
  { api: 'API-04', method: 'PUT', path: '/drivers/me', upstream: 'DRIVER' },
  { api: 'API-05', method: 'GET', path: '/drivers/me', upstream: 'DRIVER' },
  { api: 'API-06', method: 'POST', path: '/vehicles', upstream: 'DRIVER' },
  { api: 'API-07', method: 'GET', path: '/vehicles/me', upstream: 'DRIVER' },
  { api: 'API-08', method: 'PATCH', path: '/drivers/me/status', upstream: 'DRIVER' },
  { api: 'API-09', method: 'PUT', path: '/drivers/me/location', upstream: 'DRIVER' },
  { api: 'API-15', method: 'POST', path: '/quotes', upstream: 'PRICING' },
  { api: 'API-16', method: 'GET', path: '/quotes/{id}', upstream: 'PRICING' },
  { api: 'API-18', method: 'POST', path: '/trips', upstream: 'TRIP' },
  { api: 'API-19', method: 'GET', path: '/trips', upstream: 'TRIP' },
  { api: 'API-20', method: 'GET', path: '/trips/{id}', upstream: 'TRIP' },
  { api: 'API-21', method: 'POST', path: '/trips/{id}/accept', upstream: 'TRIP' },
  { api: 'API-22', method: 'POST', path: '/trips/{id}/reject', upstream: 'TRIP' },
  { api: 'API-23', method: 'POST', path: '/trips/{id}/cancel', upstream: 'TRIP' },
  { api: 'API-24', method: 'POST', path: '/trips/{id}/start', upstream: 'TRIP' },
  { api: 'API-25', method: 'POST', path: '/trips/{id}/complete', upstream: 'TRIP' },
  { api: 'API-26', method: 'GET', path: '/operations/{id}', upstream: 'TRIP' },
  { api: 'API-33', method: 'GET', path: '/payments/{id}', upstream: 'PAYMENT' },
  { api: 'API-34', method: 'GET', path: '/payments', upstream: 'PAYMENT' },
  { api: 'API-36', method: 'GET', path: '/notifications', upstream: 'NOTIFICATION' },
  { api: 'API-37', method: 'PATCH', path: '/notifications/{id}/read', upstream: 'NOTIFICATION' },
];

export const API_PREFIX = '/api/v1';

// Một đoạn mã: chữ, số, gạch ngang; không có '/', '%', '.' để không lách sang đường khác.
const ID_SEGMENT = '[A-Za-z0-9-]{1,64}';

const compiled = GATEWAY_ROUTES.map(route => ({
  route,
  pattern: new RegExp(
    '^' + API_PREFIX.replace(/\//g, '\\/') + route.path.replace(/\//g, '\\/').replace(/\{id\}/g, ID_SEGMENT) + '$',
  ),
}));

/** Tìm route khớp đúng method + pathname (không gồm query). */
export function matchRoute(method: string, pathname: string): GatewayRoute | undefined {
  return compiled.find(entry => entry.route.method === method && entry.pattern.test(pathname))?.route;
}

/** Có route cho pathname này với method khác: trả 405 thay vì 404. */
export function pathAllowsOtherMethod(pathname: string): boolean {
  return compiled.some(entry => entry.pattern.test(pathname));
}
