# DS03 – Đối chiếu đề bài và kịch bản demo 9 bước (bản trình bày)

Tài liệu này bổ sung cho [kich-ban-demo.md](kich-ban-demo.md) (phần kỹ thuật của `npm run demo`).
Ở đây: (1) đối chiếu repo với *COURSE PROJECT SPECIFICATION*, (2) việc phải làm trước khi nộp/demo,
(3) kịch bản 9 bước kèm lời thoại, người trình bày, log cần chỉ và câu hỏi phản biện.

---

## 1. Đối chiếu yêu cầu đề bài

Ký hiệu: ✅ đạt · ⚠️ đạt một phần / cần bổ sung · ❌ chưa có.

### 1.1 Yêu cầu riêng DS03 (mục 7)

| Mục đề | Yêu cầu | Hiện trạng | Bằng chứng |
|---|---|---|---|
| 7.1 | Service triển khai độc lập, giao tiếp REST + message queue | ✅ 8 app NestJS, mỗi app 1 container; REST nội bộ + RabbitMQ exchange `ride.events` | `deploy/docker-compose.yml`, `src/packages/messaging` |
| 7.2 | ≥ 4 service nghiệp vụ (Gateway không tính) | ✅ 7 service: Identity, Driver/Location, Trip, Matching, Pricing, Payment, Notification | `src/services/*` |
| 7.2 | Mỗi service DB riêng, không truy cập DB của nhau | ✅ 7 PostgreSQL riêng, user/quyền hẹp, `b:db:verify` kiểm không đăng nhập chéo | `deploy/postgres/`, `docs/test-evidence/*/verification.json` |
| 7.3 | Đăng ký, đăng nhập, vai trò khách/tài xế | ✅ bcrypt, JWT RS256, Guard vai trò | `docs/test-evidence/identity/` |
| 7.3 | Tài xế cập nhật trạng thái, vị trí mô phỏng | ✅ GPS theo vùng, bật/tắt nhận chuyến, `simulate:driver` | `scripts/simulation/driver-gps.cjs` |
| 7.3 | Khách tạo yêu cầu, tìm và chọn tài xế | ✅ Quote → Trip → `trip.requested` → Matching | demo bước 3–4 |
| 7.3 | Tài xế nhận / từ chối | ✅ từ chối → mời tài xế kế tiếp | `docs/test-evidence/e2e/happy-path.json` |
| 7.3 | Một tài xế không bị gán 2 chuyến | ✅ giữ xe (reservation) + khóa DB + Saga | `docs/test-evidence/trip/concurrency-driver-double-booking.json` |
| 7.3 | Vòng đời chuyến | ✅ `MATCHING → ASSIGNING → ASSIGNED → IN_PROGRESS → COMPLETED`, hủy, `NO_DRIVER` | demo bước 5 |
| 7.3 | Tính giá, thanh toán mô phỏng | ✅ Pricing CAR_V1; Payment có 5 chế độ mô phỏng lỗi | demo bước 3, 5 |
| 7.3 | Thông báo khách và tài xế | ✅ Notification nhận 8 loại sự kiện, xử lý sai thứ tự | demo bước 4–5 |
| 7.3 | ≥ 1 luồng REST | ✅ Trip → Pricing/Driver/Matching/Payment qua `InternalHttpClient` | |
| 7.3 | ≥ 1 luồng bất đồng bộ qua MQ | ✅ `trip.requested`, `payment.requested`, `payment.succeeded`… (11 event) | `docs/api/events.schema.json` |
| 7.3 | Event ID / Idempotency key | ✅ `eventId` + `Idempotency-Key`, `commandId` | `@app/runtime/idempotency.ts` |
| 7.3 | Retry | ✅ HTTP: 3 lần (0,5 s / 1,5 s); MQ: hàng retry 1 s / 5 s / 15 s | `c/recovery.json` (F09) |
| 7.3 | Deduplication | ✅ bảng `processed_events`, `idempotency_keys`, `command_results` | `c/recovery.json` (R03) |
| 7.3 | DLQ / lưu tin lỗi | ✅ `<queue>.dlq` kèm `x-error-code`, `events:dlq --replay` | `c/recovery.json` (R03) |
| 7.3 | Correlation ID | ✅ header `X-Correlation-Id`, log JSON có `correlationId` | `src/packages/runtime/src/http-context.ts` |
| 7.3 | Saga / bù trừ | ✅ Saga nhận chuyến (giữ xe → xác nhận → gán), bù trừ `RELEASE_DRIVER`, `FAILED_COMPENSATED` | `src/services/trip-booking-service/src/trips/saga/` |
| 7.4 | 9 kịch bản demo bắt buộc | ✅ `npm run demo` chạy đủ 9 bước | `docs/test-evidence/demo/demo-run.json` |

