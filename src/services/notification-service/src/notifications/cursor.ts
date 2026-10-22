import { ApiError } from '@app/runtime';

// Con trỏ phân trang mờ (createdAt, id). createdAt giữ dạng chuỗi của PostgreSQL để không mất micro giây.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt, position.id])).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      !Number.isNaN(Date.parse(value[0])) &&
      typeof value[1] === 'string' &&
      UUID.test(value[1])
    ) {
      return { createdAt: value[0], id: value[1] };
    }
  } catch {
    // rơi xuống lỗi bên dưới
  }

  throw new ApiError(400, 'INVALID_CURSOR', 'cursor is not valid');
}
