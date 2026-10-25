# Matching — Ghép chuyến, phần B

Service chạy cổng 3006, dùng riêng `matching_db` / `matching_schema`. Matching
quản lý việc tìm tài xế và lời mời; Trip quyết định gán tài xế vào chuyến và
gọi Driver giữ/xác nhận/trả xe. Matching không truy cập DB của service khác.

## API nội bộ

Tất cả API dưới đây yêu cầu `X-Service-Token` của Trip
(`SVC_TOKEN_TRIP_MATCHING`). Không có API public hoặc JWT hành khách/tài xế.

| API | Method | Path | Công việc |
| --- | --- | --- | --- |
| API-29 | GET | `/internal/v1/matching/jobs/:tripId` | Xem trạng thái việc tìm theo mã chuyến. |
| API-30 | POST | `/internal/v1/matching/jobs/:tripId/cancel` | Hủy việc tìm, kể cả khi sự kiện chuyến mới chưa đến. |
| API-40 | GET | `/internal/v1/offers/:offerId` | Đọc lời mời để Trip kiểm tra chủ sở hữu trước khi nhận/từ chối. |
| API-31 | POST | `/internal/v1/offers/:offerId/decisions` | Nhận hoặc từ chối lời mời. |
| API-32 | POST | `/internal/v1/offers/:offerId/resolution` | Ghi kết quả gán tài xế cuối cùng. |

POST trả 200. Đường nội bộ giữ prefix `/internal/v1`, không thêm `/api/v1`.
GET `/health/live` kiểm tra tiến trình; `/health/ready` kiểm tra đúng DB/user,
sáu bảng và kết nối consumer RabbitMQ. DB/broker lỗi thì readiness trả 503.
API dùng DB vẫn hoạt động khi broker tắt; không cần Driver/Trip đang chạy để
service khởi động. Lỗi DB của API trả 503 `DEPENDENCY_UNAVAILABLE`.

Body hủy việc tìm:

```json
{ "commandId": "<UUID>", "tripVersion": 3 }
```

Body nhận/từ chối:

```json
{
  "assignmentId": "<UUID ổn định do Trip cấp>",
  "tripId": "<UUID>",
  "driverId": "<UUID>",
  "action": "ACCEPT"
}
```

`action` là ACCEPT hoặc REJECT. Body kết quả cuối:

```json
{
  "commandId": "<UUID>",
  "assignmentId": "<UUID đã nhận lời mời>",
  "tripId": "<UUID>",
  "result": "ASSIGNED"
}
```

`result` là ASSIGNED, RETRY hoặc CANCELLED. Cùng mã lệnh/nội dung được phát lại
kết quả cũ trong `command_results`; đọc GET để biết trạng thái mới nhất. Cùng
assignmentId nhưng đổi quyết định trả 409 `OFFER_CONFLICT`; lệnh khác payload
bị chặn. Sai driver trả 403 `DRIVER_MISMATCH`; sai assignment trả 409
`ASSIGNMENT_MISMATCH`. Lời mời hết hạn trả 409 `OFFER_EXPIRED`; việc tìm đã hủy
trả 409 `JOB_CANCELLED`; kết quả mâu thuẫn trả 409 `RESOLUTION_CONFLICT`.

## Sự kiện và worker

Consumer nhận `trip.requested` và `trip.cancelled` từ exchange topic
`ride.events`, queue durable `matching.events`. Envelope/payload được kiểm tra
theo [schema sự kiện trích từ BA](../../src/services/matching-service/src/matching/events.schema.json),
gồm producer, UUID, version, tọa độ, tiền dạng chuỗi và field bắt buộc.

- `trip.requested`: ghi dấu đã xử lý và tạo job trong cùng transaction. Một
  chuyến chỉ có một job; gửi lặp không đổi snapshot hoặc gia hạn tìm.
- `trip.cancelled`: tạo dấu CANCELLED kể cả khi chưa có job; requested đến muộn
  không mở lại. Version sự kiện cũ bị bỏ qua, version lệnh hủy cũ trả 409
  `STALE_TRIP_VERSION`.
- ACK sau commit. Lỗi tạm thời đi qua các queue `.retry.1s`, `.retry.5s`,
  `.retry.15s`, rồi `.dlq`; JSON/schema sai đi thẳng DLQ. Republish phải được
  broker confirm trước khi ACK tin cũ. Không ghi dấu xử lý nếu transaction lỗi.

Worker chạy mỗi 500 ms, nhận tối đa 5 job/lượt với lease 15 giây và
`FOR UPDATE SKIP LOCKED`. Mọi thay đổi khóa **job trước, offer sau**. HTTP luôn
gọi ngoài transaction; lúc ghi kết quả phải kiểm tra lại lease/version/status.
Hủy trong lúc gọi HTTP làm kết quả worker cũ mất hiệu lực.

Worker gọi Driver tìm ứng viên cùng vùng, tối đa 10 ứng viên/lần; không mời lại
tài xế đã thử và tối đa 5 tài xế/job. Thời hạn tìm cố định 60 giây, lời mời OPEN
15 giây. Tạo attempt, offer, đổi job và ghi outbox trong cùng transaction.
Từ chối/hết hạn thì tìm tiếp; hết ứng viên/lượt thử hoặc hết hạn thì FAILED và
ghi một `matching.failed`. Driver lỗi được thử lại, không coi là danh sách rỗng.

Nhận lời mời chuyển OPEN -> CLAIMED. CLAIMED không tự hết hạn theo hạn OPEN,
kể cả quá 60 giây tìm. Worker hỏi Trip mỗi khoảng 5 giây để đối soát:

