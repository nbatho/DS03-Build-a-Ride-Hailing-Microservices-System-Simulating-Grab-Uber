# Kịch bản demo 9 bước

Theo mục 7.4 của đề. Mọi thao tác của người dùng đi qua Gateway; script `scripts/demo/run-demo.cjs` chạy từng bước trên stack Compose thật, in ra mã, trạng thái DB, sự kiện và hàng đợi để người trình bày chỉ vào, rồi dừng chờ Enter.

Thời lượng: khoảng 6–8 phút chạy script, cộng phần giải thích.

## Chuẩn bị (trước giờ demo)

```powershell
npm ci
npm run identity:setup:dev   # .env, khóa JWT, DB Tài khoản
npm run c:setup:dev          # DB Thanh toán, Thông báo, RabbitMQ
npm run b:setup:dev          # DB Tài xế, Ghép chuyến, Báo giá
npm run trip:setup:dev       # DB Chuyến đi
npm run svc:tokens           # token nội bộ X-Service-Token
npm run stack:up             # 7 DB + RabbitMQ + migration + 8 app, chờ tất cả healthy
```

- Cổng 8080 bị chương trình khác giữ thì thêm `GATEWAY_PUBLISH_PORT=8088` vào `.env` rồi chạy lại `npm run stack:up`. Script demo và test tự đọc biến này.
- `.env` phải để `PAYMENT_SIMULATION_MODE=SUCCEED` (mặc định) để bước 5 và 9 thanh toán thành công.
- Tập dượt một lần: `npm run demo -- --auto` (chạy liền, không dừng).
- Mở sẵn một cửa sổ thứ hai chạy `npm run stack:logs` để cho thấy log song song, và một cửa sổ thứ ba để dán lệnh lọc log mà script in ra ở bước 3 và 8.

## Cách đọc màn hình

Mỗi bước in theo cùng một khuôn: `BƯỚC n/9` và **Mục tiêu** → dòng `…` cho biết script đang làm gì (khi phải chờ thì đếm giây, xong in `→ xong sau x s`) → số liệu đọc từ API, DB và RabbitMQ → dòng **→ Kết luận** chốt điều vừa chứng minh. Người dùng được đặt tên **Tài xế 1, Khách A, Khách B**, mã UUID chỉ in 8 ký tự đầu. Cuối demo có phần **TÓM TẮT** 9 bước.

## Chạy

```powershell
npm run demo
```

| Bước | Script làm gì | Chỉ vào | Phải cho thấy |
|---|---|---|---|
| 1 | Gọi `/health/ready` trong từng container, liệt kê container DB | 8 dòng `200 UP` với `instance` khác nhau; 7 DB riêng | Tên service, mã instance, cổng, health, log song song; 7 container DB riêng |
| 2 | Tạo tài xế, hồ sơ, xe, gửi GPS ZONE_A, bật nhận chuyến | Trạng thái `AVAILABLE`, vị trí mới nhất đọc từ DB Tài xế | Dữ liệu hợp lệ; tài xế là ứng viên đúng vùng |
| 3 | Khách báo giá rồi đặt chuyến | Giá 41.000đ (3 km, 10 phút); bản chụp giá trong DB Chuyến đi; sự kiện `trip.requested` đã `PUBLISHED`; mã theo dõi | Mã báo giá, mã chuyến, bản chụp giá, sự kiện chuyến mới |
| 4 | Chờ lời mời trong Thông báo của tài xế | Việc tìm trong DB Ghép chuyến; lời mời có hạn 15 giây; người nhận đúng tài xế; các hàng đợi của exchange `ride.events` | Việc tìm, lời mời, người nhận, đường đi qua RabbitMQ |
| 5 | Tài xế nhận → bắt đầu → kết thúc | Thao tác nền `SUCCEEDED`; giữ xe `CONFIRMED` rồi `RELEASED`; lịch sử `MATCHING → ASSIGNING → ASSIGNED → IN_PROGRESS → COMPLETED`; thanh toán `SUCCEEDED` lần thử 1; thông báo cho khách | Quy trình nhận chuyến, giữ xe, thanh toán mô phỏng, trạng thái và thông báo |
| 6 | Khách A và Khách B đặt cùng lúc khi chỉ có Tài xế 1; Tài xế 1 bấm nhận cả hai lời mời cùng lúc, hai Saga cùng xin giữ một tài xế | Một chuyến `SUCCEEDED – thắng`; chuyến kia `FAILED_COMPENSATED` (bù trừ, đây là kết quả đúng); lượt giữ xe còn hiệu lực = 1; chuyến thua thành `NO_DRIVER` (tối đa 60 giây) | Một người thắng; người còn lại được xử lý hợp lệ; DB không giữ một tài xế cho hai chuyến |
| 7 | `docker compose stop payment`, chạy một chuyến tới khi kết thúc | Chuyến `COMPLETED`, thanh toán `PENDING`; `GET /payments` trả lỗi có thời hạn còn `GET /trips` vẫn 200; tin nằm chờ ở `payment.events` | Quá thời gian, trạng thái chờ, hàng đợi; phần còn lại vẫn chạy |
| 8 | Đọc hàng chờ gửi (outbox) của Chuyến đi và hàng đợi | `payment.requested` ở trạng thái `PUBLISHED` (RabbitMQ đã nhận và giữ tin, chưa thu tiền); số tin chờ ở `payment.events`; 0 khoản thanh toán; lệnh lọc log theo correlationId và `event_id` (thấy Gateway → Driver → Trip, rồi Payment sau khi bật lại) | Giới hạn thử lại, mã theo dõi, không mất và không thu trùng |
| 9 | `docker compose start payment` | Thanh toán `SUCCEEDED` sau vài giây; 1 khoản, 1 lần thử; hàng đợi về 0 | Tin nhắn chạy tiếp; trạng thái cuối nhất quán; lưu bằng chứng |

Script luôn bật lại Thanh toán kể cả khi dừng giữa bước 7–8.

## Bằng chứng

- Mỗi lần chạy ghi `docs/test-evidence/demo/demo-run.json`: từng bước, mã chuyến, mã sự kiện, kết quả, thời gian; không có token hay mật khẩu.
- Các phần demo không chạy trực tiếp được thì chỉ vào bằng chứng test tương ứng:
  - Thử lại thanh toán tối đa 3 lần, lỗi tạm rồi thành công: `docs/test-evidence/c/recovery.json` (F09).
  - Tin hỏng vào hàng đợi lỗi, consumer chết giữa chừng, RabbitMQ khởi động lại: `docs/test-evidence/c/recovery.json` (R03).
  - Bảo mật S02/S03: `docs/test-evidence/c/security.json`.
  - Luồng đầy đủ, từ chối, hủy: `docs/test-evidence/e2e/happy-path.json`.
  - Tải P01: `docs/test-evidence/performance/p01-load.json`.

## Nếu có sự cố

| Triệu chứng | Xử lý |
|---|---|
| `Gateway ... chưa sẵn sàng` | `npm run stack:ps` xem service nào chưa healthy; `npm run stack:up` lại |
| Bước 4 hoặc 6 chờ lời mời quá 30 giây | Tài xế mất vị trí (quá 60 giây chưa gửi GPS) hoặc đang bận từ lần chạy trước; chạy lại `npm run demo` để tạo tài xế mới |
| Gặp `429` lúc tạo tài khoản | Tài khoản bị giới hạn 10 lần/phút; script tự chờ rồi chạy tiếp |
| Thanh toán vẫn tắt sau khi dừng giữa chừng | `docker compose --env-file .env -f deploy/docker-compose.yml start payment` |
