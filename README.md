# DS03 - Ride-hailing NestJS monorepo

Khung chạy NestJS cho API Gateway và 7 service nghiệp vụ mô phỏng Grab/Uber.
Giữ cấu trúc `src/apps`, `src/services`, `src/packages` của dự án.
Nest CLI quản lý ứng dụng qua `nest-cli.json`; dependency và lockfile dùng chung
tại root, không cần `npm install` trong từng service.

## Chạy nhanh

Yêu cầu Node.js >= 22 (khuyến nghị Node.js 24 LTS) và npm.
Chạy tại thư mục gốc repository:

```powershell
npm ci
Copy-Item .env.example .env
npm run dev:api-gateway
```

Chỉ copy `.env` lần đầu; giữ lại cấu hình nếu file đã tồn tại.
`dev:api-gateway` chạy Gateway tại `http://127.0.0.1:8080`, tự build lại khi sửa code.
Không cần cài Nest CLI toàn cục. Nếu chưa có `.env`, ứng dụng dùng port mặc định.

Kiểm tra bằng PowerShell hoặc mở URL trong trình duyệt:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health/live
Invoke-RestMethod http://127.0.0.1:8080/health/ready
```

## Lệnh chạy

| Gateway / service | Lệnh chạy dev riêng | Port mặc định | Biến môi trường |
| --- | --- | ---: | --- |
| api-gateway | `npm run dev:api-gateway` | 8080 | GATEWAY_PORT |
| identity-user-service | `npm run dev:identity-user-service` | 3001 | IDENTITY_PORT |
| driver-vehicle-location-service | `npm run dev:driver-vehicle-location-service` | 3002 | DRIVER_PORT |
| trip-booking-service | `npm run dev:trip-booking-service` | 3003 | TRIP_PORT |
| simulated-payment-service | `npm run dev:simulated-payment-service` | 3004 | PAYMENT_PORT |
| notification-service | `npm run dev:notification-service` | 3005 | NOTIFICATION_PORT |
| matching-service | `npm run dev:matching-service` | 3006 | MATCHING_PORT |
| pricing-service | `npm run dev:pricing-service` | 3007 | PRICING_PORT |

Port trong bảng theo mục 3.1 của báo cáo BA. Mỗi entrypoint dùng đúng biến port
của ứng dụng đó qua runtime chung; khi dev riêng, chạy lệnh trong bảng tại root.
File `.env` ở root dùng cho local dev và được Git bỏ qua. Nếu đổi port trong `.env`,
dừng rồi chạy lại service. Biến môi trường đã đặt trong terminal được ưu tiên hơn `.env`.

Trong `package.json`, mỗi Gateway/service có một nhóm 4 script riêng,
dùng đúng tên thư mục và tên project trong `nest-cli.json`:

- `build:<tên-project>`: build ứng dụng.
- `start:<tên-project>`: build rồi chạy ứng dụng.
- `dev:<tên-project>`: build, chạy và theo dõi thay đổi.
- `prod:<tên-project>`: chạy bundle đã build.

Ví dụ nhóm API Gateway:

```powershell
npm run build:api-gateway
npm run start:api-gateway
npm run dev:api-gateway
npm run prod:api-gateway
```

Các lệnh trên là những cách chạy riêng; chọn lệnh cần dùng.
Muốn dev nhiều service thì mở terminal riêng cho mỗi service, đều tại thư mục gốc.
`start` build rồi chạy một lần; `dev` theo dõi thay đổi; `prod` chạy bundle đã build.
Ví dụ với service nghiệp vụ:

```powershell
npm run dev:identity-user-service
npm run build:trip-booking-service
npm run prod:trip-booking-service
```

Các lệnh ngắn cũ (`dev:identity`, `dev:trip`, `dev:gateway`, ...)
được giữ ở nhóm alias cuối phần `scripts` và gọi tới script tên đầy đủ tương ứng.
`npm start`, `npm run start:dev`, `npm run start:prod` vẫn chạy API Gateway.

Chạy toàn bộ 8 ứng dụng, mỗi ứng dụng là một process riêng:

```powershell
# Build và chạy một lần
npm run start:all

