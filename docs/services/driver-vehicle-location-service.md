# Driver / Vehicle / Location — phần B

Service chạy cổng 3002, sở hữu DB `driver_db`, schema `driver_schema`. Các bảng:
`drivers`, `vehicles`, `latest_locations`, `reservations`, `idempotency_keys`,
`command_results`. Không đọc DB của Identity, Trip hoặc Matching.

## API

| Mã | Method | Đường dẫn | Công việc |
| --- | --- | --- | --- |
| API-04 | PUT | `/api/v1/drivers/me` | Tạo/cập nhật giấy phép của tài xế từ JWT. Tạo mới mặc định offline; cập nhật không reset trạng thái. |
| API-05 | GET | `/api/v1/drivers/me` | Đọc hồ sơ, trạng thái thực tế, version và sequence GPS. |
| API-06 | POST | `/api/v1/vehicles` | Đăng ký một xe CAR/tài xế; biển số trim/uppercase, không trùng; trả 201. |
| API-07 | GET | `/api/v1/vehicles/me` | Đọc xe của tài xế đang đăng nhập. |
| API-08 | PATCH | `/api/v1/drivers/me/status` | Bật/tắt nhận chuyến với `expectedVersion`. |
| API-09 | PUT | `/api/v1/drivers/me/location` | Cập nhật GPS theo sequence tăng dần. |
| API-10 | GET | `/internal/v1/drivers/candidates?zoneId=ZONE_A&limit=5` | Matching tìm tài xế đủ điều kiện trong vùng. |
| API-11 | PUT | `/internal/v1/reservations/:reservationId` | Trip giữ xe 30 giây; `reservationId` là `assignmentId` do Trip tạo. |
| API-12 | GET | `/internal/v1/reservations/:reservationId` | Đọc trạng thái hiện tại, kể cả đã trả hoặc hết hạn. |
| API-13 | POST | `/internal/v1/reservations/:reservationId/confirm` | Xác nhận lượt giữ còn hạn; trả 200, không tự hết hạn sau xác nhận. |
| API-14 | POST | `/internal/v1/reservations/:reservationId/release` | Trả xe; nếu lượt giữ chưa đến thì lưu dấu đã trả để chặn lệnh giữ đến muộn; trả 200. |

API public yêu cầu JWT role `DRIVER`; mã tài xế lấy từ token. POST xe và PATCH
trạng thái bắt buộc `Idempotency-Key` dạng UUID. API nội bộ dùng `X-Service-Token`:
chỉ Matching gọi candidates, chỉ Trip gọi reservations. Các route nội bộ nằm
ngoài prefix `/api/v1`. GET `/health/live` và `/health/ready` không cần token.

## Luồng đưa tài xế vào nhận chuyến

Đăng ký và đăng nhập tài khoản DRIVER ở Identity trước, rồi gọi lần lượt:

```text
PUT /api/v1/drivers/me
{ "licenseNumber": "DEMO-LICENSE-01" }

POST /api/v1/vehicles                 + Idempotency-Key
{ "plateNumber": "demo-001", "model": "Sedan", "color": "White" }

PUT /api/v1/drivers/me/location
{
  "position": { "lat": 10.77, "lng": 106.69, "zoneId": "ZONE_A" },
  "sequence": 1,
  "recordedAt": "<thời gian hiện tại dạng ISO, có múi giờ>"
}

GET /api/v1/drivers/me                -> đọc version hiện tại

PATCH /api/v1/drivers/me/status        + Idempotency-Key
{ "online": true, "expectedVersion": <version vừa đọc> }
```

Chưa có hồ sơ: GET profile hoặc đăng ký xe trả 404 `DRIVER_NOT_ONBOARDED`;
gửi GPS hoặc lệnh nội bộ cần hồ sơ trả 409 cùng mã. Xe chưa có trả 404
`VEHICLE_NOT_FOUND`. Biển số trùng trả 409 `PLATE_EXISTS`; tài xế đã có xe trả
409 `VEHICLE_EXISTS`.

Chỉ bật online khi có xe và GPS mới trong 60 giây theo giờ DB. Không tắt khi
đang giữ hoặc đã xác nhận chuyến: 409 `ACTIVE_RESERVATION`. Version cũ trả
409 `VERSION_CONFLICT`; client đọc lại hồ sơ rồi quyết định gửi lại.

Trạng thái hiển thị: `RESERVED` khi còn lượt HELD có hạn; `BUSY` khi CONFIRMED;
`AVAILABLE` khi online, có xe và GPS mới; còn lại là `OFFLINE`. `online` vẫn thể
hiện lựa chọn của tài xế, nên có thể online=true nhưng status=OFFLINE khi GPS cũ.

## GPS và ứng viên

- Tọa độ chuẩn hóa về 6 chữ số thập phân; sequence là số nguyên dương không vượt
  `Number.MAX_SAFE_INTEGER`.
- Sequence mới hơn mới ghi. Cùng sequence/cùng nội dung trả bản cũ và giữ
  `receivedAt`; khác nội dung trả 409 `SEQUENCE_CONFLICT`. Sequence thấp hơn trả
  409 `STALE_LOCATION`.
- `recordedAt` phải có múi giờ và lệch giờ DB không quá 60 giây; vượt giới hạn trả
  400 `CLOCK_SKEW`. Tọa độ ngoài giới hạn trả 400 `INVALID_COORDINATE`.
