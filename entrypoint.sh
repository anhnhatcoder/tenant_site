#!/bin/bash
set -e

echo "=========================================================="
echo "🚀 HC TECH IoT Platform - Initializing Container Startup"
echo "=========================================================="

# 1. Chờ PostgreSQL sẵn sàng kết nối
echo "⏳ [1/3] Đang chờ cơ sở dữ liệu PostgreSQL ($DB_HOST:$DB_PORT)..."
python - << 'EOF'
import socket
import time
import os
import sys

host = os.environ.get('DB_HOST', 'db')
port = int(os.environ.get('DB_PORT', 5432))
timeout = 60
start = time.time()

while True:
    try:
        with socket.create_connection((host, port), timeout=2):
            print(f"✔ Đã kết nối thành công tới PostgreSQL tại {host}:{port}!")
            sys.exit(0)
    except (socket.error, OSError):
        if time.time() - start > timeout:
            print(f"✖ Hết thời gian chờ (timeout {timeout}s) kết nối PostgreSQL!")
            sys.exit(1)
        time.sleep(1)
EOF

# 2. Tự động áp dụng Migration vào Database
echo "📦 [2/3] Thực hiện migrate cơ sở dữ liệu..."
python manage.py migrate --noinput

# 3. Đảm bảo tài khoản mặc định và dữ liệu ban đầu
echo "👤 [3/3] Khởi tạo tài khoản quản trị mặc định và kiểm tra dữ liệu..."
python - << 'EOF'
import django
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tenant_site.settings')
django.setup()

from Server_tenant.views import ensure_default_accounts
from Server_tenant.models import Device
from django.core.management import call_command

ensure_default_accounts()
print("✔ Tài khoản quản trị mặc định (admin / pass: 1) đã sẵn sàng.")

# Nếu DB hoàn toàn mới (chưa có thiết bị nào), tự động nạp dữ liệu mẫu ban đầu
if Device.objects.count() == 0:
    print("✨ Cơ sở dữ liệu mới tinh, đang nạp dữ liệu thiết bị và hành trình mẫu...")
    try:
        call_command('seed_data')
        print("✔ Đã nạp thành công bộ dữ liệu mẫu!")
    except Exception as e:
        print(f"⚠ Lỗi nạp seed_data: {e}")
EOF

echo "=========================================================="
echo "🎉 Khởi động máy chủ: $@"
echo "=========================================================="
exec "$@"