# Build và theo dõi thay đổi
npm run start:dev:all

# Chạy bundle sau khi build
npm run build:all
npm run start:prod:all
```

Dừng bằng `Ctrl+C`. Các lệnh chạy toàn bộ dùng `concurrently`; nếu một ứng dụng dừng,
các ứng dụng còn lại cũng được dừng để tránh sót process.
Không chạy nhiều nhóm lệnh trên cùng bộ port.
`HOST` mặc định là `127.0.0.1`; đặt `HOST=0.0.0.0` khi chạy trong container.

## Cấu trúc

```text
.
├── package.json / package-lock.json  # Dependency và lệnh npm dùng chung
├── nest-cli.json                     # 8 application + thư viện Nest
├── tsconfig.json                     # TypeScript strict, decorator, alias
├── webpack.config.js                 # Đồng bộ output.path với tsconfig.outDir
├── .env.example
├── src/
│   ├── apps/api-gateway/
│   │   ├── tsconfig.app.json
│   │   └── src/app.module.ts, main.ts
│   ├── services/<service-name>/
│   │   ├── tsconfig.app.json
│   │   ├── src/app.module.ts, main.ts
│   │   ├── src/controllers/, domain/, use-cases/, repositories/, ...
│   │   ├── migrations/
│   │   └── tests/unit/, integration/
│   └── packages/
│       ├── contracts/               # @app/contracts: hợp đồng health
│       ├── shared-types/            # @app/shared-types: tên và port service
│       ├── runtime/                 # @app/runtime: bootstrap, config, health
│       ├── logger/                  # Dự phòng, chưa triển khai
│       └── messaging/               # Dự phòng, chưa triển khai
├── scripts/development/build-all.cjs
├── tests/functional/startup.test.cjs
├── dist/<service-name>/main.js       # Sinh khi build, không commit
├── deploy/
├── clients/
└── docs/
```

Mỗi service có `AppModule` riêng. Đặt Controller/Provider/Module nghiệp vụ trong service
và đăng ký qua `imports`, `controllers`, `providers` của module.
Các thư mục nghiệp vụ hiện có được giữ để tiếp tục triển khai.
Ví dụ tạo module bằng CLI tại root:

```powershell
npx nest generate module users --project identity-user-service
npx nest generate controller users --project identity-user-service --no-spec
npx nest generate service users --project identity-user-service --no-spec
```

Runtime dùng `@nestjs/config` đọc `.env`, bật graceful shutdown và `ValidationPipe`
(`whitelist`, `forbidNonWhitelisted`, `transform`). Body JSON giới hạn 64 KiB.
API nghiệp vụ có prefix `/api/v1`; hai endpoint health nằm ngoài prefix.
Webpack đóng gói alias thư viện vào `dist/<service-name>/main.js`,
không cần build thư viện riêng để chạy app.
Chỉ chia sẻ contract và tiện ích; không import repository/entity của service khác.

## Kiểm tra

```powershell
npm run typecheck
npm test
```

`npm test` build cả 8 ứng dụng rồi kiểm tra chúng chạy đồng thời trên port tạm:
health live/ready, định danh instance riêng, endpoint chưa triển khai trả 404,
và port sai khiến startup thất bại với thông báo rõ ràng.
`npm run test:smoke` kiểm tra các bundle đã build.

## Phạm vi hiện tại

Đây là bộ khung NestJS có thể build/chạy. API đặt xe, JWT, proxy Gateway,
PostgreSQL, RabbitMQ, Redis, Saga, migration, seed và Docker Compose chưa triển khai.
Biến DB/broker trong `.env.example` được giữ cho bước tích hợp tiếp theo, chưa được sử dụng.
`/health/ready` hiện phản ánh readiness của bộ khung không có dependency bên ngoài;
khi tích hợp DB/broker cần bổ sung kiểm tra dependency và trả 503 khi chưa sẵn sàng.
