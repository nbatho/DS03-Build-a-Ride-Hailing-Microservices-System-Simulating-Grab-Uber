import { ApiResponse } from '@nestjs/swagger';

/** Documents the error envelope produced by the shared API exception filter. */
export function ApiIdentityError(status: number, code: string, message: string): MethodDecorator {
  return ApiResponse({
    status, description: code + ': ' + message,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        example: {
          code, message, correlationId: 'a5066e58-129d-4a9e-987c-722777c41a80',
          ...(status === 400 ? { details: ['Request phải đúng DTO; không nhận field hoặc query ngoài contract.'] } : {}),
        },
      },
    },
  });
}
