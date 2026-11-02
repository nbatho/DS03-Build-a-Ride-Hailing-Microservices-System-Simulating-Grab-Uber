// Cấu hình RabbitMQ (BA mục 9.2): địa chỉ (gồm vhost), số tin lấy trước (mẫu 10). Thiếu thì dừng khi khởi động.

export interface MessagingConfig {
  url: string;
  prefetch: number;
  /** Chờ RabbitMQ xác nhận một lần gửi tối đa bao lâu. */
  publishTimeoutMs: number;
}

export const MESSAGING_CONFIG = Symbol('MESSAGING_CONFIG');
export const DEFAULT_PREFETCH = 10;
export const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer');
  }

  return value;
}

export function loadMessagingConfig(env: NodeJS.ProcessEnv = process.env): MessagingConfig {
  const url = env.RABBITMQ_URL?.trim();

  if (!url) {
    throw new Error('RABBITMQ_URL is required');
  }

  if (!/^amqps?:\/\//.test(url)) {
    throw new Error('RABBITMQ_URL must start with amqp:// or amqps://');
  }

  return {
    url,
    prefetch: positiveInteger(env, 'RABBITMQ_PREFETCH', DEFAULT_PREFETCH),
    publishTimeoutMs: positiveInteger(
      env,
      'RABBITMQ_PUBLISH_TIMEOUT_MS',
      DEFAULT_PUBLISH_TIMEOUT_MS,
    ),
  };
}

/** Bỏ mật khẩu trước khi ghi log. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}