- ASSIGNING hoặc chưa xác minh được: giữ CLAIMED.
- ASSIGNED/IN_PROGRESS/COMPLETED, đúng assignment và driver: ACCEPTED/MATCHED.
- MATCHING và assignment cũ không còn hoạt động: đóng offer và tìm tiếp.
- CANCELLING/CANCELLED/NO_DRIVER: đóng job; Driver vẫn do Trip dọn.

Response HTTP của Driver/Trip được kiểm tra bằng
[schema trích từ OpenAPI](../../src/services/matching-service/src/matching/http.schema.json).
Client dùng `InternalHttpClient`: timeout 2 giây/lần, tối đa 3 lần với lỗi tạm
thời, có token đúng cặp và correlation ID.

## Outbox và RabbitMQ

Matching phát `matching.offer.created` cho Notification và `matching.failed`
cho Trip. Event giữ nguyên `event_id` khi gửi lại; aggregate_id là jobId.
Publisher nhận outbox bằng lease, publish ngoài transaction với
publisher confirm và `mandatory`. Tin không có route vẫn PENDING và thử lại,
không đánh dấu thành công. Lease PUBLISHING cũ được lấy lại sau restart.
Gửi có thể lặp nếu process chết giữa confirm và cập nhật DB; consumer nhận cần
dedup theo event_id.

Adapter nằm trong `matching-broker.ts`; chưa đưa vào `@app/messaging` của C.
Khi tích hợp C, giữ nguyên schema/topology và thay adapter bằng thư viện chung.
Notification/Trip phải khai báo queue và binding nhận sự kiện của mình. Khi C
chưa chạy/chưa tạo binding, job/offer vẫn lưu trong DB, sự kiện ở outbox chờ gửi.
Các queue retry/DLQ của Matching được khai báo bởi adapter.

Tham khảo hành vi confirm/mandatory trong
[amqplib Channel API](https://amqp-node.github.io/amqplib/channel_api.html).

## Chạy local

Từ root, với Node.js, Docker Desktop Linux Engine và `.env` đã có DB của B:

```powershell
npm ci
npm run b:setup:dev
npm run svc:tokens
npm run matching:setup:dev
npm run b:db:up -- matching-db
npm run migration:matching:run
npm run matching:mq:up
npm run dev:matching-service
```

DB local `127.0.0.1:5546/matching_db`, schema `matching_schema`; app dùng
`MATCHING_DATABASE_URL` với `matching_app`, migration dùng
`MATCHING_MIGRATION_DATABASE_URL` với `matching_migrator`. `synchronize=false`.
`RABBITMQ_URL`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` được setup thêm vào `.env`
nếu thiếu; giữ cấu hình đã có. Compose broker dev:
[deploy/matching-dev.compose.yml](../../deploy/matching-dev.compose.yml).
Broker mở `127.0.0.1:5672`, management UI `http://127.0.0.1:15672`; tài khoản
lấy từ `.env`. Dừng broker: `npm run matching:mq:stop` (giữ volume).

`DRIVER_BASE_URL` mặc định `http://127.0.0.1:3002`; `TRIP_BASE_URL` mặc định
`http://127.0.0.1:3003`. Matching cần token MATCHING_DRIVER và MATCHING_TRIP;
Trip gọi Matching bằng TRIP_MATCHING. Không log token hoặc URL có mật khẩu.

## Bản giả để phát triển độc lập

Chạy Driver thật và simulator GPS để có ứng viên mới. Khi Trip chưa xong, mở
terminal Git Bash cho bản giả Trip:

```bash
FAKE_TRIP_STATE_FILE=scripts/fakes/trips.example.json npm run matching:fake-trip
```

Trong terminal chạy Matching, đổi riêng URL Trip sang bản giả:

```bash
TRIP_BASE_URL=http://127.0.0.1:3013 npm run dev:matching-service
```

File map `tripId -> Trip` được đọc lại mỗi GET; sửa status/version/assignmentId/
driverId để mô phỏng đối soát. Ví dụ ban đầu là ASSIGNING để worker chờ. Khi
chuyển ASSIGNED phải điền đúng assignmentId và driverId của offer đang CLAIMED.
Bản giả chỉ có GET và kiểm tra token MATCHING_TRIP, không chỉnh DB của Trip.

Gửi sự kiện mẫu sau khi Matching ready:

```bash
npm run matching:emit -- scripts/fakes/trip.requested.example.json
npm run matching:emit -- scripts/fakes/trip.cancelled.example.json
```

Đọc job qua API-29 với tripId trong file mẫu, lấy currentOfferId để xem/nhận/
từ chối qua API-40/31. Giữ event_id khi thử gửi trùng. Đổi event_id và tripId
cho một luồng mới; job đã CANCELLED/FAILED/MATCHED không được mở lại bằng
requested khác. Script này chỉ dành cho môi trường dev.

## Kiểm thử

```powershell
npm run typecheck
npm run test:matching:unit
npm run test:matching:integration
npm test
```

Integration tạo PostgreSQL và RabbitMQ riêng, sử dụng quyền `matching_app`,
kiểm tra HTTP/token qua bản giả Driver/Trip theo BA. Bao gồm sự kiện trùng/đảo
thứ tự, claim đồng thời, hạn sau khi chờ khóa, giới hạn 5 tài xế, rollback
outbox, worker lease, đối soát CLAIMED, publisher bị thiếu route, khôi phục
PUBLISHING và DB/broker restart. Container test tự dọn, không dùng dữ liệu dev.
Bằng chứng: [verification.json](../test-evidence/matching/verification.json).

Các bước còn lại: Trip/Notification thật, thư viện messaging chung của C,
luồng đầu cuối/Gateway, Dockerfile/Compose chung và test tải theo BA.