### 1.2 Yêu cầu chung (mục 4, 9, 10, 11)

| Mục | Yêu cầu | Hiện trạng |
|---|---|---|
| 4.1 | ≥ 3 process, có định danh riêng, log có node/thời gian/loại sự kiện/kết quả | ✅ log JSON `service, instanceId, timestamp, event, result, correlationId, latencyMs` |
| 4.2 | Service discovery, phát hiện online/offline, timeout/ack/retry | ✅ DNS của Docker network + `*_BASE_URL`; `/health/live`, `/health/ready`; publisher confirm + consumer ack. ⚠️ Discovery là tĩnh (không có registry như Consul) – nên nói rõ khi bị hỏi |
| 4.3 | Kịch bản đồng thời, mô hình nhất quán | ✅ 2 test đồng thời (double booking, start vs cancel); eventual consistency giữa service, strong consistency trong từng DB |
| 4.4 | Mô hình lỗi + ≥ 2 kịch bản lỗi | ✅ Payment tắt, mất phản hồi/chết giữa Saga, tin trùng, tin hỏng, RabbitMQ restart |
| 4.5 | Bảo mật cơ bản | ✅ JWT, phân quyền, token nội bộ, whitelist DTO, body ≤ 64 KiB, event ≤ 128 KiB, rate limit, `.env` và khóa PEM **không** bị commit. TLS chưa có (đề chỉ khuyến khích) |
| 9 | ≥ 8 functional, 2 concurrency, 2 fault, 2 security, 1 performance | ✅ vượt yêu cầu (xem `docs/test-evidence/`, tất cả `PASS`) |
| 10.1 | README, src, deploy, tests, scripts, docs, .env.example | ✅ |
| 10.1 | `docs/report.pdf` | ✅ có |
| 10.1 | `docs/slides.pdf` | ❌ chưa có (đề ghi "if available" nhưng nên có) |
| 10.1 | Commit của từng thành viên | ✅ 3 người đều có commit |
| 10.1 | **Bảng phân công trong repo** | ✅ README mục 1 có bảng phân công |
| 10.1 | **Tag/release cuối, ví dụ `v1.0.0`** | ❌ chưa có tag nào trên remote |
| 10.1 | README có kịch bản demo | ✅ README mục 6 trỏ tới `docs/demo/` |
| 11 | Demo ≥ 3 node, có đồng thời, có lỗi live, có log, đủ thành viên | ✅ nếu theo kịch bản dưới |

### 1.3 Tính năng nâng cao (mục 7.5) – điểm cộng

| Tính năng | Trạng thái |
|---|---|
| API Gateway | ✅ allowlist route, chặn `/internal`, bỏ header giả, timeout 10 s, rate limit |
| Outbox pattern | ✅ `OutboxRelay` + confirm channel + mandatory |
| Docker Compose | ✅ `npm run stack:up` |
| Geospatial matching | ⚠️ theo vùng (ZONE_A…) và vị trí mới nhất, chưa phải bán kính địa lý |
| Distributed tracing / centralized logging | ⚠️ có correlation ID xuyên service, gom log bằng `docker compose logs`; chưa có Jaeger/ELK |
| Circuit breaker | ❌ chỉ có timeout + bounded retry |
| Multiple-instance scaling, monitoring dashboard | ❌ |

**Kết luận:** phần kỹ thuật và 9 kịch bản bắt buộc của DS03 đã đạt. Những chỗ còn thiếu đều nằm ở phần hồ sơ nộp bài (mục 2 dưới đây) và có thể làm xong trong ngày.

---

## 2. Việc phải làm trước khi nộp và demo

Hạn nộp: **22/11/2026**. Demo: 23/11 hoặc 30/11.

