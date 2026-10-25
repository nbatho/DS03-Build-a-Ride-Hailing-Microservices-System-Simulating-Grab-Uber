# Thứ tự triển khai phần B

Phần B gồm 3 service: **Báo giá** (Pricing, cổng 3007), **Tài xế** (Driver, cổng 3002), **Ghép chuyến** (Matching, cổng 3006).

Căn cứ: [báo cáo BA](D:/Project/bao-cao-ba-ds03/bao-cao-ba-ds03.md). Quy tắc nghiệp vụ nằm ở mục 4, 5, 7, 8; phân công, việc dùng chung và thứ tự merge ở mục 11; danh sách test ở mục 12; đường dẫn API và tên sự kiện tra ở mục 15. File này chỉ ghi **làm gì trước, làm gì sau**.

Bảng DB của B nằm trong migration của từng service: [driver](../../src/services/driver-vehicle-location-service/migrations/1792368000000-initial-driver.ts), [matching](../../src/services/matching-service/migrations/1792368000000-initial-matching.ts), [pricing](../../src/services/pricing-service/migrations/1792368000000-initial-pricing.ts). Bản nháp SQL cho Supabase cũ đã bỏ (19/10/2026).

Ngày ở đây là ngày làm việc tương đối, theo lịch ở mục 11.6 của BA.

## Thay đổi 19/10/2026: mỗi service một DB riêng

Giảng viên yêu cầu mỗi service phải có DB riêng, không được dùng một DB chung chia nhiều schema. Vì vậy **bỏ Supabase**, B chạy **ba PostgreSQL riêng bằng Docker trên máy local** (BA mục 3.2):

| Service | Container DB | Tên database | Cổng trên máy | Schema bên trong |
|---|---|---|---:|---|
| Tài xế (3002) | `driver-db` | `driver_db` | 5542 | `driver_schema` |
| Ghép chuyến (3006) | `matching-db` | `matching_db` | 5546 | `matching_schema` |
| Báo giá (3007) | `pricing-db` | `pricing_db` | 5547 | `pricing_schema` |

- Cách nhớ cổng: số cuối giống cổng service (3002 → 5542).
- Mỗi service chỉ biết địa chỉ DB của chính nó. Ví dụ Ghép chuyến không có địa chỉ `driver-db`, muốn biết tài xế nào rảnh thì phải gọi API tìm ứng viên.
- Tên schema giữ như cũ để không phải sửa bản nháp và code; schema giờ chỉ là tên thư mục bên trong DB riêng.
- Chỉ bước 2, 8 và phần test có thay đổi. Các bước nghiệp vụ (báo giá, giữ xe, ghép chuyến) giữ nguyên.

## Tóm tắt thứ tự

| Bước | Ngày | Việc | Có phải chờ ai không | Giao cho ai |
|---|---|---|---|---|
| 1 | 1 | Viết kiểu dữ liệu API và sự kiện của B | Không | A, C duyệt |
| 2 | 1–2 | Nền: kiểm tra token nội bộ, ba DB riêng bằng Docker và migration, test runner | Không | A, C dùng token nội bộ (ngày 2) |
| 3 | 3 | Chống xử lý trùng, transaction tự thử lại | Không | A (ngày 3) |
| 4 | 3–4 | Báo giá | Không | A (ngày 4) |
| 5 | 3–4 | Tài xế: hồ sơ, xe, GPS, bật/tắt, tìm ứng viên | Không | — |
| 6 | 5 | Tài xế: giữ xe, worker hết hạn, mô phỏng GPS | Không | A (ngày 5) |
| 7 | 4–6 | Ghép chuyến | Dùng bản giả của Chuyến đi và RabbitMQ dev | A, C (ngày 6) |
| 8 | 6 | Dockerfile ba service, khai báo ba DB cho Compose chung | Không | C (ngày 6) |
| 9 | 4–7 | Nối thật với A và C | Có | — |
| 10 | 8–17 | Test và sửa lỗi | Có | — |
| 11 | 18–20 | Bàn giao | Có | — |

Mỗi bước xong thì mở một PR nhỏ và merge vào `main` ngay; không gom nhiều bước rồi merge một lần (BA mục 11.4).

## Bước 1. Kiểu dữ liệu API và sự kiện của B (ngày 1)

B là bên cung cấp, nên phải viết trước để A và C làm bản giả đúng.

