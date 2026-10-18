# HƯỚNG DẪN ĐÓNG GÓI & TRIỂN KHAI DOCKER TRÊN THIẾT BỊ KHÁC

Tài liệu này hướng dẫn cách sao chép mã nguồn và khởi chạy toàn bộ hệ sinh thái **HC TECH IoT & Maritime SOS Platform** trên bất kỳ máy chủ hoặc thiết bị nào có cài đặt Docker & Docker Compose (Ubuntu, Debian, macOS, Windows, Raspberry Pi,...).

---

## 1. Danh Mục Các Tệp Đóng Gói Cốt Lõi

Trước khi chuyển sang máy khác, đảm bảo thư mục dự án chứa đầy đủ các file sau:

- `requirements.txt`: Khai báo toàn bộ thư viện Python (Django, DRF, psycopg2-binary, requests, asgiref, sqlparse).
- `Dockerfile`: Cấu hình image container Python, cài đặt dependency hệ thống và môi trường chạy.
- `docker-compose.yml`: Điều phối 2 container `django_app` và `postgres_db` kèm cơ chế Healthcheck tự động.
- `entrypoint.sh`: Tự động chờ PostgreSQL sẵn sàng, chạy migrate database, tạo tài khoản quản trị mặc định và nạp dữ liệu mẫu ban đầu nếu database mới.
- `.dockerignore`: Loại bỏ thư mục ảo `.venv`, cache `__pycache__`, logs và file rác khi build image.
- `.env.example`: Mẫu biến môi trường kết nối Database và HC TECH Cloud.

---

## 2. Các Bước Triển Khai Trên Thiết Bị Mới

### Bước 1: Sao chép thư mục dự án sang thiết bị đích
Có thể nén thành file `.zip` hoặc `tar.gz` (loại trừ thư mục `.venv` để tiết kiệm dung lượng):
```bash
# Ví dụ nén thư mục trên máy hiện tại:
tar --exclude='.venv' --exclude='__pycache__' -czvf tenant_site_deploy.tar.gz .
```
Chuyển file sang máy mới và giải nén:
```bash
tar -xzvf tenant_site_deploy.tar.gz -C /path/to/tenant_site
cd /path/to/tenant_site
```

---

### Bước 2: Khởi chạy bằng Docker Compose
Chỉ cần chạy duy nhất 1 câu lệnh để Docker tự động build image và khởi động các dịch vụ:

```bash
docker compose up --build -d
```
*(Nếu dùng phiên bản Docker cũ hơn, dùng lệnh: `docker-compose up --build -d`)*

Container sẽ tự động thực hiện:
1. Chờ PostgreSQL khởi động và vượt qua bài kiểm tra sức khỏe (`service_healthy`).
2. Chạy `python manage.py migrate --noinput` tự động tạo toàn bộ bảng cơ sở dữ liệu.
3. Khởi tạo tài khoản Superuser quản trị hệ thống:
   - **Tài khoản**: `admin`
   - **Mật khẩu**: `1`
   - **Vai trò**: `SYSTEM_ADMIN`
4. Tự động nạp bộ dữ liệu thiết bị LoRaWAN, tọa độ GPS tàu cứu hộ và nhật ký sự cố mẫu nếu database mới tinh.
5. Khởi động Web server tại cổng `5000`.

---

### Bước 3: Kiểm tra trạng thái và nhật ký chạy
Kiểm tra danh sách container:
```bash
docker compose ps
```
Xem log khởi động thời gian thực:
```bash
docker compose logs -f web
```

---

## 3. Địa Chỉ Truy Cập Dịch Vụ

Sau khi khởi chạy thành công, truy cập hệ thống qua trình duyệt:

| Thành phần | Địa chỉ truy cập | Ghi chú |
| :--- | :--- | :--- |
| **Bản đồ Giám sát & Điều phối** | `http://<IP_THIẾT_BỊ>:5000/` | Giao diện hải trình tàu, nút bấm SOS và camera |
| **Trang Đăng Nhập** | `http://<IP_THIẾT_BỊ>:5000/login/` | Tài khoản: `admin` \| Mật khẩu: `1` |
| **Trung Tâm Quản Trị Hệ Thống** | `http://<IP_THIẾT_BỊ>:5000/admin/` | Quản lý Downlink LoRaWAN, Webhook, Telemetry, DB |
| **Django Admin Thuần** | `http://<IP_THIẾT_BỊ>:5000/django-admin/` | Quản trị bảng dữ liệu thô Django Model |
| **Cổng Thu Nhận Webhook Uplink** | `POST http://<IP_THIẾT_BỊ>:5000/api/webhook/uplink/` | Tiếp nhận gói tin từ Gateway LoRaWAN hoặc HC TECH Cloud |

---

## 4. Các Lệnh Quản Trị Hữu Ích

- **Dừng hệ thống**:
  ```bash
  docker compose down
  ```
- **Khởi động lại**:
  ```bash
  docker compose restart
  ```
- **Nạp lại dữ liệu mẫu**:
  ```bash
  docker compose exec web python manage.py seed_data
  ```
- **Chạy lệnh kiểm tra an toàn hệ thống Django**:
  ```bash
  docker compose exec web python manage.py check
  ```
- **Sao lưu cơ sở dữ liệu PostgreSQL ra file sql**:
  ```bash
  docker compose exec -T db pg_dump -U tenant_user tenant_db > backup_database.sql
  ```
- **Khôi phục cơ sở dữ liệu từ file sql**:
  ```bash
  docker compose exec -T db psql -U tenant_user tenant_db < backup_database.sql
  ```