1. **Tạo tag `v1.0.0`** trên `main` sau khi chốt code (đề bắt buộc).
2. **Thêm bảng phân công vào README** (tên, MSSV, phần phụ trách, thư mục code, test của mình).
3. **Sửa đoạn lỗi thời trong README**: câu "RabbitMQ, Payment/Notification/Matching và Compose chung còn cần triển khai" và "Gateway allowlist 3 route" không còn đúng; thêm link tới `docs/demo/`.
4. **Chạy lại `npm run demo -- --auto`**: bằng chứng `demo-run.json` đang là ngày 02/11, sau đó code Matching/Trip đã đổi (04/11, 15/11). Cần chạy lại để chắc demo vẫn qua.
5. `docs/report.docx` và `docs/reports/` đang chưa được commit: quyết định commit hay bỏ.
6. (Nên có) xuất slide ra `docs/slides.pdf`.

---

## 3. Phân vai và thời lượng

Phân công của nhóm:

| Vai | Thành viên | Phụ trách | Trình bày bước |
|---|---|---|---|
| A | Phạm Quốc Hùng | Identity/JWT, Trip, Saga | 3, 5, 6 |
| B | Nguyễn Bá Thọ | Driver/Location, Pricing, Matching | 2, 4, và giải thích Matching ở 6 |
| C | Lê Hải Sơn | Payment, Notification, messaging, Gateway, Compose | 1, 7, 8, 9 |

| Phần | Thời gian |
|---|---|
| Giới thiệu bài toán + kiến trúc (sơ đồ 8 app, 7 DB, RabbitMQ) | 3–4 phút |
| Demo 9 bước | 8–10 phút |
| Vấn đáp | ~5 phút |

### Bố trí màn hình

- **Cửa sổ 1** – chạy `npm run demo` (dừng chờ Enter sau mỗi bước).
- **Cửa sổ 2** – log song song: `npm run stack:logs`.
- **Cửa sổ 3** – để trống. Ở bước 3 và bước 8, script in sẵn dòng **"Lọc log của luồng này"**; copy nguyên lệnh đó dán vào đây. Dạng lệnh:

```powershell
docker compose --env-file .env -f deploy/docker-compose.yml logs --no-color | Select-String '<correlationId>'
```

### Cách đọc màn hình demo

Mỗi bước in theo cùng một khuôn, người trình bày đọc từ trên xuống:

1. `BƯỚC n/9` và **Mục tiêu**: bước này cần chứng minh điều gì.
2. Dòng `… …`: việc script đang làm. Khi phải chờ (Matching mời tài xế, Payment xử lý), dòng này đếm giây rồi đổi thành `→ xong sau x s`.
3. Các dòng số liệu: đọc thật từ API, DB của từng service và RabbitMQ.
4. **→ Kết luận**: một câu chốt. Đọc to câu này trước khi bấm Enter sang bước tiếp.

Người dùng được đặt tên **Tài xế 1, Khách A, Khách B**; mã UUID chỉ in 8 ký tự đầu. Cuối demo có phần **TÓM TẮT** liệt kê 9 bước đã đạt.

### Chuẩn bị 30 phút trước giờ demo

```powershell
npm run stack:up
```

```powershell
npm run stack:ps
```

```powershell
npm run demo -- --auto
```

- Kiểm tra `.env` có `PAYMENT_SIMULATION_MODE=SUCCEED`.
- Tập dượt bằng `--auto` một lần, rồi chạy thật `npm run demo` (mỗi lần chạy tạo tài xế/khách mới nên không đụng dữ liệu cũ).
- Phóng to font terminal; tắt thông báo hệ điều hành.

---

## 4. Kịch bản 9 bước

Mỗi bước ứng với một gạch đầu dòng của đề mục 7.4.

### Bước 1 – Khởi động các service độc lập  *(C trình bày)*

- **Đề yêu cầu:** *Start services independently.*
- **Thao tác:** gõ `npm run demo`; bước 1 chạy ngay (không cần Enter). Script gọi `/health/ready` trong từng container và liệt kê container DB.
- **Chỉ vào:** 8 dòng `200 UP`, mỗi dòng một `instanceId` khác nhau; 7 container DB riêng; cửa sổ 2 có log của nhiều service xen kẽ.
- **Lời thoại:** "Hệ thống gồm 7 service nghiệp vụ và 1 Gateway, mỗi cái là một process trong container riêng, có DB riêng. Không service nào có mật khẩu DB của service khác. Chúng tìm nhau qua tên DNS trong mạng Docker, giao tiếp bằng HTTP và RabbitMQ."
- **Có thể làm thêm (nếu được hỏi "độc lập thật không"):** `docker compose ... restart pricing` rồi chỉ ra các service khác vẫn `UP`.

