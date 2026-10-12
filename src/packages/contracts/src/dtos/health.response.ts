export interface HealthResponse {
  status: 'UP' | 'DOWN';
  service: string;
  instanceId: string;
  checkedAt: string;
}