- [ ] Tạo file trong `src/packages/contracts`, mỗi service một file:
  - `dtos/pricing.ts`: báo giá (tạo, xem, đọc nội bộ).
  - `dtos/driver.ts`: hồ sơ, xe, vị trí, bật/tắt, ứng viên, giữ xe (giữ, xem, xác nhận, trả).
  - `dtos/matching.ts`: việc tìm tài xế, lời mời, nhận/từ chối, báo kết quả cuối, hủy việc tìm.
  - `events/matching.ts`: sự kiện "có lời mời mới", "không tìm được tài xế".
- [ ] Lấy đúng field theo Phụ lục B, C của BA và `openapi.json`, `events.schema.json`; không tự thêm bớt.
- [ ] Gửi A duyệt phần A dùng (báo giá nội bộ, giữ xe, việc tìm, lời mời, "không tìm được tài xế"); gửi C duyệt sự kiện "có lời mời mới".
- [ ] Nhờ nhóm xác nhận ba điểm còn là đề xuất (BA mục 11.2):
  - Tài xế chưa có hồ sơ mà gửi vị trí hoặc bị gọi trả xe: báo 409 "tài xế chưa có hồ sơ".
  - Tên biến môi trường, image, cách đặt tên token nội bộ.
  - B giữ phần kiểm tra token nội bộ và chống xử lý trùng trong `@app/runtime`.

**Xong khi:** contracts build được, A và C đã duyệt.

## Bước 2. Nền (ngày 1–2)

- [x] **Kiểm tra token nội bộ** trong `src/packages/runtime`: header `X-Service-Token`, mỗi cặp bên gọi → bên nhận một token, bên nhận suy ra bên gọi từ token, có danh sách bên được gọi cho từng API. Giao cho A và C ngày 2. Đã có `@InternalRoute`, `InternalCallerGuard`, `InternalHttpClient`, `npm run svc:tokens`, `npm run test:runtime:unit` (xem README, mục "Gọi API nội bộ").
- [x] **Ba DB riêng bằng Docker:** file `deploy/b-dev.compose.yml` gồm ba container `driver-db`, `matching-db`, `pricing-db` (image `postgres:17-bookworm`, cổng như bảng ở trên, chỉ mở `127.0.0.1`, mỗi container một volume). Làm theo mẫu `deploy/identity-dev.compose.yml` của A.
- [x] **Init SQL, mỗi DB một file:** `deploy/postgres/driver-init.sql`, `matching-init.sql`, `pricing-init.sql`. Mỗi file tạo user ứng dụng (ví dụ `driver_app`, chỉ đọc/ghi dữ liệu) và user migration (ví dụ `driver_migrator`, tạo bảng), rồi tạo schema.
- [x] **Migration và DataSource:** mỗi service có `src/database/options.ts` (kiểm tra URL đúng DB, đúng user) và `data-source.ts`; tắt `synchronize`; migration bảng trong `migrations/`. Làm theo mẫu Identity của A.
- [x] **Nối DB vào app:** cả Pricing, Driver và Matching đã có TypeORM và readiness kiểm tra DB (25/10/2026). Matching kiểm tra thêm consumer RabbitMQ.
- [x] **Lệnh npm:** `b:setup:dev`, `b:db:up|stop|start|status` (gọi thẳng `docker compose`), `migration:b:run`, `migration:<driver|matching|pricing>:run|revert`, `b:db:verify` (xem README, mục DB của B). Chỉ còn 2 script trong `scripts/b/`: tạo biến `.env` và kiểm tra DB.
- [x] **Test runner:** cả ba service có `test:<pricing|driver|matching>:unit|integration`; PostgreSQL/RabbitMQ test là container riêng, tách khỏi dev. `npm test` bao gồm Matching.
- [x] Tạo thư mục `scripts/fakes/` cho các bản giả.
- [x] Thêm khối biến của ba service vào `.env.example`: cổng, `*_DATABASE_URL`, `*_MIGRATION_DATABASE_URL`, `*_DB_SCHEMA`, mật khẩu để `<local-only>`. Ví dụ `DRIVER_DATABASE_URL=postgresql://driver_app:<local-only>@127.0.0.1:5542/driver_db`.

**Xong khi:** ba DB chạy riêng, mỗi service nối đúng DB của mình bằng user ứng dụng; tắt `pricing-db` thì chỉ Báo giá báo chưa sẵn sàng, Tài xế và Ghép chuyến vẫn chạy; gọi API nội bộ sai token bị từ chối; test runner chạy được.

## Bước 3. Chống xử lý trùng (ngày 3)