### Bước 2 – Tài xế sẵn sàng  *(B trình bày)*

- **Đề yêu cầu:** *Drivers become available.*
- **Thao tác:** Enter. Script đăng ký tài xế, tạo hồ sơ, xe, gửi GPS vùng ZONE_A, bật nhận chuyến.
- **Chỉ vào:** trạng thái `AVAILABLE`; vị trí mới nhất đọc từ DB Driver.
- **Lời thoại:** "Tài xế đăng nhập bằng JWT có vai trò DRIVER; mọi request đi qua Gateway. Vị trí quá 60 giây không cập nhật thì tài xế không còn là ứng viên – đó là cơ chế phát hiện tài xế offline."

### Bước 3 – Khách đặt chuyến  *(A trình bày)*

- **Đề yêu cầu:** *A passenger requests a ride.*
- **Thao tác:** Enter. Khách lấy báo giá rồi đặt chuyến với `Idempotency-Key`.
- **Chỉ vào:** giá 41.000 đ (3 km, 10 phút); bản chụp giá trong DB Trip; sự kiện `trip.requested` trong outbox đã `PUBLISHED`; **mã theo dõi (correlationId)** – ghi lại để dùng ở bước 8.
- **Lời thoại:** "Trip gọi Pricing đồng bộ bằng REST để khóa giá, ghi chuyến và sự kiện vào outbox trong cùng một transaction. Relay chỉ đánh dấu PUBLISHED khi RabbitMQ xác nhận, nên không có chuyện ghi DB xong mà mất sự kiện."

### Bước 4 – Matching chọn tài xế  *(B trình bày)*

- **Đề yêu cầu:** *The Matching Service selects a driver.*
- **Thao tác:** Enter. Script chờ lời mời xuất hiện trong Notification của tài xế.
- **Lưu ý nhịp trình bày:** lời mời chỉ sống 15 giây kể từ lúc đặt chuyến ở bước 3. Nói lâu ở bước 3 hoặc bước 4 thì lời mời hết hạn; khi đó script tự hủy chuyến cũ, đặt lại và in dòng giải thích (bước 4 hoặc trước khi nhận ở bước 5). Nên đọc *Kết luận* bước 3 và 4 rồi Enter ngay, phần giải thích để nói trong bước 5. Nếu bị đặt lại, có thể dùng luôn làm ví dụ: "hết 15 giây là lời mời hết hạn, đúng như thiết kế".
- **Chỉ vào:** việc tìm (matching job) trong DB Matching; lời mời có hạn 15 giây; người nhận đúng tài xế; các queue gắn vào exchange `ride.events`.
- **Lời thoại:** "Matching không bị Trip gọi trực tiếp mà nhận `trip.requested` qua queue. Nó hỏi Driver danh sách ứng viên cùng vùng, mời từng người, hết 15 giây thì mời người tiếp theo. Nếu nhận trùng sự kiện, bảng `processed_events` bỏ qua."

### Bước 5 – Tài xế nhận và hoàn thành chuyến  *(A trình bày)*

- **Đề yêu cầu:** *The driver accepts and completes the trip.*
- **Thao tác:** Enter. Tài xế nhận → bắt đầu → kết thúc.
- **Chỉ vào:** operation Saga `SUCCEEDED`; giữ xe `CONFIRMED` rồi `RELEASED`; lịch sử trạng thái chuyến; thanh toán `SUCCEEDED` lần thử 1; thông báo tới khách.
- **Lời thoại:** "Nhận chuyến là một distributed transaction kiểu Saga có điều phối ở Trip: giữ xe bên Driver → xác nhận → gán chuyến. Bước nào hỏng thì chạy bù trừ `RELEASE_DRIVER` để trả xe, kết thúc ở `FAILED_COMPENSATED`. Kết thúc chuyến thì Trip phát `payment.requested`, Payment xử lý bất đồng bộ."

### Bước 6 – Đồng thời: hai khách đặt cùng lúc, một tài xế bấm nhận cả hai  *(A + B trình bày)*

