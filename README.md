# DS03 - Ride-hailing NestJS monorepo

API Gateway và 7 service nghiệp vụ chạy độc lập bằng NestJS. Nest CLI quản lý app
qua `nest-cli.json`; dependency và lockfile dùng chung tại root.

## Chạy nhanh

Yêu cầu Node.js >= 22 và npm. Chạy tại thư mục gốc:

```powershell
npm ci
# Chỉ tạo .env lần đầu
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run dev:api-gateway
```

Kiểm tra Gateway:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health/live
Invoke-RestMethod http://127.0.0.1:8080/health/ready
```

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
└── docs/tasks/
    ├── A.md
    ├── B.md
    └── C.md
```

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

`npm test` build cả 8 app rồi chạy smoke test: startup đồng thời trên port tạm,
health, instance ID riêng, route chưa triển khai trả 404 và port sai bị chặn.
`npm run test:smoke` chạy test với các bundle đã build.

Hiện có bộ khung NestJS và module nghiệp vụ. JWT, API đặt xe, proxy Gateway,
PostgreSQL, RabbitMQ, Saga, migration, seed và Compose cần triển khai tiếp.
`.env.example` chỉ giữ biến đang được runtime đọc; thêm DB/broker env cùng
implementation tương ứng. `/health/ready` hiện phản ánh bộ khung; bổ sung
dependency checks và 503 khi app bắt đầu dùng DB/broker.

Phân công theo BA:

- [A: Identity, JWT và Trip/Saga](docs/tasks/A.md).
- [B: Driver, Matching và Pricing](docs/tasks/B.md).
- [C: Payment, Notification, messaging, Gateway và Compose](docs/tasks/C.md).

Mỗi owner tự làm migration, Dockerfile và test cho service mình; C tích hợp
môi trường chung. Checklist trong ba file là việc cần làm, chưa phải tính năng
đã hoàn thành.
