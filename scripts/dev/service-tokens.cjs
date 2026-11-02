// Ghi token nội bộ X-Service-Token và địa chỉ service vào .env (không in token).
// Chạy lại nhiều lần không đổi token đã có; chỉ điền biến còn thiếu hoặc đang rỗng.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const root = path.resolve(__dirname, '../..');

// Cặp bên gọi -> bên nhận theo x-callers trong openapi.json của BA. Thêm API nội bộ mới thì thêm cặp ở đây.
const pairs = [
  ['TRIP', 'PRICING'], // API-17 đọc báo giá
  ['TRIP', 'DRIVER'], // API-11..14 giữ/xem/xác nhận/trả xe
  ['TRIP', 'MATCHING'], // API-29..32, 40 việc tìm và lời mời
  ['TRIP', 'PAYMENT'], // API-35 đối soát thanh toán
  ['MATCHING', 'DRIVER'], // API-10 tìm ứng viên
  ['MATCHING', 'TRIP'], // API-27 hỏi trạng thái chuyến
  ['DRIVER', 'TRIP'], // API-27
  ['PAYMENT', 'TRIP'], // API-27
  ['OPS', 'TRIP'], // API-28 người vận hành chạy lại thao tác
];

// Địa chỉ bên nhận khi chạy dev trên máy; trong Compose đổi thành tên service, ví dụ http://driver-vehicle-location-service:3002.
const baseUrls = {
  DRIVER_BASE_URL: 'http://127.0.0.1:3002',
  TRIP_BASE_URL: 'http://127.0.0.1:3003',
  PAYMENT_BASE_URL: 'http://127.0.0.1:3004',
  MATCHING_BASE_URL: 'http://127.0.0.1:3006',
  PRICING_BASE_URL: 'http://127.0.0.1:3007',
};

const wanted = new Map([
  ...pairs.map(([caller, receiver]) => ['SVC_TOKEN_' + caller + '_' + receiver, () => randomBytes(32).toString('base64url')]),
  ...Object.entries(baseUrls).map(([key, value]) => [key, () => value]),
]);

const envFile = path.join(root, '.env');

if (!fs.existsSync(envFile)) {
  console.error('.env not found; run npm run identity:setup:dev first, then run this again.');
  process.exitCode = 1;
} else {
  const original = fs.readFileSync(envFile, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const filled = new Set();
  const present = new Set();

  // Biến đã có nhưng rỗng (copy từ .env.example) thì điền tại chỗ.
  const output = lines.map(line => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);

    if (!match || !wanted.has(match[1])) {
      return line;
    }

    present.add(match[1]);

    if (match[2].trim()) {
      return line;
    }

    filled.add(match[1]);

    return match[1] + '=' + wanted.get(match[1])();
  });

  const appended = [...wanted.keys()].filter(key => !present.has(key)).map(key => key + '=' + wanted.get(key)());

  if (!filled.size && !appended.length) {
    console.log('Service tokens and base URLs already configured in .env.');
  } else {
    while (output.length && output[output.length - 1] === '') {
      output.pop();
    }

    if (appended.length) {
      output.push('', '# Token nội bộ X-Service-Token và địa chỉ service, tạo bởi npm run svc:tokens', ...appended);
    }

    fs.writeFileSync(envFile, [...output, ''].join(eol));
    console.log('Updated .env: ' + (filled.size + appended.length) + ' service token/base URL variables. No secrets printed.');
  }
}