- [x] Công cụ chống gửi trùng request (theo `Idempotency-Key`) và chống trùng lệnh nội bộ (theo mã lệnh), lưu trong cùng transaction với thay đổi nghiệp vụ. (`withIdempotencyKey`, `withCommandResult`)
- [x] Transaction tự thử lại khi bị kẹt khóa (deadlock, serialization), có giới hạn số lần. (`runInTransaction`)
- [x] Dấu vân tay body đã chuẩn hóa: cùng key cùng body trả lại kết quả cũ; cùng key khác body báo 409.
- [x] Đặt trong `@app/runtime`, giao A dùng cho Chuyến đi. Test `npm run test:runtime:db` (10 request đồng thời cùng key chỉ ghi một lần; deadlock thật được chạy lại).

**Xong khi:** test gửi đồng thời cùng key chỉ ghi một lần.

## Bước 4. Báo giá (ngày 3–4)

- [x] Migration bảng giá, báo giá, chống trùng vào `pricing_db`; nạp bảng giá ô tô bản 1 (12.000 / 8.000 / 500).
- [x] Hàm tính giá dùng số nguyên lớn (BigInt), làm tròn lên từng phần, tiền trả dạng chuỗi.
- [x] Xin báo giá: bắt buộc `Idempotency-Key`; mã khách lấy từ JWT; hạn 300 giây tính bằng giờ DB; trả 201. Không có bảng giá thì báo 503.
- [x] Xem báo giá của mình: chỉ chủ xem được; báo giá hết hạn vẫn trả 200.
- [x] Đọc báo giá nội bộ: chỉ Chuyến đi gọi được.
- [x] Test: 3.000 m / 600 giây = `"41000"`; 1 m / 1 giây = `"12017"`; gửi đồng thời cùng key chỉ tạo một báo giá; thêm bảng giá mới không đổi báo giá cũ.

**Hiện trạng 25/10/2026:** nghiệp vụ Pricing, DB/readiness và test riêng đã triển khai; hướng dẫn ở [Pricing](../services/pricing-service.md). Còn kiểm tra A gọi API từ Chuyến đi thật ở bước 9.

**Xong khi:** A gọi được API đọc báo giá nội bộ (ngày 4).

## Bước 5. Tài xế: hồ sơ, xe, GPS, bật/tắt, tìm ứng viên (ngày 3–4)

Làm theo thứ tự:

- [x] Migration hồ sơ, xe, vị trí mới nhất, giữ xe, chống trùng, kết quả lệnh vào `driver_db` (đã có trong migration; bước này chỉ còn entity/repository).
- [x] Một hàm dùng chung tính "tài xế có đủ điều kiện nhận chuyến không" và trạng thái hiển thị, để các API sau dùng lại.
- [x] Tạo/cập nhật hồ sơ; xem hồ sơ (chưa có GPS thì số thứ tự vị trí = 0; chưa có hồ sơ báo 404).
- [x] Đăng ký xe (bắt buộc `Idempotency-Key`; biển số chuẩn hóa không trùng; mỗi tài xế một xe; trả 201); xem xe của mình.
- [x] Gửi vị trí GPS: chỉ ghi khi số thứ tự mới hơn; cùng số thứ tự cùng nội dung thì trả lại kết quả cũ; giờ client lệch quá 60 giây thì báo lỗi. **Gửi GPS không tăng phiên bản hồ sơ**, nếu không bật/tắt sẽ luôn bị xung đột phiên bản.
- [x] Bật/tắt nhận chuyến: bắt buộc `Idempotency-Key`; gửi kèm phiên bản; bật cần đủ hồ sơ, xe, GPS còn mới; đang giữ chuyến thì không tắt được.
- [x] Tìm ứng viên (nội bộ, chỉ Ghép chuyến gọi): cùng vùng, đang bật, có xe, GPS còn mới, chưa bị giữ; sắp theo mã tài xế tăng dần; giới hạn 1–10.

**Xong khi:** Test 2 (đưa tài xế vào nhận chuyến) đạt; hai request đăng ký xe đồng thời không phá ràng buộc.

## Bước 6. Tài xế: giữ xe, worker hết hạn, mô phỏng GPS (ngày 5)

