# DSP03 - Khung thư mục mới

Các folder được tạo trực tiếp tại repository mới. .gitkeep giúp Git ghi nhận các thư mục trống. Chưa có code, migration, test thực thi hoặc cấu hình triển khai.

```text
.
├── README.md
├── .env.example
├── src/
│   ├── apps/api-gateway/
│   ├── services/
│   │   ├── identity-user-service/
│   │   ├── driver-vehicle-location-service/
│   │   ├── matching-service/
│   │   ├── trip-booking-service/
│   │   ├── simulated-payment-service/
│   │   └── notification-service/
│   └── packages/
│       ├── contracts/src/dtos/ và events/
│       ├── logger/src/
│       └── shared-types/src/
├── deploy/                       # docker, postgres/init, rabbitmq, redis, secrets
├── tests/                        # functional, concurrency, fault-tolerance, security, performance
├── scripts/                      # development, deployment, simulation, seed, fault-injection
├── docs/                         # api, architecture, database, deployment, demo-scenarios, reports
├── clients/                      # customer-simulator, driver-simulator, load-generator
└── .github/workflows/
```

Mỗi service có src/config, controllers, routes, domain, use-cases, repositories, events, producers, consumers; migrations; tests/unit và tests/integration.

| Thành phần | Port dự kiến | Schema dự kiến |
|---|---:|---|
| Identity/User | 3001 | identity_schema |
| Driver/Vehicle/Location | 3002 | driver_schema |
| Matching | 3006 | matching_schema |
| Trip/Booking/Pricing/Saga | 3003 | trip_schema |
| Simulated Payment | 3004 | payment_schema |
| Notification | 3005 | notification_schema |
| API Gateway | 8080 | Không có DB nghiệp vụ |

Gateway không tính vào 6 service nghiệp vụ. Pricing thuộc Trip; Matching là service độc lập. Khi triển khai, mỗi service dùng role/schema riêng và trao đổi qua REST/event.

Root src/, deploy/, tests/, scripts/, docs/, README.md, .env.example theo mục 10.1 của đề. Phần cần bổ sung: entrypoint/manifest, API/contract, migration, Dockerfile/Compose, scripts, test và bằng chứng thực tế.

Khi bàn giao cần docs/report.pdf; bổ sung docs/slides.pdf nếu có slide. Không tạo PDF rỗng thay cho báo cáo.
