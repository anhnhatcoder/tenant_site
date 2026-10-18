from django.db import models
from django.contrib.auth.models import AbstractUser

# 0. Bảng Quản lý Người dùng & Phân quyền (Mục 1.2, V & 6.3)
class User(AbstractUser):
    class Role(models.TextChoices):
        SYSTEM_ADMIN = 'SYSTEM_ADMIN', 'System Admin'
        TENANT_ADMIN = 'TENANT_ADMIN', 'Tenant Admin'
        VIEWER = 'VIEWER', 'Viewer (Vận hành)'

    role = models.CharField(
        max_length=20, 
        choices=Role.choices, 
        default=Role.VIEWER,
        verbose_name="Vai trò hệ thống"
    )
    phone_number = models.CharField(max_length=20, blank=True, null=True, verbose_name="Số điện thoại")
    sound_alert_enabled = models.BooleanField(default=True, verbose_name="Bật âm thanh báo động (Mục 6.3)")
    push_notification_enabled = models.BooleanField(default=True, verbose_name="Bật thông báo trình duyệt")

    def __str__(self):
        return f"{self.username} ({self.get_role_display()})"


# 1. Bảng Quản lý Khu vực
class Area(models.Model):
    name = models.CharField(max_length=255, verbose_name="Tên khu vực")
    code = models.CharField(max_length=50, unique=True, verbose_name="Mã khu vực")
    description = models.TextField(blank=True, null=True, verbose_name="Mô tả")

    def __str__(self):
        return str(self.name)


# 2. Bảng Quản lý Thiết bị Cứu hộ (Mục 2 & 3)
class Device(models.Model):
    class DeviceType(models.TextChoices):
        CAMERA = 'CAMERA', 'Camera'
        NUT_NHAN = 'NUT_NHAN', 'Nút nhấn LoRaWAN (WS101/LW006/LW013)'
        GATEWAY = 'GATEWAY', 'Gateway'

    class CategoryType(models.TextChoices):
        CHAY = 'CHAY', 'Cháy'
        AN_NINH = 'AN_NINH', 'An ninh'
        CAP_CUU_Y_TE = 'CAP_CUU_Y_TE', 'Cấp cứu/Y tế'

    class ConnectionStatus(models.TextChoices):
        ONLINE = 'ONLINE', 'Đang kết nối (Xanh lá)'
        SOS = 'SOS', 'Đang phát SOS (Đỏ nhấp nháy)'
        PROCESSING = 'PROCESSING', 'Đang xử lý cứu hộ (Vàng)'
        OFFLINE = 'OFFLINE', 'Mất kết nối (Xám)'
        MAINTENANCE = 'MAINTENANCE', 'Đang bảo trì / Tạm dừng'

    dev_eui = models.CharField(max_length=64, unique=True, db_index=True, verbose_name="DevEUI (64-bit)")
    device_name = models.CharField(max_length=255, verbose_name="Tên thiết bị")
    device_type = models.CharField(max_length=50, choices=DeviceType.choices, default=DeviceType.NUT_NHAN)
    category_type = models.CharField(max_length=50, choices=CategoryType.choices, blank=True, null=True)
    
    # Phân loại cứu hộ (Mục 2.1 & 2.2: Có GPS = Cứu hộ biển, Không GPS = Cứu hộ đất liền cố định)
    has_gps = models.BooleanField(default=False, verbose_name="Có tích hợp GPS (Cứu hộ biển)")
    
    area = models.ForeignKey(Area, on_delete=models.SET_NULL, null=True, blank=True, related_name="devices")
    customer_name = models.CharField(max_length=255, verbose_name="Tên người/đơn vị sở hữu")
    emergency_phone = models.CharField(max_length=20, verbose_name="SĐT liên hệ khẩn cấp (Mục 2.1)")
    address = models.TextField(blank=True, null=True, verbose_name="Địa chỉ tĩnh (Cứu hộ đất liền)")
    
    latitude = models.DecimalField(max_digits=10, decimal_places=8, null=True, blank=True, verbose_name="Vĩ độ")
    longitude = models.DecimalField(max_digits=11, decimal_places=8, null=True, blank=True, verbose_name="Kinh độ")
    
    connection_status = models.CharField(
        max_length=50, 
        choices=ConnectionStatus.choices, 
        default=ConnectionStatus.OFFLINE
    )
    is_active = models.BooleanField(default=True, verbose_name="Đang theo dõi (Mục 2.3)")
    battery_level = models.IntegerField(default=100, verbose_name="Phần trăm pin (%)")
    last_seen = models.DateTimeField(null=True, blank=True, verbose_name="Lần phản hồi cuối")
    description = models.TextField(blank=True, null=True, verbose_name="Ghi chú thiết bị")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=['has_gps', 'connection_status']),
        ]

    def __str__(self):
        return f"{self.device_name} ({self.dev_eui})"