- [x] Giữ xe: mã giữ xe = mã lượt gán do Chuyến đi gửi; giữ 30 giây; gửi lặp cùng mã trả lại lượt cũ, **không gia hạn**; cùng mã khác chuyến/tài xế/lời mời thì báo xung đột.
- [x] Xem trạng thái giữ xe: trả cả lượt đã trả và đã hết hạn.
- [x] Xác nhận giữ xe: chỉ khi còn hạn và đúng chủ; kiểm tra hạn bằng giờ DB tại lúc đã khóa dòng.
- [x] Trả xe: chưa có lượt giữ thì vẫn ghi dấu "đã trả", để lệnh giữ xe đến muộn bị chặn.
- [x] Worker hết hạn: chuyển lượt "đang giữ" quá hạn sang "hết hạn"; không đụng lượt "đã xác nhận".
- [x] Mọi thao tác khóa theo cùng thứ tự: **khóa tài xế trước, rồi mới khóa lượt giữ**.
- [x] Công cụ mô phỏng GPS gửi 5 giây/lần; khởi động lại thì đọc lại số thứ tự. `npm run simulate:driver`.
- [x] Dữ liệu mẫu: tài xế tạo qua đăng ký và đăng nhập thật ở Tài khoản, không tự tạo mã người dùng. `npm run demo:driver`.
- [x] Test trên container PostgreSQL thật của Tài xế: hai lệnh giữ xe cùng lúc; xác nhận đua với hết hạn; tắt nhận chuyến đua với giữ xe; trả xe trước rồi giữ xe đến muộn.

**Hiện trạng 25/10/2026:** đã triển khai nghiệp vụ Driver, DB/readiness, worker và demo/simulator; xem [hướng dẫn Driver](../services/driver-vehicle-location-service.md). Còn nối Chuyến đi/Ghép chuyến thật và Gateway ở bước 9.

**Xong khi:** A gọi được giữ, xem, xác nhận, trả xe (ngày 5); mỗi tài xế và mỗi chuyến tối đa một lượt giữ còn hiệu lực.

## Bước 7. Ghép chuyến (ngày 4–6, dùng bản giả)

Chuẩn bị bản giả trong `scripts/fakes/`:

- [x] Bản giả Chuyến đi: trả trạng thái chuyến theo file JSON, có kiểm tra token nội bộ (`matching:fake-trip`).
- [x] Script gửi sự kiện "có chuyến mới" và "chuyến bị hủy" vào RabbitMQ dev (`matching:emit`), có file mẫu theo BA.

Làm theo thứ tự:

- [x] Migration việc tìm, tài xế đã mời, lời mời, sự kiện đã xử lý, sự kiện chờ gửi, kết quả lệnh vào `matching_db` (đã có trong migration; bước này chỉ còn entity/repository).
- [x] Hàm khóa việc tìm và các hàm đổi trạng thái có kiểm tra, dùng chung cho API và worker.
- [x] Nhận sự kiện "có chuyến mới": bỏ trùng và tạo việc tìm trong cùng transaction, xác nhận với RabbitMQ sau khi ghi.
- [x] Nhận sự kiện "chuyến bị hủy": ghi dấu "đã hủy" kể cả khi chưa có việc tìm; sự kiện "có chuyến mới" đến muộn không mở lại.
- [x] Client gọi Tài xế tìm ứng viên: chờ 2 giây, tối đa 3 lần, gọi ngoài transaction.
- [x] Worker tìm: tối đa 5 tài xế, tổng 60 giây (hạn tính một lần, không gia hạn); tạo lời mời mở 15 giây và sự kiện chờ gửi trong cùng transaction.
- [x] Lời mời hết hạn hoặc bị từ chối thì mời người tiếp; hết người hoặc hết giờ thì gửi "không tìm được tài xế" đúng một lần.
- [x] Gửi sự kiện từ hàng chờ gửi bằng adapter amqplib mỏng trong Matching; sẽ thay bằng `@app/messaging` khi C bàn giao.
- [x] Xem việc tìm theo mã chuyến; xem lời mời.
- [x] Hủy việc tìm: theo mã lệnh; phiên bản chuyến không được lùi.
- [x] Nhận/từ chối lời mời: mã lượt gán làm mã quyết định; "nhận" chuyển lời mời từ đang mở sang đã được giành; "từ chối" chuyển sang đã từ chối rồi mời tiếp.
- [x] Báo kết quả cuối: đã gán, thử lại, đã hủy; không mở lại việc tìm đã hủy.
- [x] Đối soát lời mời bị kẹt ở "đã được giành": hỏi trạng thái chuyến (bản giả), không tự cho hết hạn.
- [x] Test: sự kiện trùng hoặc đảo thứ tự không tạo việc tìm/lời mời lặp; hai yêu cầu nhận cùng lúc chỉ một bên thắng.

