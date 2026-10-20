# DS03 - Ride-hailing NestJS monorepo

API Gateway và 7 service nghiệp vụ chạy độc lập bằng NestJS. Nest CLI quản lý app
qua `nest-cli.json`; dependency và lockfile dùng chung tại root.

## Chạy nhanh

Yêu cầu Node.js >=22, npm và Docker Desktop có Linux Engine hoạt động.
Hướng dẫn chi tiết: [Identity/User + JWT](docs/identity.md).

```powershell
npm ci
# Chỉ chạy setup khi chưa có .env; không ghi đè config/key hiện có.
npm run identity:setup:dev
npm run identity:db:up
npm run migration:identity:run
npm run identity:dev
```

Nhóm dev chạy Gateway :8081, Identity :3001 và Driver :3002. PostgreSQL riêng
của A ở 127.0.0.1:5541. Port theo .env; default của Gateway vẫn là 8080.

Trong terminal khác, chạy demo qua Gateway:

```powershell
npm run demo:identity
Invoke-RestMethod http://127.0.0.1:8081/health/live
Invoke-RestMethod http://127.0.0.1:3001/health/ready
```

Setup sinh credential/key local ngoài Git. Nếu đã có .env, bổ sung theo
.env.example và docs/identity.md; không chỉ copy placeholder rồi start.
Gateway/Driver cần public key; chỉ Identity đọc private key và DB của mình.

## Test tay API bằng Postman

Service không còn trang Swagger (`/docs`). Hợp đồng API là `openapi.json` trong báo cáo BA;
riêng Identity có bản trích ở [docs/api/identity.openapi.json](docs/api/identity.openapi.json).
Trong Postman chọn **Import** → file OpenAPI để có sẵn request, body mẫu và header cho mọi API.
Collection đã viết sẵn cho Identity/JWT: [tests/postman](tests/postman) (chạy bằng Collection Runner
hoặc Postman CLI khi các service đang chạy).

- API public: tab Authorization → Bearer Token, dán `accessToken` lấy từ đăng nhập.
- API nội bộ `/internal/v1/...`: thêm header `X-Service-Token` bằng giá trị `SVC_TOKEN_<BÊN GỌI>_<BÊN NHẬN>` trong `.env`.

## Dev từng service

Mỗi lệnh dev chạy trong terminal riêng, tại root:

| App | Lệnh dev | Port mặc định | Biến môi trường |
| --- | --- | ---: | --- |
| API Gateway | `npm run dev:api-gateway` | 8080 | GATEWAY_PORT |
| Identity/User | `npm run dev:identity-user-service` | 3001 | IDENTITY_PORT |
| Driver/Vehicle/Location | `npm run dev:driver-vehicle-location-service` | 3002 | DRIVER_PORT |
| Trip/Booking | `npm run dev:trip-booking-service` | 3003 | TRIP_PORT |
| Simulated Payment | `npm run dev:simulated-payment-service` | 3004 | PAYMENT_PORT |
| Notification | `npm run dev:notification-service` | 3005 | NOTIFICATION_PORT |
| Matching | `npm run dev:matching-service` | 3006 | MATCHING_PORT |
| Pricing | `npm run dev:pricing-service` | 3007 | PRICING_PORT |

Port theo báo cáo BA mục 3.1. Runtime đọc `.env` tại root, dùng port mặc định nếu
chưa cấu hình. Đổi port thì khởi động lại app; biến môi trường trong terminal được
ưu tiên hơn `.env`. `HOST` mặc định `127.0.0.1`, dùng `0.0.0.0` trong container.

Mỗi app có một nhóm script theo tên project đầy đủ:

- `build:<project>`: build bundle.
- `start:<project>`: build rồi chạy một lần.
- `dev:<project>`: build/chạy, theo dõi thay đổi.
- `prod:<project>`: chạy bundle đã build.

Ví dụ:

```powershell
npm run build:trip-booking-service
npm run prod:trip-booking-service
```

Các alias ngắn như `dev:trip`, `dev:identity` đã bỏ; dùng tên project trong bảng.
`npm start`, `npm run start:dev`, `npm run start:prod` mặc định chạy Gateway.

## Chạy toàn hệ thống

Chọn nhóm lệnh phù hợp:

```powershell
npm run start:all
npm run start:dev:all
# Chạy bundle sau khi build
npm run build:all
npm run start:prod:all
```

Mỗi app là một process riêng. `Ctrl+C` dừng nhóm; `concurrently` dừng cả nhóm
nếu một app thoát để tránh sót process. Mỗi bộ port chỉ chạy một nhóm tại một thời điểm.

## Cấu trúc hiện tại