- **Đề yêu cầu:** *Two passengers simultaneously request the same driver.*
- **Thao tác:** Enter. Khách A và Khách B đặt cùng lúc khi ZONE_A chỉ có Tài xế 1; Tài xế 1 bấm nhận cả hai lời mời cùng lúc.
- **Nói rõ điểm tranh chấp:** hai Saga nhận chuyến cùng xin Driver giữ **một** tài xế. Đây là chỗ có thể gán trùng nếu không khoá.
- **Chỉ vào:** một chuyến `SUCCEEDED – thắng`; chuyến kia `FAILED_COMPENSATED – thua (DRIVER_UNAVAILABLE) → Saga bù trừ`; lượt giữ xe còn hiệu lực = 1; chuyến thua thành `NO_DRIVER` (tối đa ~60 giây). Nhấn mạnh: `FAILED_COMPENSATED` là kết quả **đúng**, không phải lỗi.
- **Lời thoại:**
  - B: "Driver chỉ cho một reservation còn hiệu lực trên mỗi tài xế – được bảo đảm hai lớp trong DB Driver: khóa dòng tài xế (`SELECT … FOR UPDATE`) và unique index một phần `uq_reservations_active_driver` trên `driver_id` khi trạng thái là `HELD`/`CONFIRMED`. Kể cả code sai thì DB vẫn chặn."
  - A: "Request nhận chuyến thứ hai bị từ chối và Saga của nó bù trừ. Chuyến thua không treo mãi mà về `NO_DRIVER`. Trạng thái cuối được kiểm bằng truy vấn DB chứ không chỉ nhìn response."
- **Bằng chứng thêm:** `docs/test-evidence/trip/concurrency-driver-double-booking.json`, `concurrency-start-vs-cancel-trip.json`.

### Bước 7 – Tắt một service giữa luồng nghiệp vụ  *(C trình bày – lỗi live)*

- **Đề yêu cầu:** *Stop one service during a business flow.*
- **Thao tác:** Enter. Script chạy `docker compose stop payment` rồi cho một chuyến chạy tới khi kết thúc.
- **Chỉ vào:** chuyến vẫn `COMPLETED`, thanh toán `PENDING`; `GET /payments` báo lỗi có thời hạn trong khi `GET /trips` vẫn 200; cửa sổ 2 không còn log của `payment`.
- **Lời thoại:** "Mô hình lỗi của nhóm: service có thể chết bất kỳ lúc nào (crash-stop), tin nhắn có thể trùng hoặc đến muộn, không xét lỗi Byzantine. Payment chết không kéo theo Trip vì hai bên nối qua queue. Gateway chờ tối đa 10 giây rồi trả lỗi, không treo."

### Bước 8 – Retry, hàng đợi, mã theo dõi  *(C trình bày)*

- **Đề yêu cầu:** *Demonstrate retry, queue handling, or compensation.*
- **Thao tác:** Enter. Script đọc outbox của Trip và độ dài queue `payment.events`.
- **Chỉ vào:** `payment.requested` ở trạng thái `PUBLISHED` (nghĩa là RabbitMQ đã nhận và giữ tin, **chưa** phải đã thu tiền); 1 tin đang chờ ở `payment.events`; DB Payment có 0 khoản.
- **Làm thêm ở cửa sổ 3 (sau bước 9):** dán lệnh "Lọc log của luồng này" của bước 8. Kết quả cho thấy lệnh kết thúc chuyến đi qua Gateway → Driver → Trip, rồi khoảng 20 giây sau, khi Payment được bật lại, dòng log của Payment xử lý đúng sự kiện đó. Lệnh lọc gồm cả correlationId lẫn `event_id`, vì log của Payment ghi theo `event_id`.
- **Lời thoại:** "Tin không mất vì queue durable và tin được lưu bền. Khi consumer báo lỗi tạm, tin đi qua hàng retry 1 s, 5 s, 15 s; quá 3 lần hoặc sai cấu trúc thì vào DLQ kèm mã lỗi để vận hành xem và replay."
- **Bằng chứng retry/DLQ:** `docs/test-evidence/c/recovery.json` – F09 (lỗi tạm rồi thành công), R03 (trùng, tin hỏng vào DLQ, consumer chết giữa chừng, RabbitMQ restart).

### Bước 9 – Bật lại service, xử lý tiếp  *(C trình bày, A chốt)*

