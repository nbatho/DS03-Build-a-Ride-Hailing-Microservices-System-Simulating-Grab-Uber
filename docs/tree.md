# DS03 - Cấu trúc NestJS monorepo

Repository đã có NestJS monorepo với API Gateway và 7 service chạy độc lập.
`nest-cli.json` quản lý ứng dụng; `package.json` và lockfile ở root dùng chung dependency.
Các thư mục nghiệp vụ trống được giữ bằng `.gitkeep`; migration và triển khai hạ tầng chưa có implementation.

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
│   ├── services/
│   │   ├── identity-user-service/
│   │   ├── driver-vehicle-location-service/
│   │   ├── matching-service/
│   │   ├── trip-booking-service/
│   │   ├── pricing-service/
│   │   ├── simulated-payment-service/
│   │   └── notification-service/
│   └── packages/
│       ├── contracts/src/dtos/ và events/
│       ├── logger/src/
│       ├── messaging/src/
│       ├── runtime/src/              # bootstrap, config, health
│       └── shared-types/src/
├── deploy/                       # docker, postgres/init, rabbitmq, redis, secrets
├── tests/                        # functional, concurrency, fault-tolerance, security, performance
├── scripts/                      # development, deployment, simulation, seed, fault-injection
├── docs/                         # api, architecture, database, deployment, demo-scenarios, reports
├── clients/                      # customer-simulator, driver-simulator, load-generator
└── .github/workflows/
```

Mỗi application có `src/main.ts`, `src/app.module.ts`, `tsconfig.app.json`.
Các thư viện đã triển khai (contracts, shared-types, runtime) có `tsconfig.lib.json`.
Mỗi service giữ src/config, controllers, routes, domain, use-cases, repositories, events,
producers, consumers; migrations; tests/unit và tests/integration để triển khai nghiệp vụ.
Nest dùng Controller cho routing; thư mục routes hiện chỉ là chỗ dự phòng.
Build tạo `dist/<application>/main.js`. Xem README cho lệnh build/start/watch/test.

| Thành phần | Port dự kiến | Schema dự kiến |
|---|---:|---|
| Identity/User | 3001 | identity_schema |
| Driver/Vehicle/Location | 3002 | driver_schema |
| Matching | 3006 | matching_schema |
| Trip/Booking/Saga | 3003 | trip_schema |
| Pricing (rates, surge) | 3007 | pricing_schema |
| Simulated Payment | 3004 | payment_schema |
| Notification | 3005 | notification_schema |
| API Gateway | 8080 | Không có DB nghiệp vụ |

Gateway không tính vào 7 service nghiệp vụ. Pricing và Matching là service độc lập.
Thiết kế dự kiến: Trip gọi Pricing qua REST (integrations/pricing), mỗi service dùng
role/schema riêng và trao đổi qua REST/event. Bộ khung hiện chưa kết nối các dependency này.

Root src/, deploy/, tests/, scripts/, docs/, README.md, .env.example được giữ nguyên.
Đã có entrypoint, cấu hình Nest/TypeScript, health contract, lệnh build/start và smoke test.
Phần cần bổ sung: API/event nghiệp vụ, migration, Dockerfile/Compose, seed/demo,
kiểm thử nghiệp vụ và bằng chứng tích hợp.

Khi bàn giao cần docs/report.pdf; bổ sung docs/slides.pdf nếu có slide. Không tạo PDF rỗng thay cho báo cáo.