- Gửi GPS không tăng version hồ sơ. Khi restart, client đọc `locationSequence`
  từ GET profile rồi gửi sequence tiếp theo.
- Candidates lọc cùng vùng, online, có xe, GPS mới, không có lượt giữ còn hiệu
  lực. Kết quả sắp theo driverId tăng dần; limit 1–10, mặc định 5. Sai vùng trả
  400 `INVALID_ZONE`. Đây là snapshot; API giữ xe kiểm tra lại điều kiện trong DB.

## Giữ, xác nhận và trả xe

Body PUT giữ xe:

```json
{ "tripId": "<UUID>", "driverId": "<UUID>", "offerId": "<UUID>" }
```

Body POST confirm:

```json
{ "commandId": "<UUID>", "tripId": "<UUID>", "driverId": "<UUID>" }
```

Body POST release thêm `reason`: `ASSIGNMENT_FAILED`, `TRIP_CANCELLED` hoặc
`TRIP_COMPLETED`. Mỗi lệnh giữ/xác nhận/trả có kết quả chống trùng trong cùng
transaction. Gửi lại cùng mã/nội dung trả kết quả đã lưu, không gia hạn giữ xe;
đọc trạng thái mới nhất bằng GET reservation. Đổi payload cùng mã giữ trả 409
`IDEMPOTENCY_CONFLICT`; đổi payload/mã tài nguyên cùng commandId xác nhận/trả
trả 409 `PAYLOAD_MISMATCH`.

Mọi thao tác khóa tài xế trước rồi khóa lượt giữ. Mỗi tài xế và mỗi chuyến có
tối đa một lượt HELD/CONFIRMED nhờ unique index. Xác nhận kiểm tra hạn bằng
`clock_timestamp()` sau khi đã khóa dòng, nên việc chờ khóa không làm lượt giữ
đã hết hạn được xác nhận. Lượt hết hạn trả 409 `RESERVATION_EXPIRED`; lượt đã trả
không được mở lại, trả 409 `RESERVATION_CLOSED`.

Worker chạy mỗi giây, tối đa 100 tài xế/lượt; chỉ chuyển HELD quá hạn sang
EXPIRED. Khi giữ mới cũng dọn HELD hết hạn của chính tài xế trong transaction.
CONFIRMED không bị worker tự trả. Worker không chạy chồng, dừng timer và chờ
lượt đang chạy khi shutdown; sau restart tiếp tục dọn từ DB.

## Chạy local

Từ root, cần Docker Desktop Linux Engine và `.env` có cấu hình JWT/public key
giống Pricing. Khóa nội bộ dùng chung công cụ `svc:tokens`.

```powershell
npm run b:setup:dev
npm run svc:tokens
npm run b:db:up -- driver-db
npm run migration:driver:run
npm run dev:driver-vehicle-location-service
```

DB local `127.0.0.1:5542/driver_db`; app dùng `DRIVER_DATABASE_URL` với user
`driver_app`, migration dùng `DRIVER_MIGRATION_DATABASE_URL` với
`driver_migrator`, `DRIVER_DB_SCHEMA=driver_schema`. `synchronize=false`.
Readiness kiểm tra đúng DB/user và đọc được sáu bảng; DB lỗi trả 503, liveness
vẫn trả 200. Lỗi DB của API trả 503 `DEPENDENCY_UNAVAILABLE`.

## Demo và mô phỏng GPS

Chạy Identity và Driver thật trước. Cấu hình `DRIVER_DEMO_EMAIL` và
`DRIVER_DEMO_PASSWORD` trong terminal hoặc `.env` local. Ví dụ Git Bash:

```bash
export DRIVER_DEMO_EMAIL=driver-demo@example.test
export DRIVER_DEMO_PASSWORD='DemoPass!2026'
npm run demo:driver
# Hoặc gửi GPS liên tục mỗi 5 giây; Ctrl+C để dừng:
npm run simulate:driver
```

Script đăng ký tài khoản nếu chưa có, đăng nhập thật, tạo hồ sơ/xe nếu thiếu,
gửi GPS và bật online. Mã tài xế luôn do Identity cấp. Chạy lại cùng tài khoản
sẽ đọc sequence hiện tại, không tạo xe thứ hai. Có thể đặt `IDENTITY_BASE_URL`,
`DRIVER_BASE_URL`, `DRIVER_DEMO_LAT`, `DRIVER_DEMO_LNG`, `DRIVER_DEMO_ZONE`.
Script không in mật khẩu/token; dừng simulator thì GPS sẽ cũ sau 60 giây.

## Kiểm thử và tích hợp

```powershell
npm run typecheck
npm run test:driver:unit
npm run test:driver:integration
npm test
```

Integration dùng Identity thật và PostgreSQL test riêng, có migration/quyền app
giống dev. Kiểm tra onboarding, GPS, version, token, uniqueness, giữ xe đồng
thời, trả trước giữ đến muộn, hạn sau khi chờ khóa, worker restart, DB restart
và simulator chạy lại. Test tự dọn container, không dùng dữ liệu dev.

Nối Trip/Matching thật, route Gateway, Dockerfile/Compose chung và test tải vẫn
thuộc các bước tích hợp tiếp theo của [kế hoạch B](../plans/B-thu-tu-trien-khai.md).