- **Đề yêu cầu:** *Restart the service and continue processing messages.*
- **Thao tác:** Enter. Script chạy `docker compose start payment`.
- **Chỉ vào:** sau vài giây thanh toán `SUCCEEDED`; đúng **1 khoản, 1 lần thử**; queue `payment.events` về 0; file `docs/test-evidence/demo/demo-run.json` được ghi.
- **Lời thoại:**
  - C: "Payment lên lại tự kết nối RabbitMQ và xử lý tin tồn. Nhờ `eventId` và bảng `processed_events`, dù tin có bị giao lại thì cũng không thu tiền hai lần."
  - A (chốt): "Hệ thống nhất quán cuối cùng: trong lúc Payment chết, chuyến đã xong nhưng tiền còn chờ; khi Payment lên lại, trạng thái hội tụ mà không cần người can thiệp."

---

## 5. Phương án dự phòng và màn bổ sung

| Tình huống | Cách xử lý |
|---|---|
| Bước 4/5 in "Lời mời … đã hết hạn 15 s … đặt lại chuyến" | Bình thường: đã dừng trình bày quá 15 s sau khi đặt chuyến; script tự đặt lại, cứ tiếp tục |
| Bước 4/6 chờ lời mời > 30 giây | Hiếm khi xảy ra vì script đã gửi GPS nền mỗi 20 s. Kiểm tra `npm run stack:ps` (Matching, Notification, RabbitMQ còn chạy?) rồi Ctrl+C, chạy lại `npm run demo` |
| Dừng giữa bước 7–8 mà Payment vẫn tắt | `docker compose --env-file .env -f deploy/docker-compose.yml start payment` |
| Demo hỏng hẳn | Mở `docs/test-evidence/demo/demo-run.json` của lần tập dượt và giải thích từng bước |
| Giám khảo muốn xem DLQ live | `npm run events:dlq -- trip.events` (xem), thêm `--replay` để đẩy lại |
| Giám khảo muốn xem bỏ trùng live | `npm run events:send -- evt-01` hai lần: lần hai bị bỏ qua; thêm `--new-id` để thấy được xử lý |
| Giám khảo muốn xem thao tác Saga kẹt | Tìm operation `FAILED_NEEDS_REVIEW` bằng câu SQL trong README, xử lý bằng `npm run ops:retry -- <operationId> "<lý do>"` |

---

## 6. Câu hỏi vấn đáp nên chuẩn bị

1. **Vì sao Saga điều phối (orchestration) mà không phải choreography?** – Luồng nhận chuyến có nhiều bước phụ thuộc thứ tự và cần bù trừ rõ ràng; để Trip giữ trạng thái operation dễ theo dõi và tiếp tục sau crash.
2. **Outbox giải quyết gì?** – Vấn đề dual-write: ghi DB thành công nhưng gửi RabbitMQ thất bại (hoặc ngược lại).
3. **At-least-once hay exactly-once?** – At-least-once + bỏ trùng phía nhận = hiệu quả exactly-once ở mức nghiệp vụ.
4. **Chống double booking ở đâu?** – Tầng DB của Driver: khóa `pessimistic_write` trên dòng tài xế + unique index một phần `uq_reservations_active_driver`; không dựa vào bộ nhớ của một process.
5. **Service discovery thế nào?** – DNS của Docker Compose + biến `*_BASE_URL`. Hạn chế: tĩnh, chưa scale nhiều instance; hướng mở rộng là Consul/Kubernetes Service.
6. **Phát hiện service chết?** – Healthcheck `/health/ready` (kiểm DB, RabbitMQ), timeout 2 s cho mỗi lần gọi nội bộ, readiness báo 503 khi mất phụ thuộc.
7. **Nếu RabbitMQ chết?** – Outbox giữ sự kiện trong DB, relay gửi lại khi kết nối lại (R03 có test RabbitMQ restart).
8. **Bảo mật giữa các service?** – `X-Service-Token` theo từng cặp gọi/nhận; Gateway bỏ các header nội bộ từ client và chặn `/internal`.
9. **Hạn chế hiện tại?** – Chưa có circuit breaker, chưa có TLS, mỗi service một instance, matching theo vùng chứ chưa theo khoảng cách thực.
10. **Hiệu năng?** – Nêu số liệu từ `docs/test-evidence/performance/p01-load.json` (độ trễ, throughput, tỉ lệ thành công).