```text
.
├── README.md
├── package.json / package-lock.json
├── nest-cli.json
├── tsconfig.json
├── webpack.config.js
├── .env.example
├── src/
│   ├── apps/api-gateway/
│   │   ├── tsconfig.app.json
│   │   └── src/                 # main.ts, app.module.ts, proxy/
│   ├── services/
│   │   ├── identity-user-service/
│   │   ├── driver-vehicle-location-service/
│   │   ├── trip-booking-service/
│   │   ├── simulated-payment-service/
│   │   ├── notification-service/
│   │   ├── matching-service/
│   │   └── pricing-service/
│   └── packages/
│       ├── contracts/           # Health DTO dùng chung
│       ├── shared-types/        # Tên service và cấu hình port
│       ├── runtime/             # Bootstrap, config, validation, health
│       └── messaging/src/       # Chuẩn bị cho RabbitMQ, chưa có implementation
├── deploy/
│   ├── postgres/init/
│   └── rabbitmq/
├── scripts/
│   ├── build-all.cjs
│   ├── seed/
│   └── simulation/
├── tests/
│   ├── startup.test.cjs
│   ├── end-to-end/
│   ├── concurrency/
│   ├── fault-tolerance/
│   ├── security/
│   ├── performance/
│   └── contract/
└── docs/                    # api/, plans/, services/, test-evidence/
```

Phân công và kế hoạch của A, B, C nằm trong báo cáo BA (mục 11), không còn file task riêng.

Mỗi service giữ `tsconfig.app.json`, `src/main.ts`, `src/app.module.ts` và
module nghiệp vụ đã tạo, gồm Controller/Service/Module. Ví dụ Identity có
`src/users/`, Trip có `src/trips/`.

Tổ chức code theo tính năng: DTO, entity, repository hoặc UseCase đặt trong
module liên quan. Đã tạo trước `dto/` và `entities/` trong module chính của mỗi
service, cùng `migrations/`, `tests/unit/` và `tests/integration/` ở cấp service.
Trip có thêm `src/trips/saga/`; Gateway có test riêng, không có entity/migration
vì không sở hữu DB nghiệp vụ.

Ví dụ Identity:

```text
identity-user-service/
├── tsconfig.app.json
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   └── users/
│       ├── users.module.ts
│       ├── users.controller.ts
│       ├── users.service.ts
│       ├── dto/
│       └── entities/
├── migrations/
└── tests/
    ├── unit/
    └── integration/
```

Các module chính là `users`, `drivers`, `trips`, `payments`, `notifications`,
`matching` và `pricing`. Entity/DTO được chia tiếp theo tính năng khi cần.

`src/packages/contracts/src/events/` dành cho event contract chung;
`src/packages/messaging/src/` dành cho kết nối/publish/consume/retry/DLQ.
Messaging hiện chỉ là thư mục dự phòng, chưa đăng ký library/alias hay kết nối
RabbitMQ. Thêm cấu hình library khi có implementation.

`deploy/postgres/init/` và `deploy/rabbitmq/` chứa bootstrap/cấu hình hạ tầng;
file Compose sẽ đặt trong `deploy/`, Dockerfile đặt trong từng app khi triển khai.
`scripts/seed/` và `scripts/simulation/` chứa tạo dữ liệu và simulator demo.
Test trong service kiểm tra riêng service; test ở root kiểm tra luồng liên thông,
concurrency, recovery, security, performance và contract của hệ thống.

Thư mục chuẩn bị trước chỉ chứa `.gitkeep` để Git giữ cấu trúc, chưa có nghiệp vụ
hay test thực thi. Giữ phần này ở phạm vi cần cho BA; repository/UseCase/worker
được tách khi implementation cần. Nest Controller đảm nhiệm routing nên không
thêm thư mục `routes` riêng.

Ví dụ tạo tính năng mới từ root:

```powershell
npx nest generate module locations --project driver-vehicle-location-service
npx nest generate controller locations --project driver-vehicle-location-service --no-spec
npx nest generate service locations --project driver-vehicle-location-service --no-spec
```

Runtime bật graceful shutdown, JSON limit 64 KiB và ValidationPipe
(`whitelist`, `forbidNonWhitelisted`, `transform`). Public API có prefix
`/api/v1`; health nằm ngoài prefix. Khi thêm API nội bộ phải cấu hình để giữ
`/internal/v1` đúng contract.

Webpack dùng `tsconfig.outDir`, đóng gói alias thư viện vào
`dist/<project>/main.js`. `dist` và `node_modules` là thư mục sinh tự động,
được Git bỏ qua. Chỉ chia sẻ contract/tiện ích; mỗi service quản lý dữ liệu riêng.

## Kiểm tra và phần việc tiếp theo

```powershell
npm run typecheck
npm test
```

