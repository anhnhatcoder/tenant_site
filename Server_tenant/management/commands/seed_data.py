import random
from datetime import timedelta
from decimal import Decimal
from django.core.management.base import BaseCommand
from django.utils import timezone
from Server_tenant.models import User, Area, Device, AlertLog, LocationHistory


class Command(BaseCommand):
    help = "Khởi tạo dữ liệu mẫu phong phú cho hệ thống Quản Lý Cứu Hộ HC TECH"

    def handle(self, *args, **options):
        self.stdout.write("--- Bắt đầu khởi tạo dữ liệu mẫu ---")

        now = timezone.now()

        # 1. Khởi tạo / cập nhật tài khoản người dùng
        u_admin, created = User.objects.get_or_create(
            username='admin',
            defaults={
                'first_name': 'Nguyễn Bảo Nguyên',
                'email': 'admin@hctech.com.vn',
                'role': User.Role.TENANT_ADMIN,
                'phone_number': '0905111222',
                'is_staff': True,
                'is_superuser': True,
            }
        )
        u_admin.set_password('1')
        u_admin.is_staff = True
        u_admin.is_superuser = True
        u_admin.role = User.Role.SYSTEM_ADMIN
        u_admin.save()

        u_viewer, _ = User.objects.get_or_create(
            username='viewer',
            defaults={
                'first_name': 'Vận Hành Viên',
                'email': 'viewer@hctech.com.vn',
                'role': User.Role.VIEWER,
                'phone_number': '0905333444',
            }
        )
        u_viewer.set_password('123')
        u_viewer.save()

        u_leader, _ = User.objects.get_or_create(
            username='cuuho_truong',
            defaults={
                'first_name': 'Đỗ Minh Tuấn',
                'email': 'tuan.dm@hctech.com.vn',
                'role': User.Role.TENANT_ADMIN,
                'phone_number': '0905888999',
            }
        )
        u_leader.set_password('123')
        u_leader.save()

        u_operator, _ = User.objects.get_or_create(
            username='truc_ban',
            defaults={
                'first_name': 'Lê Hoàng Nam',
                'email': 'nam.lh@hctech.com.vn',
                'role': User.Role.VIEWER,
                'phone_number': '0905777666',
            }
        )
        u_operator.set_password('123')
        u_operator.save()

        self.stdout.write("Đã tạo 4 tài khoản (admin, viewer, cuuho_truong, truc_ban - MK: 123)")

        # 2. Khởi tạo Khu Vực (Area)
        areas_data = [
            {
                'code': 'VDB-01',
                'name': 'Vịnh Đà Nẵng - Vùng Cứu Hộ Biển',
                'description': 'Vùng biển ven bờ vịnh Đà Nẵng, bãi tắm Nguyễn Tất Thành & bãi Rạng'
            },
            {
                'code': 'ST-TQ-02',
                'name': 'Cảng Cá Thọ Quang & Bán Đảo Sơn Trà',
                'description': 'Vùng âu thuyền, cảng cá Thọ Quang và các điểm du lịch sinh thái bán đảo Sơn Trà'
            },
            {
                'code': 'KCN-HK-03',
                'name': 'KCN & Công Nghệ Cao Hòa Khánh',
                'description': 'Khu công nghiệp Hòa Khánh, các nhà máy xưởng sản xuất và cụm kho vận'
            },
            {
                'code': 'TT-HC-04',
                'name': 'Trung Tâm Hành Chính & Bờ Đông Sông Hàn',
                'description': 'Khu vực trung tâm quận Hải Châu, bến du thuyền và chuỗi khách sạn ven biển Mỹ Khê'
            },
        ]
        area_objs = {}
        for ad in areas_data:
            obj, _ = Area.objects.update_or_create(code=ad['code'], defaults=ad)
            area_objs[ad['code']] = obj

        self.stdout.write(f"Đã tạo {len(area_objs)} khu vực hoạt động.")

        # 3. Khởi tạo Thiết Bị (Device)
        devices_data = [
            # Tàu biển có GPS
            {
                'dev_eui': '24E124128C010001',
                'device_name': 'Tàu Cứu Hộ 01 - SAR DaNang',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.CAP_CUU_Y_TE,
                'has_gps': True,
                'area': area_objs['VDB-01'],
                'customer_name': 'Ban Chỉ Huy PCTT & TKCN Đà Nẵng',
                'emergency_phone': '02363822222',
                'latitude': Decimal('16.11520000'),
                'longitude': Decimal('108.23840000'),
                'connection_status': Device.ConnectionStatus.SOS,
                'battery_level': 88,
                'description': 'Tàu cứu nạn chuyên trách tuần tra khu vực Vịnh Đà Nẵng và mũi Tiên Sa',
                'last_seen': now - timedelta(minutes=2),
            },
            {
                'dev_eui': '24E124128C010002',
                'device_name': 'Tàu Đánh Cá ĐNa-90123-TS',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.CAP_CUU_Y_TE,
                'has_gps': True,
                'area': area_objs['ST-TQ-02'],
                'customer_name': 'Nguyễn Văn Tèo (Chủ tàu)',
                'emergency_phone': '0913456789',
                'latitude': Decimal('16.14200000'),
                'longitude': Decimal('108.27500000'),
                'connection_status': Device.ConnectionStatus.PROCESSING,
                'battery_level': 72,
                'description': 'Tàu khai thác hải sản xa bờ, công suất 450CV',
                'last_seen': now - timedelta(minutes=5),
            },
            {
                'dev_eui': '24E124128C010003',
                'device_name': 'Cano Tuần Tra Sơn Trà BP-08',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.AN_NINH,
                'has_gps': True,
                'area': area_objs['VDB-01'],
                'customer_name': 'Đồn Biên Phòng Sơn Trà',
                'emergency_phone': '02363831114',
                'latitude': Decimal('16.10800000'),
                'longitude': Decimal('108.29100000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 95,
                'description': 'Cano tuần tra tốc độ cao ven rừng Sơn Trà và Bãi Bụt',
                'last_seen': now - timedelta(minutes=8),
            },
            {
                'dev_eui': '24E124128C010004',
                'device_name': 'Tàu Hậu Cần Nghề Cá 09',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.CAP_CUU_Y_TE,
                'has_gps': True,
                'area': area_objs['ST-TQ-02'],
                'customer_name': 'HTX Khai Thác Hải Sản Thọ Quang',
                'emergency_phone': '0905666777',
                'latitude': Decimal('16.16000000'),
                'longitude': Decimal('108.31000000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 90,
                'description': 'Tàu tiếp tế nhiên liệu và đá lạnh ngoài khơi',
                'last_seen': now - timedelta(minutes=12),
            },
            {
                'dev_eui': '24E124128C010005',
                'device_name': 'Tàu Du Lịch Sông Hàn 02',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.CHAY,
                'has_gps': True,
                'area': area_objs['TT-HC-04'],
                'customer_name': 'Công ty Du Thuyền Sông Hàn',
                'emergency_phone': '0905333222',
                'latitude': Decimal('16.07500000'),
                'longitude': Decimal('108.22700000'),
                'connection_status': Device.ConnectionStatus.OFFLINE,
                'battery_level': 18,
                'description': 'Tàu du lịch ngắm cầu Rồng - đang neo bến bảo trì',
                'last_seen': now - timedelta(hours=8),
            },

            # Nút nhấn tĩnh đất liền (không GPS)
            {
                'dev_eui': '24E124128C020001',
                'device_name': 'Nút Báo Cháy Xưởng A - KCN Hòa Khánh',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.CHAY,
                'has_gps': False,
                'area': area_objs['KCN-HK-03'],
                'customer_name': 'Công ty TNHH Bao Bì & Nhựa Hòa Khánh',
                'emergency_phone': '02363738888',
                'address': 'Lô 3, Đường số 2, KCN Hòa Khánh, Liên Chiểu, Đà Nẵng',
                'latitude': Decimal('16.06820000'),
                'longitude': Decimal('108.14720000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 100,
                'description': 'Nút bấm khẩn cấp báo cháy kết nối còi báo xưởng',
                'last_seen': now - timedelta(minutes=1),
            },
            {
                'dev_eui': '24E124128C020002',
                'device_name': 'Nút Cấp Cứu Y Tế - TYT Hòa Hải',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.CAP_CUU_Y_TE,
                'has_gps': False,
                'area': area_objs['TT-HC-04'],
                'customer_name': 'Trung Tâm Y Tế Quận Ngũ Hành Sơn',
                'emergency_phone': '02363847234',
                'address': '128 Mai Đăng Chơn, Hòa Hải, Ngũ Hành Sơn, Đà Nẵng',
                'latitude': Decimal('16.00250000'),
                'longitude': Decimal('108.25200000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 96,
                'description': 'Nút bấm SOS phòng cấp cứu trực 24/7',
                'last_seen': now - timedelta(minutes=4),
            },
            {
                'dev_eui': '24E124128C020003',
                'device_name': 'Nút Khẩn Cấp An Ninh - KS Biển Đông',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.AN_NINH,
                'has_gps': False,
                'area': area_objs['TT-HC-04'],
                'customer_name': 'Khách sạn Biển Đông Đà Nẵng',
                'emergency_phone': '0905112334',
                'address': '88 Võ Nguyên Giáp, Phước Mỹ, Sơn Trà, Đà Nẵng',
                'latitude': Decimal('16.06500000'),
                'longitude': Decimal('108.24400000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 85,
                'description': 'Nút bấm giấu dưới gầm bàn quầy lễ tân',
                'last_seen': now - timedelta(minutes=3),
            },
            {
                'dev_eui': '24E124128C020004',
                'device_name': 'Nút Khẩn Cấp Kho Đông Lạnh Thọ Quang',
                'device_type': Device.DeviceType.NUT_NHAN,
                'category_type': Device.CategoryType.CHAY,
                'has_gps': False,
                'area': area_objs['ST-TQ-02'],
                'customer_name': 'Công ty CP Chế biến Thủy sản Sơn Trà',
                'emergency_phone': '02363920111',
                'address': 'Đường Vân Đồn, KCN Dịch Vụ Thủy Sản Thọ Quang, Đà Nẵng',
                'latitude': Decimal('16.09650000'),
                'longitude': Decimal('108.23800000'),
                'connection_status': Device.ConnectionStatus.MAINTENANCE,
                'battery_level': 45,
                'description': 'Nút bấm tại cửa kho âm sâu - đang đợi thay pin định kỳ',
                'last_seen': now - timedelta(hours=3),
            },

            # Gateways LoRaWAN
            {
                'dev_eui': 'AC1F09FFFE010001',
                'device_name': 'LoRaWAN Gateway - Hải Đăng Tiên Sa',
                'device_type': Device.DeviceType.GATEWAY,
                'category_type': None,
                'has_gps': False,
                'area': area_objs['ST-TQ-02'],
                'customer_name': 'HC TECH Network Operation',
                'emergency_phone': '0905111222',
                'address': 'Trạm Hải Đăng Tiên Sa, Mũi Sơn Trà, Đà Nẵng',
                'latitude': Decimal('16.13800000'),
                'longitude': Decimal('108.22500000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 100,
                'description': 'Trạm Gateway ngoài trời bao phủ bán kính 15km vịnh Đà Nẵng',
                'last_seen': now - timedelta(seconds=30),
            },
            {
                'dev_eui': 'AC1F09FFFE010002',
                'device_name': 'LoRaWAN Gateway - Trụ Sở HC TECH',
                'device_type': Device.DeviceType.GATEWAY,
                'category_type': None,
                'has_gps': False,
                'area': area_objs['TT-HC-04'],
                'customer_name': 'HC TECH Network Operation',
                'emergency_phone': '0905111222',
                'address': 'Tòa nhà HC TECH, Q. Hải Châu, Đà Nẵng',
                'latitude': Decimal('16.07180000'),
                'longitude': Decimal('108.22050000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 100,
                'description': 'Trạm Gateway trung tâm phủ sóng nội đô Hải Châu',
                'last_seen': now - timedelta(seconds=20),
            },
            {
                'dev_eui': 'AC1F09FFFE010003',
                'device_name': 'LoRaWAN Gateway - Trạm Hòa Khánh',
                'device_type': Device.DeviceType.GATEWAY,
                'category_type': None,
                'has_gps': False,
                'area': area_objs['KCN-HK-03'],
                'customer_name': 'HC TECH Network Operation',
                'emergency_phone': '0905111222',
                'address': 'Đường số 5, KCN Hòa Khánh, Liên Chiểu, Đà Nẵng',
                'latitude': Decimal('16.07200000'),
                'longitude': Decimal('108.14500000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 100,
                'description': 'Trạm Gateway thu thập dữ liệu các nhà máy KCN Hòa Khánh',
                'last_seen': now - timedelta(seconds=45),
            },

            # Cameras Cứu Hộ
            {
                'dev_eui': 'CAM-HC-0001',
                'device_name': 'Camera Giám Sát Cửa Biển Thọ Quang (PTZ-01)',
                'device_type': Device.DeviceType.CAMERA,
                'category_type': None,
                'has_gps': False,
                'area': area_objs['ST-TQ-02'],
                'customer_name': 'Ban Quản Lý Cảng Cá Thọ Quang',
                'emergency_phone': '02363920222',
                'address': 'Cửa luồng Cảng Cá Thọ Quang, Đà Nẵng',
                'latitude': Decimal('16.09800000'),
                'longitude': Decimal('108.24000000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 100,
                'description': 'Camera quay quét zoom 36x hỗ trợ quan sát tàu thuyền ra vào luồng',
                'last_seen': now - timedelta(seconds=15),
            },
            {
                'dev_eui': 'CAM-HC-0002',
                'device_name': 'Camera Bãi Tắm Mỹ Khê (PTZ-02)',
                'device_type': Device.DeviceType.CAMERA,
                'category_type': None,
                'has_gps': False,
                'area': area_objs['TT-HC-04'],
                'customer_name': 'Đội Cứu Nạn Bờ Biển Đà Nẵng',
                'emergency_phone': '02363847888',
                'address': 'Công viên Biển Đông, Võ Nguyên Giáp, Sơn Trà, Đà Nẵng',
                'latitude': Decimal('16.06200000'),
                'longitude': Decimal('108.24500000'),
                'connection_status': Device.ConnectionStatus.ONLINE,
                'battery_level': 100,
                'description': 'Camera nhiệt quan sát người tắm biển và hỗ trợ cứu hộ khẩn cấp',
                'last_seen': now - timedelta(seconds=10),
            },
        ]

        device_objs = {}
        for dd in devices_data:
            eui = dd['dev_eui']
            obj, _ = Device.objects.update_or_create(dev_eui=eui, defaults=dd)
            device_objs[eui] = obj

        self.stdout.write(f"Đã tạo {len(device_objs)} thiết bị (Nút nhấn, Gateway, Camera).")

        # 4. Khởi tạo Nhật ký Sự kiện Báo động (AlertLog)
        AlertLog.objects.all().delete()  # Làm sạch để tạo lại nhật ký chuẩn

        # Sự kiện 1: NEW (Chưa xử lý - Đang phát SOS)
        d_sar = device_objs['24E124128C010001']
        AlertLog.objects.create(
            alert_type=AlertLog.AlertType.CUU_HO_BIEN,
            status=AlertLog.AlertStatus.NEW,
            device=d_sar,
            area=d_sar.area,
            latitude=d_sar.latitude,
            longitude=d_sar.longitude,
            address='Vùng biển ngoài khơi vịnh Đà Nẵng, cách mũi Tiên Sa 4.5 hải lý',
            notes='Tàu gặp giông gió lớn, hỏng bánh lái cần hỗ trợ lai dắt khẩn cấp.',
            created_at=now - timedelta(minutes=18),
        )

        # Sự kiện 2: PROCESSING (Đang xử lý)
        d_fish = device_objs['24E124128C010002']
        AlertLog.objects.create(
            alert_type=AlertLog.AlertType.CAP_CUU_Y_TE,
            status=AlertLog.AlertStatus.PROCESSING,
            device=d_fish,
            area=d_fish.area,
            latitude=d_fish.latitude,
            longitude=d_fish.longitude,
            address='Tọa độ biển: 16.1420°N, 108.2750°E (Đông Bắc Sơn Trà)',
            acknowledged_by=u_admin,
            acknowledged_at=now - timedelta(minutes=30),
            notes='Thuyền viên bị chấn thương nặng vùng đầu, đã điều động cano y tế tiếp cận.',
            created_at=now - timedelta(minutes=45),
        )

        # Sự kiện 3: RESOLVED (Đã hoàn tất)
        d_fire = device_objs['24E124128C020001']
        AlertLog.objects.create(
            alert_type=AlertLog.AlertType.CHAY,
            status=AlertLog.AlertStatus.RESOLVED,
            device=d_fire,
            area=d_fire.area,
            latitude=d_fire.latitude,
            longitude=d_fire.longitude,
            address=d_fire.address,
            acknowledged_by=u_admin,
            acknowledged_at=now - timedelta(hours=3, minutes=50),
            resolved_by=u_admin,
            resolved_at=now - timedelta(hours=3, minutes=20),
            notes='Chập bảng điều khiển điện tại phân xưởng ép nhựa.',
            resolution_report='Lực lượng PCCC cơ sở đã dập tắt hoàn toàn bằng 3 bình CO2. Không có thiệt hại về người.',
            created_at=now - timedelta(hours=4),
        )

        # Sự kiện 4: FALSE_ALARM (Báo động giả)
        d_sec = device_objs['24E124128C020003']
        AlertLog.objects.create(
            alert_type=AlertLog.AlertType.AN_NINH,
            status=AlertLog.AlertStatus.FALSE_ALARM,
            device=d_sec,
            area=d_sec.area,
            latitude=d_sec.latitude,
            longitude=d_sec.longitude,
            address=d_sec.address,
            acknowledged_by=u_viewer,
            acknowledged_at=now - timedelta(days=1, hours=2),
            resolved_by=u_viewer,
            resolved_at=now - timedelta(days=1, hours=1, minutes=45),
            notes='Nhân viên tạp vụ vô tình va vào nút bấm trong lúc lau dọn quầy lễ tân.',
            resolution_report='Đã kiểm tra đối chiếu qua camera giám sát và xác nhận an toàn.',
            created_at=now - timedelta(days=1, hours=2, minutes=10),
        )

        self.stdout.write("Đã tạo 4 nhật ký sự kiện cứu hộ (Mới, Đang xử lý, Hoàn tất, Báo động giả).")

        # 5. Khởi tạo Lịch sử Tọa độ GPS (LocationHistory) cho tàu thuyền
        LocationHistory.objects.all().delete()

        # Tạo chuỗi hành trình 20 điểm cho Tàu Cứu Hộ 01
        start_lat = 16.0950
        start_lng = 108.2250
        base_time = now - timedelta(hours=3)

        for i in range(20):
            step_lat = start_lat + (i * 0.0010) + (random.uniform(-0.0002, 0.0002))
            step_lng = start_lng + (i * 0.0007) + (random.uniform(-0.0002, 0.0002))
            pt_time = base_time + timedelta(minutes=i * 9)
            is_sos = (i == 19)
            speed = 0.0 if is_sos else round(random.uniform(8.5, 16.0), 1)

            lh = LocationHistory(
                device=d_sar,
                latitude=Decimal(str(round(step_lat, 8))),
                longitude=Decimal(str(round(step_lng, 8))),
                speed=speed,
                battery_level=max(100 - i, 88),
                is_sos_point=is_sos,
                is_drifting=is_sos,
                stationary_duration_minutes=25 if is_sos else 0,
            )
            lh.save()
            # Cập nhật thời gian ghi nhận
            LocationHistory.objects.filter(id=lh.id).update(recorded_at=pt_time)

        # Tạo chuỗi hành trình 15 điểm cho Tàu Đánh Cá ĐNa-90123-TS
        fish_start_lat = 16.1000
        fish_start_lng = 108.2450
        fish_time = now - timedelta(hours=4)

        for i in range(15):
            step_lat = fish_start_lat + (i * 0.0028) + (random.uniform(-0.0003, 0.0003))
            step_lng = fish_start_lng + (i * 0.0020) + (random.uniform(-0.0003, 0.0003))
            pt_time = fish_time + timedelta(minutes=i * 16)
            is_sos = (i == 14)

            lh = LocationHistory(
                device=d_fish,
                latitude=Decimal(str(round(step_lat, 8))),
                longitude=Decimal(str(round(step_lng, 8))),
                speed=round(random.uniform(5.0, 11.0), 1) if not is_sos else 1.2,
                battery_level=max(100 - (i * 2), 72),
                is_sos_point=is_sos,
                is_drifting=False,
                stationary_duration_minutes=0,
            )
            lh.save()
            LocationHistory.objects.filter(id=lh.id).update(recorded_at=pt_time)

        total_pts = LocationHistory.objects.count()
        self.stdout.write(f"Đã tạo {total_pts} điểm tọa độ GPS phục vụ tính năng Replay hành trình.")

        self.stdout.write(self.style.SUCCESS("--- HOÀN TẤT KHỞI TẠO DỮ LIỆU THÀNH CÔNG ---"))
