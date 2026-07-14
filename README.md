# Nixart — Discord commerce + self-hosted HLS

> Triển khai theo hai host: `nixart.io.vn` ở Render cho landing; `learn.nixart.io.vn` đi qua Cloudflare Tunnel tới máy cá nhân để chạy bot, OAuth, webhook SePay, kiểm quyền và phát video. Cả hai dùng chung PostgreSQL/Neon.

```text
nixart.io.vn (Render)              learn.nixart.io.vn
└── landing page                   └── Cloudflare Tunnel ── máy cá nhân
                                      ├── Discord bot + OAuth2
                                      ├── /api/sepay + PostgreSQL
                                      └── HLS .m3u8 + .ts
```

DNS hiện dùng Cloudflare; `PUBLIC_BASE_URL` của bot phải là `https://learn.nixart.io.vn` vì Render không chứa thư mục video.

Một tiến trình Node chạy trên máy cá nhân:

- landing page thông báo chuyển sang Discord;
- Discord bot `/mua` và `/hoc`;
- Discord OAuth2 để nhận diện người học;
- SePay xác nhận đơn và mở quyền mua lẻ/gói 30 ngày;
- phát HLS `.m3u8` + `.ts` với cookie HMAC theo từng bài.

Bot chỉ gửi URL bài học. Website kiểm tra lại quyền nên chia sẻ URL không cấp quyền cho tài khoản khác.

## 1. Chuẩn bị

- Node.js 22+
- FFmpeg trong `PATH`
- `cloudflared` 2026.7.1+ (đã cài trên máy triển khai)
- PostgreSQL/Neon
- Discord Application có Bot và OAuth2
- Domain được thêm vào Cloudflare DNS

```powershell
Copy-Item .env.example .env
npm ci
```

Điền `.env`. Tạo secret HLS, ví dụ:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Trong Discord Developer Portal:

1. OAuth2 Redirect URI phải giống hệt `DISCORD_REDIRECT_URI`: `https://learn.nixart.io.vn/api/discord-auth`.
2. Mời bot bằng scopes `bot` và `applications.commands`.
3. Bot chỉ cần quyền gửi tin nhắn và embed; không cần Message Content Intent.
4. Điền `DISCORD_GUILD_ID` để slash command cập nhật ngay trong server thử nghiệm; bỏ trống để đăng ký global.

## 2. Khai báo khóa học

Sửa `content/catalog.json`. ID chỉ dùng chữ thường, số, `_` hoặc `-`. Bật `published: true` sau khi đã có video.

```json
{
  "id": "blender-co-ban",
  "title": "Blender cơ bản",
  "description": "Khóa học từ nhập môn.",
  "price": 350000,
  "planTier": "basic",
  "published": true,
  "lessons": [
    { "id": "giao-dien", "title": "Làm quen giao diện", "published": true }
  ]
}
```

- `planTier: "basic"`: cả gói 200k và 500k đều xem được.
- `planTier: "full"`: chỉ gói 500k hoặc người mua lẻ xem được.
- Mua lẻ không hết hạn; gói tháng cộng dồn 30 ngày khi gia hạn cùng loại.

Khởi động lại Node sau khi sửa catalog.

## 3. Đóng gói video HLS

```powershell
.\scripts\package-hls.ps1 `
  -InputFile 'D:\Videos\giao-dien.mp4' `
  -CourseId 'blender-co-ban' `
  -LessonId 'giao-dien'
```

Kết quả:

```text
media/blender-co-ban/giao-dien/
├── index.m3u8
├── seg_00000.ts
├── seg_00001.ts
└── ...
```

Video mặc định được encode 720p H.264/AAC, segment 6 giây. Thư mục `media/` bị Git bỏ qua để tránh đẩy video lên GitHub.

Script tạo segment có tên theo phiên bản và chỉ thay `index.m3u8` sau khi encode thành công, nên người đang xem không nhận file dở dang. Segment phiên bản cũ được giữ lại; có thể xóa chúng sau khi không còn phiên xem cũ (nên chờ ít nhất hai giờ).

## 4. Cloudflare Tunnel

Mạng triển khai đã được kiểm tra: nhiều lớp NAT, không có IPv6, nên không mở port trực tiếp. Cloudflare Tunnel tạo kết nối đi ra ngoài từ máy nhà; không cần VPS, IP public, DDNS hoặc port forwarding.

Domain hiện dùng nameserver Cloudflare `graham.ns.cloudflare.com` và `katelyn.ns.cloudflare.com`. Các record chính:

```text
@     A       216.24.57.1
www   CNAME   nixart-web.onrender.com
@     MX 0    nixart.io.vn
```

Trong Cloudflare:

1. Thêm `nixart.io.vn`, nhập các record phía trên rồi đổi nameserver tại Tino.
2. Vào **Networking → Tunnels**, tạo tunnel `nixart-home`.
3. Chọn Windows và tạo credentials cục bộ trong `%USERPROFILE%\.cloudflared`. Không lưu token, `cert.pem` hoặc file credentials trong Git.
4. Thêm Published application: hostname `learn.nixart.io.vn`, service URL `http://localhost:3000`.

Cloudflare tự tạo CNAME `<UUID>.cfargotunnel.com` trong cùng tài khoản. Tài liệu chính thức: [tạo tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) và [DNS record của tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/).

## 5. Chạy trên máy cá nhân

```powershell
npm start
```

Kiểm tra `http://localhost:3000/health`, sau đó kiểm tra `https://learn.nixart.io.vn/health`. Chỉ khi cả hai trả `200` mới đổi landing page chính.

Tắt Sleep cho máy trước khi bán dịch vụ. Trên máy triển khai, Task Scheduler chạy `scripts/run-local-stack.ps1` ở mỗi lần đăng nhập và tự giám sát cả Node lẫn `cloudflared`.

## 6. SePay

- Webhook: `https://learn.nixart.io.vn/api/sepay`
- Method: `POST`
- Header: `Authorization: Apikey <SEPAY_API_KEY>`

Máy cá nhân dùng cùng `DATABASE_URL` với Render và phải có `SEPAY_API_KEY` khớp cấu hình API Key trong SePay. Bot tạo nội dung chuyển khoản dạng `NIX...`; người mua phải chuyển đúng nội dung và số tiền.

## Luồng sử dụng

1. Người dùng chạy `/mua`, chọn khóa hoặc gói tháng và nhận QR.
2. SePay báo tiền vào; server mở quyền cho đúng Discord ID.
3. Người dùng chạy `/hoc`, chọn khóa và bài.
4. Bot gửi `/learn?course=...&lesson=...`.
5. Website yêu cầu Discord OAuth, kiểm quyền rồi cấp cookie phát HLS trong một giờ.

Đơn HLS hết hiệu lực sau 30 phút để giá cũ không được sử dụng về sau. Nếu đã chuyển khoản sau thời hạn này, admin cần đối soát và xử lý thủ công.

HLS và cookie ký hạn chế chia sẻ link nhưng không phải DRM và không thể ngăn quay màn hình tuyệt đối.