`npm test` build 8 app và artifact migration, chạy smoke/integration với
PostgreSQL test container riêng, port/key tạm. `npm run test:identity:unit`
kiểm tra JWT/role/DTO. Docker Engine cần chạy cho integration/smoke.

Đã có register/login/me, bcrypt, JWT RS256, Guard dùng chung, PostgreSQL
Identity/migration, Gateway allowlist 3 route và Docker dev của A. Driver chỉ
tích hợp Guard; profile/onboarding của B chưa triển khai. Trip/Saga, RabbitMQ,
Payment/Notification/Matching/Pricing và Compose chung còn cần triển khai.

Identity readiness kiểm tra DB/bảng/quyền thật và trả 503 khi DB lỗi. Các service
chưa có dependency giữ health của bộ khung. Runtime có error/correlation chung;
route internal được giữ ngoài public prefix.

Phân công theo BA:

- A: [Identity/JWT đã triển khai](docs/identity.md), tiếp theo Trip/Saga.
- B: Driver, Matching và Pricing.
- C: Payment, Notification, messaging, mở rộng Gateway và Compose chung.

Mỗi owner tự làm migration, Dockerfile và test service mình; C tích hợp môi trường chung.
Bằng chứng Identity: docs/test-evidence/identity/. Chưa dùng kết quả này thay bộ test toàn hệ thống.

## DB của B (Driver, Matching, Pricing)

Mỗi service một PostgreSQL riêng chạy bằng Docker (BA mục 3.2). Service này không có
địa chỉ hay mật khẩu DB của service khác.

| Service | Container | Database | Cổng trên máy |
| --- | --- | --- | ---: |
| Driver/Vehicle/Location | `driver-db` | `driver_db` | 5542 |
| Matching | `matching-db` | `matching_db` | 5546 |
| Pricing | `pricing-db` | `pricing_db` | 5547 |

Lần đầu (cần Docker Desktop đang chạy và đã có `.env` từ `npm run identity:setup:dev`):

```powershell
npm run b:setup:dev       # ghi mật khẩu ngẫu nhiên và URL DB local vào .env, không in mật khẩu
npm run b:db:up           # bật 3 DB; user và schema tạo từ deploy/postgres/*-init.sql
npm run migration:b:run   # tạo bảng (pricing nạp luôn bảng giá CAR_V1)
npm run b:db:verify       # kiểm tra đúng DB, đủ bảng, quyền hẹp, không đăng nhập chéo được
```

Hằng ngày: `npm run b:db:start` / `npm run b:db:stop`, xem trạng thái bằng `npm run b:db:status`.
Thêm tên container để chỉ làm với một DB, ví dụ `npm run b:db:stop -- pricing-db`;
migration từng service: `npm run migration:driver:run`, kiểm tra một DB: `npm run b:db:verify -- driver`. Script không bao giờ xóa volume; muốn tạo lại một DB từ đầu thì
xóa volume của đúng DB đó (ví dụ `docker volume rm ds03-b-dev_pricing-db-data`) rồi `b:db:up` và migrate lại.

## Gọi API nội bộ: token `X-Service-Token`

API `/internal/v1/...` không dùng JWT người dùng. Bên gọi gửi header `X-Service-Token`; bên nhận
nhận ra bên gọi từ token (không tin header tên service tự khai) và chỉ cho bên trong danh sách
(BA mục 9.2, 11.2). Sai/thiếu token: 401, đúng token nhưng không được phép: 403, cùng mã
`INTERNAL_CALLER_FORBIDDEN`. Phần này có sẵn trong `@app/runtime` cho mọi service.

```powershell
npm run svc:tokens        # điền SVC_TOKEN_<BÊN GỌI>_<BÊN NHẬN> và <SERVICE>_BASE_URL vào .env, không in token
npm run test:runtime:unit # test guard và client
```

Bên nhận, khai danh sách bên được gọi ở class hoặc method (method ghi đè class):

```ts
import { CurrentCaller, InternalRoute } from '@app/runtime';
import type { InternalCaller } from '@app/shared-types';

@InternalRoute('MATCHING', 'DRIVER', 'PAYMENT')   // API-27
@Controller('internal/v1/trips')
export class TripsInternalController {
  @Get(':tripId')
  get(@Param('tripId') tripId: string, @CurrentCaller() caller: InternalCaller) { ... }
}
```

Route dưới `/internal/` mà quên `@InternalRoute` thì bị chặn với mọi bên gọi. Không cần thêm
guard vào module: `RuntimeModule.forRoot` đã đăng ký sẵn.