# 3. Bảng Lịch sử & Nhật ký Sự kiện Cứu hộ (Mục 5, 6 & 7)
class AlertLog(models.Model):
    class AlertType(models.TextChoices):
        CHAY = 'CHAY', 'Cháy'
        AN_NINH = 'AN_NINH', 'An ninh'
        CAP_CUU_Y_TE = 'CAP_CUU_Y_TE', 'Cấp cứu/Y tế'
        CUU_HO_BIEN = 'CUU_HO_BIEN', 'Cứu hộ biển khẩn cấp'

    class AlertStatus(models.TextChoices):
        NEW = 'NEW', 'Chưa xử lý (Mới)'
        PROCESSING = 'PROCESSING', 'Đang xử lý'
        RESOLVED = 'RESOLVED', 'Đã hoàn tất'
        FALSE_ALARM = 'FALSE_ALARM', 'Báo động giả'

    alert_type = models.CharField(max_length=50, choices=AlertType.choices, default=AlertType.CAP_CUU_Y_TE)
    status = models.CharField(max_length=50, choices=AlertStatus.choices, default=AlertStatus.NEW)
    device = models.ForeignKey(Device, on_delete=models.CASCADE, related_name="alert_logs")
    area = models.ForeignKey(Area, on_delete=models.SET_NULL, null=True, blank=True)
    
    # Mốc thời gian (Mục 5)
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Thời điểm bấm SOS")
    acknowledged_at = models.DateTimeField(null=True, blank=True, verbose_name="Thời điểm tiếp nhận")
    resolved_at = models.DateTimeField(null=True, blank=True, verbose_name="Thời điểm hoàn tất")
    
    # Người vận hành xử lý (Mục 5 - Bước 3 & Mục 7.1)
    acknowledged_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, 
        related_name="acknowledged_alerts", verbose_name="Người tiếp nhận"
    )
    resolved_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, 
        related_name="resolved_alerts", verbose_name="Người hoàn tất"
    )
    
    # Tọa độ & Địa chỉ đóng băng tại thời điểm phát SOS
    address = models.TextField(blank=True, null=True)
    latitude = models.DecimalField(max_digits=10, decimal_places=8, null=True, blank=True)
    longitude = models.DecimalField(max_digits=11, decimal_places=8, null=True, blank=True)
    
    # Ghi chú điều phối & Báo cáo kết quả (Mục 5 - Bước 4 & 5)
    notes = models.TextField(blank=True, null=True, verbose_name="Ghi chú điều phối (Bước 4)")
    resolution_report = models.TextField(blank=True, null=True, verbose_name="Báo cáo kết quả cứu hộ (Bước 5)")

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['-created_at', 'status']),
            models.Index(fields=['device', '-created_at']),
        ]


# 4. Bảng Lịch sử Tọa độ GPS - Phục vụ Replay hành trình (Mục 4)
class LocationHistory(models.Model):
    device = models.ForeignKey(Device, on_delete=models.CASCADE, related_name="location_histories")
    latitude = models.DecimalField(max_digits=10, decimal_places=8)
    longitude = models.DecimalField(max_digits=11, decimal_places=8)
    speed = models.FloatField(default=0.0, verbose_name="Tốc độ (km/h)")
    battery_level = models.IntegerField(default=100, verbose_name="Pin lúc ghi nhận (%)")
    
    # Đánh dấu các điểm đặc biệt trên hành trình (Mục 4.2)
    is_sos_point = models.BooleanField(default=False, verbose_name="Điểm phát tín hiệu SOS")
    is_drifting = models.BooleanField(default=False, verbose_name="Điểm dừng/trôi dạt (>15 phút)")
    stationary_duration_minutes = models.IntegerField(default=0, verbose_name="Thời gian đứng yên (phút)")
    
    recorded_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['recorded_at']
        indexes = [
            models.Index(fields=['device', 'recorded_at']),
        ]