**Hiện trạng 25/10/2026:** Matching có DB/readiness, 5 API, consumer/outbox, worker và test riêng; xem [hướng dẫn Matching](../services/matching-service.md). Bộ test chung đạt 65/65; còn nối Trip/Notification thật và thư viện messaging của C.

**Xong khi:** A gọi được các API việc tìm và lời mời; C nhận được sự kiện "có lời mời mới" (ngày 6).

## Bước 8. Dockerfile và DB cho Compose chung (ngày 6)

- [ ] Dockerfile cho ba service, build độc lập.
- [ ] Gửi C phần khai báo ba DB (`driver-db`, `matching-db`, `pricing-db`, volume, file init SQL) để ghép vào Compose chung. Trong Compose, service gọi DB bằng tên container và cổng 5432 (ví dụ `driver-db:5432`), không dùng `127.0.0.1:5542`.
- [ ] Hướng dẫn chạy migration và nạp dữ liệu mẫu cho từng DB; gửi C để ghép vào Compose.

## Bước 9. Nối thật (ngày 4–7)

Mỗi lần nối một chỗ: đổi env từ bản giả sang bản thật, chạy lại test, sửa lỗi và merge ngay trong ngày (BA mục 11.4).

| Ngày | Nối chỗ nào | Vai trò của B |
|---|---|---|
| 3 | Token của Tài khoản ở Báo giá, Tài xế | Kiểm tra token thật qua được guard |
| 4 | Chuyến đi gọi Báo giá thật | **B dẫn** |
| 5 | Chuyến đi → RabbitMQ → Ghép chuyến | **B dẫn** |
| 5–6 | Ghép chuyến → Tài xế → lời mời → Thông báo | Hỗ trợ C |
| 6 | Quy trình nhận/từ chối của A ↔ Tài xế, Ghép chuyến | Hỗ trợ A |
| 7 | Toàn luồng qua Gateway | Sửa lỗi phía B |

Kèm theo: mở PR thêm các đường public của B vào danh sách đường Gateway (C duyệt).

**Xong khi:** ngày 7 chạy trọn luồng đăng nhập → báo giá → đặt chuyến → nhận → bắt đầu → kết thúc → thanh toán xong.

## Bước 10. Test và sửa lỗi (ngày 8–17)

| Ngày | Việc của B | Test liên quan (BA mục 12) |
|---|---|---|
| 8 | Hủy việc tìm có dấu; từ chối, hết hạn thì mời tiếp | Test 6, hỗ trợ Test 7 |
| 9 | Chống giữ một tài xế cho hai chuyến; hết hạn giữ xe | **Test 9**, hỗ trợ Test 10 |
| 10 | Hoàn thiện ba service | Đủ chức năng hoặc có issue chặn |
| 11 | Mất phản hồi khi giữ, xác nhận xe; dấu "đã trả" | Hỗ trợ Test 12 |
| 12 | Kiểm tra cách ly dữ liệu: env của Ghép chuyến và Báo giá không có địa chỉ `driver-db`; việc tìm bị treo | Hỗ trợ Test 14 |
| 13 | Tài xế chậm phản hồi; dọn sau khởi động lại; tắt rồi bật lại `driver-db` | Hỗ trợ Test 12 |
| 14 | Sửa lỗi tranh chấp, sai thứ tự | Mốc: 2 test đồng thời + 2 test phục hồi đạt |
| 15 | Test chức năng ba service; chuẩn bị tải | **Test 2, Test 3**, hỗ trợ Test 21 |
| 16 | Chạy tải và phân tích (C chạy bộ test) | **Test 15** |
| 17 | Chạy lại đồng thời và tải nếu đã sửa | Đủ 15 test bắt buộc |

Mỗi test lưu bằng chứng theo BA mục 12.2. Test 5, 9, 12 phải chạy với service thật, không tính kết quả chạy với bản giả.

## Bước 11. Bàn giao (ngày 18–20)

- [ ] Ngày 18: dựng máy sạch (ba DB tạo lại từ đầu bằng Compose và init SQL), nạp dữ liệu; duyệt cổng và env.
- [ ] Ngày 19: phần báo cáo của B (thiết kế ba DB, test, tải, phần việc); đóng băng tính năng.
- [ ] Ngày 20: kiểm tra code, service, dữ liệu bàn giao.
