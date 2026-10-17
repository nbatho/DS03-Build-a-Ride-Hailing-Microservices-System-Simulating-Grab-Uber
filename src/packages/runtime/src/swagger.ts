import type { INestApplication } from '@nestjs/common';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject, type OperationObject } from '@nestjs/swagger';
import type { ServiceName } from '@app/shared-types';

// Webpack bundles this contract, so the runtime does not need to read files from disk.
const identityContract = require('../../../../docs/api/identity.openapi.json') as OpenAPIObject;
const errorSchema = { $ref: '#/components/schemas/Error' };
const jsonResponse = (description: string, schema = errorSchema) => ({
  description, content: { 'application/json': { schema } },
});

export function configureSwagger(app: INestApplication, serviceName: ServiceName): void {
  const identity = serviceName === 'api-gateway' || serviceName === 'identity-user-service';
  const config = new DocumentBuilder()
    .setTitle(serviceName === 'identity-user-service' ? 'Identity/User Service API' : 'DS03 Ride-hailing — ' + serviceName)
    .setVersion('1.0.0')
    .setDescription(
      'Test tay: đăng ký → đăng nhập → copy accessToken → Authorize (chỉ dán token) → gọi API cần JWT. ' +
      'Mỗi lần test đăng ký hãy dùng email mới. Đăng nhập giới hạn 10 lần/60 giây/IP. ' +
      'Tài liệu chỉ mô tả API hiện có của service này.',
    )
    .addServer('/', 'Service hiện tại (theo host/port đang mở)')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT RS256' }, 'bearerAuth')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const schemas = identityContract.components?.schemas ?? {};
  const identitySchemas = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, {
    ...schema, ...document.components?.schemas?.[name],
  }]));
  document.components = {
    ...document.components,
    schemas: {
      ...document.components?.schemas,
      ...(identity ? identitySchemas : { Error: schemas.Error }),
      HealthResponse: {
        type: 'object', additionalProperties: false,
        required: ['status', 'service', 'instanceId', 'checkedAt'],
        properties: {
          status: { type: 'string', enum: ['UP'] },
          service: { type: 'string', example: serviceName },
          instanceId: { type: 'string', format: 'uuid' },
          checkedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  };
  // Identity generates operations from its own DTO/controller decorators; Gateway uses the proxy contract.
  if (serviceName === 'api-gateway') {
    Object.assign(document.paths, structuredClone(identityContract.paths));
    for (const [route, path] of Object.entries(identityContract.paths)) {
      for (const method of ['get', 'post'] as const) {
        if (!path[method]) continue;
        const target = document.paths[route][method];
        if (target) Object.assign(target.responses, {
          '502': jsonResponse('BAD_GATEWAY: Identity không truy cập được hoặc trả response không hợp lệ.'),
          '504': jsonResponse('GATEWAY_TIMEOUT: Identity không phản hồi trong 10 giây.'),
        });
      }
    }
  }
  for (const endpoint of ['live', 'ready'] as const) {
    const operation: OperationObject = {
      operationId: 'health_' + endpoint, tags: ['Health'], security: [],
      summary: endpoint === 'live' ? 'Kiểm tra process đang chạy' : 'Kiểm tra service sẵn sàng',
      description: endpoint === 'ready'
        ? 'Identity kiểm tra kết nối DB và quyền đọc bảng users. Các service chưa có dependency dùng health của bộ khung.'
        : 'Liveness của process; không kiểm tra database.',
      responses: { '200': jsonResponse('Service đang UP.', { $ref: '#/components/schemas/HealthResponse' }) },
    };
    if (endpoint === 'ready') operation.responses['503'] = jsonResponse('NOT_READY: dependency chưa sẵn sàng.');
    document.paths['/health/' + endpoint] = { get: operation };
  }
  if (serviceName === 'driver-vehicle-location-service') {
    document.paths['/api/v1/drivers/me'] = { get: {
      operationId: 'driver_me', tags: ['Driver'], security: [{ bearerAuth: [] }],
      summary: 'Kiểm tra JWT và quyền DRIVER',
      description: 'Dùng token nhận từ Identity/Gateway. PASSENGER nhận 403. DRIVER hợp lệ nhận 404 DRIVER_NOT_ONBOARDED vì hồ sơ tài xế chưa triển khai.',
      responses: {
        '401': jsonResponse('INVALID_TOKEN: thiếu JWT, JWT sai hoặc hết hạn.'),
        '403': jsonResponse('ROLE_FORBIDDEN: JWT không có role DRIVER.'),
        '404': jsonResponse('DRIVER_NOT_ONBOARDED: JWT DRIVER hợp lệ, chưa có hồ sơ tài xế.'),
      },
    } };
  }
  for (const path of Object.values(document.paths)) {
    for (const method of ['get', 'post'] as const) {
      const operation = path[method];
      if (!operation) continue;
      const errors: Record<string, string> = {
        '400': 'VALIDATION_ERROR: dữ liệu không hợp lệ, field/query ngoài DTO hoặc X-Correlation-Id sai.',
        '401': operation.operationId === 'API-02'
          ? 'INVALID_CREDENTIALS: email hoặc password sai.'
          : 'INVALID_TOKEN: thiếu JWT, JWT sai, hết hạn hoặc user không tồn tại.',
        '409': 'EMAIL_EXISTS: email đã được đăng ký (không phân biệt chữ hoa/thường).',
        '413': 'PAYLOAD_TOO_LARGE: JSON body vượt quá 64 KiB.',
        '429': 'RATE_LIMITED: vượt quá 10 lần đăng nhập/60 giây/IP.',
        '503': 'DEPENDENCY_UNAVAILABLE: database Identity không truy cập được.',
      };
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response && 'description' in response && response.description === 'Error') response.description = errors[status] ?? 'Lỗi API.';
      }
      operation.parameters = [...(operation.parameters ?? []), {
        in: 'header', name: 'X-Correlation-Id', required: false,
        description: 'UUID tùy chọn để theo dõi request; bỏ trống để server tự sinh.',
        schema: { type: 'string', format: 'uuid' },
      }];
      operation.responses['400'] ??= jsonResponse('VALIDATION_ERROR: dữ liệu hoặc X-Correlation-Id không hợp lệ.');
    }
  }
  SwaggerModule.setup('docs', app, document, {
    // Resolve UI files at runtime even when Swagger itself is bundled by Webpack.
    customSwaggerUiPath: dirname(createRequire(createRequire(__filename).resolve('@nestjs/swagger')).resolve('swagger-ui-dist/package.json')),
    jsonDocumentUrl: '/docs-json', yamlDocumentUrl: '/docs-yaml',
    customSiteTitle: 'DS03 API Docs — ' + serviceName,
    swaggerOptions: { persistAuthorization: false, displayRequestDuration: true, defaultModelsExpandDepth: 1 },
  });
}
