FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Cài đặt các thư viện hệ thống cần thiết cho PostgreSQL client và build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt-get/lists/*

# Cài đặt các gói Python từ requirements.txt
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Sao chép toàn bộ mã nguồn dự án vào container
COPY . /app/

# Cấp quyền thực thi cho kịch bản khởi động tự động
RUN chmod +x /app/entrypoint.sh

EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "tenant_site.asgi:application", "--host", "0.0.0.0", "--port", "5000"]