Bên gọi dùng `InternalHttpClient` (inject được ở mọi service). Client tự gắn token và
`X-Correlation-Id`, chờ 2 giây mỗi lần, và thử lại 502/503/504/mất kết nối tối đa 3 lần (nghỉ 0,5 giây rồi 1,5 giây,
BA mục 4.2). Chỉ thử lại khi `retry: true`, tức lệnh chống trùng được. 4xx trả về nguyên cho
bên gọi xử lý:

```ts
const res = await this.internal.request<QuoteForTrip>('PRICING', {
  method: 'GET', path: '/internal/v1/quotes/' + quoteId, correlationId: req.correlationId, retry: true,
});
if (res.status === 404) throw new ApiError(422, 'QUOTE_NOT_FOUND', '...');
```

Hết số lần thử thì client ném `InternalCallError` (503 `DEPENDENCY_UNAVAILABLE`). Nếu
`outcomeUnknown = true` thì request có thể đã được ghi: hỏi lại bằng cùng mã để đối soát,
không coi là thất bại chắc chắn.

Các cặp đang có (theo `x-callers` trong OpenAPI): Trip → Pricing, Driver, Matching, Payment;
Matching → Driver, Trip; Driver → Trip; Payment → Trip; OPS (người vận hành) → Trip. Thêm cặp mới thì sửa
`scripts/dev/service-tokens.cjs` và `.env.example`. Trong Compose (C), mỗi service chỉ nhận biến
token của cặp mà nó là bên gọi hoặc bên nhận. Gateway không có token nội bộ và không chuyển
tiếp header này từ client.

## Chống xử lý trùng và transaction tự thử lại

Có trong `@app/runtime` (BA mục 4.1). Code dùng chung, còn bảng nằm trong DB của từng service, cùng cấu trúc:
`<schema>.idempotency_keys` cho header `Idempotency-Key`, `<schema>.command_results` cho mã lệnh nội bộ
(xem migration của Driver). Test chạy trên PostgreSQL thật: `npm run test:runtime:db` (cần Docker).

| Hàm | Dùng khi | Gửi lặp cùng nội dung | Cùng mã, khác nội dung |
| --- | --- | --- | --- |
| `withIdempotencyKey` | API public có header `Idempotency-Key` | Trả lại đúng status và body đã lưu | 409 `IDEMPOTENCY_CONFLICT` |
| `withCommandResult` | API nội bộ có `commandId`, `reservationId` hoặc `assignmentId` | Như trên | 409 `PAYLOAD_MISMATCH` |
| `runInTransaction` | Mọi transaction có thể tranh khóa | Deadlock hoặc serialization thì chạy lại, tối đa 3 lần, hết lượt thì trả 503 | — |

```ts
@Post(':tripId/accept')
async accept(
  @Param('tripId') tripId: string, @Body() dto: AcceptTripRequest, @CurrentUser() actor: Actor,
  @IdempotencyKey() key: string, @Req() req: Request, @Res({ passthrough: true }) res: Response,
) {
  const result = await withIdempotencyKey(
    this.dataSource,
    { schema: 'trip_schema', actorId: actor.userId, method: req.method, path: req.path, key },
    dto,
    async manager => {
      // Đọc/ghi nghiệp vụ qua manager: cùng transaction với bản ghi chống trùng.
      return { status: 202, body: { operationId } };
    },
  );
  res.status(result.status);
  return result.body;
}
```

- `@IdempotencyKey()` đọc header bắt buộc; thiếu hoặc không phải UUID thì trả 400.
- Handler lỗi thì nghiệp vụ và bản ghi khóa cùng rollback, nên lần gửi lại chạy như mới. Chỉ kết quả thành công được lưu.
- Request trùng đến cùng lúc phải chờ request đầu xong, rồi nhận lại đúng kết quả của request đó.
- Handler có thể chạy lại khi gặp deadlock, nên **không gọi HTTP hay RabbitMQ bên trong**. Gọi service khác thì làm trước hoặc sau transaction; sự kiện thì ghi vào hàng chờ gửi (outbox) trong transaction.
- Bên nội bộ dùng `callerService` từ `@CurrentCaller()`, không lấy từ body.
- Bản ghi khóa giữ 24 giờ (`expires_at`). App không có quyền DELETE, nên việc dọn bản ghi cũ là job riêng, chưa có.

## Identity/User + JWT đã triển khai

Hướng dẫn setup PostgreSQL riêng, migration, key, API, Guard B/C, Docker và test: [docs/identity.md](docs/identity.md).

Chạy dev: `npm run identity:dev` sau setup/migration. Gateway dev dùng 8081; PostgreSQL riêng dùng 5541.

`npm test` dùng PostgreSQL test tạm riêng và kiểm tra Identity/JWT qua Gateway/Driver cùng smoke 8 app. Trip/Saga và nghiệp vụ B/C còn cần triển khai tiếp.
