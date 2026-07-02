# Nixart Web

Trang tiến độ và bán khóa học, triển khai trên Netlify với Neon PostgreSQL.

## Luồng đặt mua

1. Khách mở một khóa học đang bán và quét VietQR.
2. Khách chuyển đúng số tiền, dùng mã `NIX...` làm nội dung chuyển khoản.
3. Khách nhập email Google và báo đã chuyển tiền.
4. Website lưu đơn trong Neon và gửi thông báo vào Discord.
5. Admin mở link trong Discord, kiểm tra ứng dụng ngân hàng rồi chấp nhận hoặc từ chối.
6. Khi chấp nhận, service account thêm email khách vào thư mục Google Drive với quyền Viewer.

Việc nhận tiền không được xác minh tự động. Admin phải kiểm tra giao dịch ngân hàng trước khi chấp nhận.

## Biến môi trường Netlify

Giữ lại các biến đang dùng:

- `DATABASE_URL`: connection string Neon PostgreSQL.
- `ADMIN_PASSWORD`: mật khẩu lưu dữ liệu trong trang quản trị.

Thêm hai biến mới:

- `DISCORD_WEBHOOK_URL`: webhook của channel nhận thông báo đơn hàng.
- `GOOGLE_SERVICE_ACCOUNT_JSON`: toàn bộ nội dung file JSON của Google service account, để trên một dòng.

Netlify tự cung cấp biến `URL`; link duyệt đơn sẽ dùng domain production này.

## Tài khoản khách hàng

Đăng ký/đăng nhập email và mật khẩu chạy trực tiếp trên Neon qua Netlify Functions, không cần OAuth hoặc biến môi trường bổ sung. Đăng nhập chỉ bắt buộc khi mua sản phẩm loại `Tài khoản`; khóa học và tài nguyên miễn phí không đổi.

Mật khẩu được băm bằng scrypt và phiên đăng nhập lưu trong cookie HttpOnly/Secure. Bản MVP chưa có xác minh email hoặc quên mật khẩu vì hai chức năng này cần cấu hình dịch vụ gửi mail.

## Cấu hình Google Drive

1. Tạo project trong Google Cloud Console.
2. Bật Google Drive API.
3. Tạo service account và tải JSON key.
4. Đặt JSON key vào biến `GOOGLE_SERVICE_ACCOUNT_JSON` trên Netlify.
5. Chia sẻ từng thư mục khóa học cho `client_email` trong JSON với quyền Editor. Không chia sẻ thư mục công khai.
6. Copy phần ID trong URL thư mục Drive, ví dụ URL `https://drive.google.com/drive/folders/ABC123` có folder ID là `ABC123`.

## Cấu hình website

1. Nhấp logo `VOICE STUDIO` ba lần để mở quản trị.
2. Nhập mật khẩu admin.
3. Điền mã ngân hàng/BIN, số tài khoản và tên chủ tài khoản.
4. Sửa từng khóa học, điền mô tả, giá và Google Drive folder ID.
5. Bật `Cho phép đặt mua khóa học này` rồi lưu.

Folder ID không được trả về API công khai. Khi sửa lại khóa học đã có Drive, có thể để trống trường này để giữ cấu hình cũ.

## Chạy kiểm tra

```bash
npm install
npx netlify dev
```

Luồng Discord và Drive cần các biến môi trường thật. Nên thử bằng một khóa học giá nhỏ và một thư mục Drive thử nghiệm trước khi mở bán.
