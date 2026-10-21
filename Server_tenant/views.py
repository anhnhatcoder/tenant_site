import csv
import io
import json
import logging
import math
import queue
import time
import uuid
from datetime import timedelta

logger = logging.getLogger(__name__)
from django.conf import settings
from django.core.cache import cache
from django.core.management import call_command
from django.db import connection
from django.shortcuts import render, redirect, get_object_or_404
from django.http import JsonResponse, HttpResponse, HttpResponseForbidden, StreamingHttpResponse
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.contrib.auth.decorators import login_required
from django.views.decorators.csrf import csrf_exempt
from django.utils import timezone
from .models import User, Device, AlertLog, LocationHistory, Area
from .sse import register_subscriber, unregister_subscriber, broadcast_event
from .hctech_client import HCTechIoTClient, HCTechAPIError
from .hctech_webhook import (
    hctech_webhook_view,
    api_sync_from_hctech,
    HCTechWebhookHandler,
    sync_hctech_catalog_and_telemetry,
    get_webhook_token,
    save_webhook_token,
    generate_new_webhook_token,
    get_webhook_monitor_logs,
    clear_webhook_monitor_logs,
    add_webhook_monitor_log,
    evaluate_device_connection_statuses,
)

def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371.0
    phi1, phi2 = math.radians(float(lat1)), math.radians(float(lat2))
    dphi = math.radians(float(lat2) - float(lat1))
    dlambda = math.radians(float(lon2) - float(lon1))
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


_ACCOUNTS_INITIALIZED = False


def ensure_schema_updates():
    try:
        with connection.cursor() as cursor:
            cursor.execute('''
                ALTER TABLE "Server_tenant_device" 
                ADD COLUMN IF NOT EXISTS "parent_device_id" bigint NULL REFERENCES "Server_tenant_device" ("id") ON DELETE SET NULL;
                ALTER TABLE "Server_tenant_device" 
                ADD COLUMN IF NOT EXISTS "group_name" varchar(255) NULL;
                
                ALTER TABLE "Server_tenant_locationhistory" 
                ADD COLUMN IF NOT EXISTS "button_device_id" bigint NULL REFERENCES "Server_tenant_device" ("id") ON DELETE SET NULL;
                ALTER TABLE "Server_tenant_locationhistory" 
                ADD COLUMN IF NOT EXISTS "packet_type" varchar(50) DEFAULT 'PERIODIC';
            ''')
    except Exception as e:
        logger.warning(f"Schema update check: {e}")

def ensure_default_accounts():
    global _ACCOUNTS_INITIALIZED
    if _ACCOUNTS_INITIALIZED:
        return
    try:
        # 1. Tài khoản Superuser (Quản trị toàn quyền hệ thống + Trang Admin)
        if not User.objects.filter(username='admin').exists():
            u_admin = User.objects.create_user(
                username='admin',
                password='1',
                first_name='Bùi Anh Nhật',
                email='anhnhat.coder@gmail.com',
                role=User.Role.SYSTEM_ADMIN,
                phone_number='0937236490'
            )
            u_admin.is_staff = True
            u_admin.is_superuser = True
            u_admin.save()
        else:
            User.objects.filter(username='admin').update(first_name='Bùi Anh Nhật', is_staff=True, is_superuser=True, role=User.Role.SYSTEM_ADMIN)

        # 2. Tài khoản Tenant Admin (Chỉ quản lý Dashboard, không vào được trang Admin)
        if not User.objects.filter(username='tenant').exists():
            u_tenant = User.objects.create_user(
                username='tenant',
                password='1',
                first_name='Tenant Admin',
                email='tenant@hctech.com.vn',
                role=User.Role.TENANT_ADMIN,
                phone_number='0905222333'
            )
            u_tenant.is_staff = False
            u_tenant.is_superuser = False
            u_tenant.save()
        else:
            User.objects.filter(username='tenant').update(first_name='Tenant Admin', is_staff=False, is_superuser=False, role=User.Role.TENANT_ADMIN)

        # Đảm bảo toàn bộ tài khoản role TENANT_ADMIN không có cờ is_superuser hoặc is_staff
        User.objects.filter(role=User.Role.TENANT_ADMIN).update(is_staff=False, is_superuser=False)
        ensure_schema_updates()
        _ACCOUNTS_INITIALIZED = True
    except Exception as e:
        logger.error(f"ensure_default_accounts error: {e}")


def login_view(request):
    ensure_default_accounts()
    error_msg = None
    if request.method == 'POST':
        uname = request.POST.get('username', '').strip()
        pwd = request.POST.get('password', '').strip()
        user = authenticate(request, username=uname, password=pwd)
        if user is not None:
            login(request, user)
            return redirect('dashboard')
        else:
            error_msg = "Tài khoản hoặc mật khẩu không chính xác!"
    return render(request, 'login.html', {'error_msg': error_msg})


def logout_view(request):
    logout(request)
    return redirect('login')


@login_required(login_url='/login/')
def dashboard_view(request):
    ensure_default_accounts()
    evaluate_device_connection_statuses(broadcast=False)
    devices = list(Device.objects.filter(is_active=True).select_related('parent_device').order_by('-id'))
    # Ẩn tài khoản System Admin / Superuser ở danh sách quản lý tài khoản trên Dashboard
    users_list = list(User.objects.exclude(role=User.Role.SYSTEM_ADMIN).exclude(is_superuser=True).order_by('id'))
    alerts = list(AlertLog.objects.select_related('device', 'acknowledged_by', 'resolved_by')[:50])

    for d in devices:
        d.heartbeat_interval = d.heartbeat_interval or 300
        if d.last_seen:
            local_seen = timezone.localtime(d.last_seen)
            d.last_seen_display = local_seen.strftime('%d/%m/%Y %H:%M:%S')
        else:
            d.last_seen_display = 'Chưa kết nối'
        d.is_pending_assignment = not bool(d.customer_name and d.customer_name.strip())
        d.gps_code = 'GPS' if d.has_gps else 'STATIC'
        d.loc_display = f"{d.latitude}, {d.longitude}" if d.has_gps else (d.address or '-')
        d.parent_id = d.parent_device.id if d.parent_device else None
        d.parent_name = d.parent_device.device_name if d.parent_device else None
        d.parent_eui = d.parent_device.dev_eui if d.parent_device else None
        d.group_name_display = d.group_name or ""
        d.paired_buttons = list(d.paired_devices.filter(is_active=True).values('id', 'device_name', 'dev_eui', 'device_type', 'connection_status'))
        d.paired_buttons_count = len(d.paired_buttons)
        d.paired_sub_devices = d.paired_buttons
        d.paired_sub_count = d.paired_buttons_count
        if d.device_type == 'CAMERA':
            d.type_label, d.type_bg = 'Camera', 'bg-blue-600'
        elif d.device_type == 'GATEWAY':
            d.type_label, d.type_bg = 'Gateway', 'bg-purple-600'
        elif d.has_gps:
            d.type_label, d.type_bg = 'Thiết bị GPS', 'bg-sky-600'
        else:
            d.type_label, d.type_bg = 'Nút nhấn', 'bg-cyan-600'

        if d.category_type == 'CHAY':
            d.cat_label, d.cat_cls = 'Báo Cháy', 'border-red-500 text-red-500'
        elif d.category_type == 'AN_NINH':
            d.cat_label, d.cat_cls = 'An Ninh', 'border-amber-500 text-amber-500'
        else:
            d.cat_label, d.cat_cls = 'Cấp Cứu/Y tế', 'border-emerald-500 text-emerald-500'

    for log in alerts:
        log.loc_display = f"Tọa độ GPS: {log.latitude}, {log.longitude}" if (log.device and log.device.has_gps) else (log.address or '-')
        log.notes_display = log.notes if log.notes else '-'
        log.report_display = log.resolution_report if log.resolution_report else '-'
        log.is_open = (log.status != 'RESOLVED')

    for u in users_list:
        u.display_name = u.first_name if u.first_name else u.username
        u.phone_display = u.phone_number if u.phone_number else '-'
        u.can_delete = (u.id != request.user.id)

    all_devs = Device.objects.filter(is_active=True)
    cam_qs = all_devs.filter(device_type='CAMERA')
    btn_qs = all_devs.filter(device_type='NUT_NHAN')
    gw_qs = all_devs.filter(device_type='GATEWAY')

    chay_count = AlertLog.objects.filter(alert_type='CHAY').count()
    yte_count = AlertLog.objects.filter(alert_type__in=['CAP_CUU_Y_TE', 'CUU_HO_BIEN']).count()
    anninh_count = AlertLog.objects.filter(alert_type='AN_NINH').count()

    alert_new = AlertLog.objects.filter(status='NEW').count()
    alert_proc = AlertLog.objects.filter(status='PROCESSING').count()
    alert_res = AlertLog.objects.filter(status='RESOLVED').count()
    alert_false = AlertLog.objects.filter(status='FALSE_ALARM').count()
    total_alerts = max(alert_new + alert_proc + alert_res + alert_false, 1)

    online_count = all_devs.filter(connection_status='ONLINE').count()
    sos_count = all_devs.filter(connection_status__in=['SOS', 'PROCESSING']).count()
    offline_count = all_devs.filter(connection_status='OFFLINE').count()
    maint_count = all_devs.filter(connection_status='MAINTENANCE').count()

    is_superuser = request.user.is_superuser
    is_admin = request.user.role in ['SYSTEM_ADMIN', 'TENANT_ADMIN'] or is_superuser
    current_user_display = request.user.first_name if request.user.first_name else request.user.username

    if is_superuser or getattr(request.user, 'role', '') == 'SYSTEM_ADMIN':
        user_role_label = 'Superuser'
        role_badge_cls = 'bg-purple-500/20 text-purple-400'
    elif getattr(request.user, 'role', '') == 'TENANT_ADMIN':
        user_role_label = 'Tenant Admin'
        role_badge_cls = 'bg-cyan-500/20 text-cyan-400'
    else:
        user_role_label = 'Viewer'
        role_badge_cls = 'bg-amber-500/20 text-amber-400'

    context = {
        'devices': devices,
        'gps_devices': [d for d in devices if d.has_gps],
        'users_list': users_list,
        'alerts': alerts,
        'is_admin': is_admin,
        'is_superuser': is_superuser,
        'role_badge_cls': role_badge_cls,
        'current_user_display': current_user_display,
        'current_username': request.user.username,
        'current_user_fullname': request.user.first_name or '',
        'current_user_phone': getattr(request.user, 'phone_number', '') or '',
        'current_user_email': getattr(request.user, 'email', '') or '',
        'user_role_label': user_role_label,
        'total_devices': all_devs.count(),
        'online_count': online_count,
        'sos_count': sos_count,
        'offline_count': offline_count,
        'maint_count': maint_count,
        'cam_total': cam_qs.count(),
        'cam_online': cam_qs.filter(connection_status='ONLINE').count(),
        'cam_offline': cam_qs.exclude(connection_status='ONLINE').count(),
        'btn_total': btn_qs.count(),
        'btn_online': btn_qs.filter(connection_status='ONLINE').count(),
        'btn_offline': btn_qs.exclude(connection_status='ONLINE').count(),
        'gw_total': gw_qs.count(),
        'gw_online': gw_qs.filter(connection_status='ONLINE').count(),
        'gw_offline': gw_qs.exclude(connection_status='ONLINE').count(),
        'chay_count': chay_count,
        'yte_count': yte_count,
        'anninh_count': anninh_count,
        'alert_new': alert_new,
        'alert_proc': alert_proc,
        'alert_res': alert_res,
        'alert_false': alert_false,
        'pct_new': int((alert_new / total_alerts) * 100),
        'pct_proc': int((alert_proc / total_alerts) * 100),
        'pct_res': int((alert_res / total_alerts) * 100),
        'pct_false': int((alert_false / total_alerts) * 100),
    }
    return render(request, 'dashboard.html', context)


def api_dashboard_state(request):
    evaluate_device_connection_statuses(broadcast=False)
    gps_filter = request.GET.get('has_gps')
    status_filter = request.GET.get('status')
    device_type_filter = request.GET.get('device_type')

    devices_qs = Device.objects.filter(is_active=True).select_related('parent_device')
    if gps_filter in ['true', 'false']:
        devices_qs = devices_qs.filter(has_gps=(gps_filter == 'true'))
    if status_filter:
        devices_qs = devices_qs.filter(connection_status=status_filter)
    if device_type_filter:
        if device_type_filter == 'SHIP':
            devices_qs = devices_qs.filter(has_gps=True)
        elif device_type_filter == 'NUT_NHAN':
            devices_qs = devices_qs.filter(device_type='NUT_NHAN', has_gps=False)
        else:
            devices_qs = devices_qs.filter(device_type=device_type_filter)

    devices_data = []
    for d in devices_qs:
        loc_display = f"{round(float(d.latitude), 6)}, {round(float(d.longitude), 6)}" if (d.has_gps and d.latitude and d.longitude) else (d.address or "-")
        if d.device_type == Device.DeviceType.CAMERA:
            type_bg, type_label = "bg-blue-600", "Camera"
        elif d.device_type == Device.DeviceType.GATEWAY:
            type_bg, type_label = "bg-purple-600", "Gateway"
        elif d.has_gps:
            type_bg, type_label = "bg-sky-600", "Thiết bị GPS"
        else:
            type_bg, type_label = "bg-cyan-600", "Nút nhấn"
        cat_cls = "border-red-500 text-red-400 bg-red-500/10" if d.category_type == Device.CategoryType.CHAY else ("border-amber-500 text-amber-400 bg-amber-500/10" if d.category_type == Device.CategoryType.AN_NINH else "border-emerald-500 text-emerald-400 bg-emerald-500/10")
        cat_label = d.get_category_type_display() if d.category_type else "Cấp Cứu/Y tế"
        gps_code = "GPS" if d.has_gps else "STATIC"

        local_last_seen = timezone.localtime(d.last_seen) if d.last_seen else None

        devices_data.append({
            'id': d.id,
            'dev_eui': d.dev_eui,
            'device_name': d.device_name,
            'device_type': d.get_device_type_display(),
            'device_type_raw': d.device_type,
            'type_bg': type_bg,
            'type_label': type_label,
            'category_type': d.category_type,
            'cat_cls': cat_cls,
            'cat_label': cat_label,
            'gps_code': gps_code,
            'has_gps': d.has_gps,
            'customer_name': d.customer_name or "",
            'emergency_phone': d.emergency_phone or "",
            'is_pending_assignment': not bool(d.customer_name and d.customer_name.strip()),
            'address': d.address or ('Đang cập nhật tọa độ GPS' if d.has_gps else 'Chưa có địa chỉ'),
            'loc_display': loc_display,
            'latitude': float(d.latitude) if d.latitude else 16.054407,
            'longitude': float(d.longitude) if d.longitude else 108.202167,
            'connection_status': d.connection_status,
            'parent_device_id': d.parent_device.id if d.parent_device else None,
            'parent_device_name': d.parent_device.device_name if d.parent_device else None,
            'parent_device_eui': d.parent_device.dev_eui if d.parent_device else None,
            'group_name': d.group_name or "",
            'paired_buttons': list(d.paired_devices.filter(is_active=True).values('id', 'device_name', 'dev_eui', 'device_type', 'connection_status')),
            'paired_buttons_count': d.paired_devices.filter(is_active=True).count(),
            'connection_status_display': d.get_connection_status_display(),
            'battery_level': d.battery_level,
            'heartbeat_interval': d.heartbeat_interval or 300,
            'last_seen': local_last_seen.strftime('%d/%m/%Y %H:%M:%S') if local_last_seen else 'Chưa kết nối'
        })

    emergency_alert = AlertLog.objects.filter(status='NEW').select_related('device').first()
    emergency_data = None
    if emergency_alert:
        local_created = timezone.localtime(emergency_alert.created_at)
        emergency_data = {
            'alert_id': emergency_alert.id,
            'device_id': emergency_alert.device.id,
            'dev_eui': emergency_alert.device.dev_eui,
            'device_name': emergency_alert.device.device_name,
            'customer_name': emergency_alert.device.customer_name,
            'emergency_phone': emergency_alert.device.emergency_phone,
            'has_gps': emergency_alert.device.has_gps,
            'latitude': float(emergency_alert.latitude or emergency_alert.device.latitude or 16.054407),
            'longitude': float(emergency_alert.longitude or emergency_alert.device.longitude or 108.202167),
            'address': emergency_alert.address or emergency_alert.device.address,
            'created_at': local_created.strftime('%H:%M:%S - %d/%m/%Y'),
            'alert_type': emergency_alert.get_alert_type_display(),
            'notes': (emergency_alert.notes or '') if not str(emergency_alert.notes or '').startswith('Tín hiệu vô tuyến') else '',
        }

    alerts_qs = list(AlertLog.objects.select_related('device', 'acknowledged_by', 'resolved_by')[:50])
    alerts_data = []
    for log in alerts_qs:
        local_created = timezone.localtime(log.created_at) if log.created_at else None
        loc_display = f"Tọa độ GPS: {log.latitude}, {log.longitude}" if (log.device and log.device.has_gps) else (log.address or (log.device.address if log.device else '-') or '-')
        device_name = log.device.device_name if log.device else 'Không xác định'
        dev_eui = log.device.dev_eui if log.device else ''
        alerts_data.append({
            'id': log.id,
            'created_at': local_created.strftime('%H:%M:%S %d/%m/%Y') if local_created else '',
            'device_name': device_name,
            'dev_eui': dev_eui,
            'loc_display': loc_display,
            'status': log.status,
            'status_display': log.get_status_display(),
            'notes_display': log.notes if log.notes else '-',
            'report_display': log.resolution_report if log.resolution_report else '-',
            'is_open': (log.status != 'RESOLVED'),
        })

    return JsonResponse({
        'devices': devices_data,
        'emergency': emergency_data,
        'alerts': alerts_data
    })


def api_stats_data(request):
    range_filter = request.GET.get('range', '12m')
    alert_type_filter = request.GET.get('alert_type', '')

    now = timezone.now()
    if range_filter == 'today':
        start_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif range_filter == '7d':
        start_time = now - timedelta(days=7)
    elif range_filter == '30d':
        start_time = now - timedelta(days=30)
    elif range_filter == '3m':
        start_time = now - timedelta(days=90)
    else:
        start_time = now - timedelta(days=365)

    alerts_qs = AlertLog.objects.filter(created_at__gte=start_time)

    chay_count = alerts_qs.filter(alert_type='CHAY').count()
    yte_count = alerts_qs.filter(alert_type__in=['CAP_CUU_Y_TE', 'CUU_HO_BIEN']).count()
    anninh_count = alerts_qs.filter(alert_type='AN_NINH').count()

    status_qs = alerts_qs
    if alert_type_filter:
        if alert_type_filter == 'CAP_CUU_Y_TE':
            status_qs = status_qs.filter(alert_type__in=['CAP_CUU_Y_TE', 'CUU_HO_BIEN'])
        else:
            status_qs = status_qs.filter(alert_type=alert_type_filter)

    alert_new = status_qs.filter(status='NEW').count()
    alert_proc = status_qs.filter(status='PROCESSING').count()
    alert_res = status_qs.filter(status='RESOLVED').count()
    alert_false = status_qs.filter(status='FALSE_ALARM').count()
    total = max(alert_new + alert_proc + alert_res + alert_false, 1)

    return JsonResponse({
        'chay_count': chay_count,
        'yte_count': yte_count,
        'anninh_count': anninh_count,
        'alert_new': alert_new,
        'alert_proc': alert_proc,
        'alert_res': alert_res,
        'alert_false': alert_false,
        'pct_new': int((alert_new / total) * 100),
        'pct_proc': int((alert_proc / total) * 100),
        'pct_res': int((alert_res / total) * 100),
        'pct_false': int((alert_false / total) * 100),
    })




@csrf_exempt
def api_update_device(request, device_id):
    """
    Gán thông tin hoặc cập nhật thiết bị (Tên, Chủ hộ, SĐT, Lĩnh vực, Địa chỉ).
    Cho phép người dùng gán thông tin nhanh cho thiết bị mới xuất hiện từ Webhook uplink.
    """
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Method not allowed'}, status=405)

    if hasattr(request, 'user') and request.user.is_authenticated and getattr(request.user, 'role', '') == 'VIEWER' and not getattr(request.user, 'is_superuser', False):
        return JsonResponse({'status': 'error', 'message': 'Tài khoản Viewer không có quyền cập nhật thông tin thiết bị!'}, status=403)

    device = get_object_or_404(Device, id=device_id)
    try:
        data = json.loads(request.body or '{}')
    except Exception:
        return JsonResponse({'status': 'error', 'message': 'Invalid JSON body'}, status=400)

    device_name = data.get('device_name')
    customer_name = data.get('customer_name')
    emergency_phone = data.get('emergency_phone')
    category_type = data.get('category_type')
    device_type = data.get('device_type')
    address = data.get('address')
    parent_id = data.get('parent_device_id') if 'parent_device_id' in data else data.get('parent_id')
    if parent_id is not None:
        if parent_id in ('', 0, '0', 'none', 'null', None):
            device.parent_device = None
        else:
            try:
                p_dev = Device.objects.get(id=int(parent_id))
                if p_dev.id != device.id:
                    device.parent_device = p_dev
            except (Device.DoesNotExist, ValueError):
                pass
    group_name = data.get('group_name')
    if group_name is not None:
        device.group_name = str(group_name).strip()

    if device_name is not None and str(device_name).strip():
        device.device_name = str(device_name).strip()
    if customer_name is not None:
        device.customer_name = str(customer_name).strip()
    if emergency_phone is not None:
        device.emergency_phone = str(emergency_phone).strip()
    if category_type and category_type in Device.CategoryType.values:
        device.category_type = category_type
    if device_type and device_type in Device.DeviceType.values:
        device.device_type = device_type
    if address is not None:
        device.address = str(address).strip()
    has_gps = data.get('has_gps')
    if has_gps is not None:
        if isinstance(has_gps, bool):
            device.has_gps = has_gps
        elif isinstance(has_gps, str):
            device.has_gps = (has_gps.strip().lower() in ('true', '1', 'yes', 'gps'))
    lat = data.get('latitude')
    lng = data.get('longitude')
    if lat is not None and str(lat).strip():
        try:
            device.latitude = Decimal(str(lat).strip())
        except Exception:
            pass
    if lng is not None and str(lng).strip():
        try:
            device.longitude = Decimal(str(lng).strip())
        except Exception:
            pass

    hb_interval = data.get('heartbeat_interval') if 'heartbeat_interval' in data else data.get('uplink_interval')
    if hb_interval is not None:
        try:
            val_hb = int(hb_interval)
            if val_hb > 0:
                device.heartbeat_interval = val_hb
        except (ValueError, TypeError):
            pass

    device.save()

    is_pending = not bool(device.customer_name and device.customer_name.strip())

    # Phát thông báo SSE cập nhật tức thời trên mọi màn hình (0ms delay)
    broadcast_event("IOT_UPLINK", {
        "device_id": device.id,
        "dev_eui": device.dev_eui,
        "device_name": device.device_name,
        "device_type": device.device_type,
        "device_type_display": device.get_device_type_display(),
        "category_type": device.category_type,
        "category_type_display": device.get_category_type_display() if device.category_type else "Cấp Cứu/Y tế",
        "customer_name": device.customer_name,
        "emergency_phone": device.emergency_phone,
        "is_pending_assignment": is_pending,
        "address": device.address or "",
        "has_gps": device.has_gps,
        "connection_status": device.connection_status,
        "connection_status_display": device.get_connection_status_display(),
        "is_sos": (device.connection_status == Device.ConnectionStatus.SOS),
        "battery_level": device.battery_level,
        "heartbeat_interval": device.heartbeat_interval or 300,
        "latitude": float(device.latitude) if device.latitude else None,
        "longitude": float(device.longitude) if device.longitude else None,
        "parent_device_id": device.parent_device.id if device.parent_device else None,
        "parent_device_name": device.parent_device.device_name if device.parent_device else None,
        "group_name": device.group_name or "",
        "device_updated": True
    })

    return JsonResponse({
        'status': 'success',
        'message': f'Đã gán thông tin cho thiết bị "{device.device_name}" thành công!',
        'device': {
            'id': device.id,
            'dev_eui': device.dev_eui,
            'device_name': device.device_name,
            'customer_name': device.customer_name,
            'emergency_phone': device.emergency_phone,
            'category_type': device.category_type,
            'category_type_display': device.get_category_type_display() if device.category_type else "Cấp Cứu/Y tế",
            'address': device.address,
            'heartbeat_interval': device.heartbeat_interval or 300,
            'is_pending_assignment': is_pending,
            'parent_device_id': device.parent_device.id if device.parent_device else None,
            'parent_device_name': device.parent_device.device_name if device.parent_device else None,
            'group_name': device.group_name or ""
        }
    })

@csrf_exempt
def api_register_device(request):
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Method not allowed'}, status=405)

    if hasattr(request, 'user') and request.user.is_authenticated and getattr(request.user, 'role', '') == 'VIEWER' and not getattr(request.user, 'is_superuser', False):
        return JsonResponse({'status': 'error', 'message': 'Tài khoản Viewer không có quyền thêm thiết bị!'}, status=403)

    try:
        data = json.loads(request.body)
        dev_eui = data.get('dev_eui', '').strip().upper()
        device_name = data.get('device_name', '').strip()
        device_type = data.get('device_type', 'NUT_NHAN')
        category_type = data.get('category_type', 'CAP_CUU_Y_TE')
        customer_name = data.get('customer_name', '').strip() or 'Demo LoRaWAN'
        emergency_phone = data.get('emergency_phone', '').strip() or '0905123456'
        has_gps = bool(data.get('has_gps', False))
        address = data.get('address', '').strip()

        if not dev_eui or not device_name:
            return JsonResponse({'status': 'error', 'message': 'Vui lòng nhập đầy đủ Tên thiết bị và Mã định danh ID/DevEUI!'}, status=400)

        if Device.objects.filter(dev_eui=dev_eui).exists():
            return JsonResponse({'status': 'error', 'message': f'Mã DevEUI "{dev_eui}" đã tồn tại!'}, status=400)

        try:
            lat = float(data.get('latitude')) if data.get('latitude') not in [None, '', 'NaN'] else 16.054407
            lng = float(data.get('longitude')) if data.get('longitude') not in [None, '', 'NaN'] else 108.202167
        except (ValueError, TypeError):
            lat, lng = 16.054407, 108.202167

        parent_id = data.get('parent_device_id') if 'parent_device_id' in data else data.get('parent_id')
        p_dev = None
        if parent_id and parent_id not in ('', 0, '0', 'none', 'null', None):
            try:
                p_dev = Device.objects.get(id=int(parent_id))
            except (Device.DoesNotExist, ValueError):
                pass
        group_name = str(data.get('group_name', '')).strip()

        hb_interval = data.get('heartbeat_interval') if 'heartbeat_interval' in data else data.get('uplink_interval')
        try:
            hb_val = max(1, int(hb_interval)) if hb_interval else 300
        except (ValueError, TypeError):
            hb_val = 300

        device = Device.objects.create(
            dev_eui=dev_eui,
            device_name=device_name,
            device_type=device_type,
            category_type=category_type,
            customer_name=customer_name,
            emergency_phone=emergency_phone,
            has_gps=has_gps,
            parent_device=p_dev,
            group_name=group_name or None,
            address=address if not has_gps else f'{lat}, {lng}',
            latitude=lat,
            longitude=lng,
            heartbeat_interval=hb_val,
            connection_status=Device.ConnectionStatus.ONLINE,
            last_seen=timezone.now()
        )

        if has_gps:
            LocationHistory.objects.create(device=device, latitude=lat, longitude=lng, speed=0.0, battery_level=100)

        return JsonResponse({'status': 'success', 'message': f'Đã đăng ký thiết bị: {device_name}', 'device_id': device.id})
    except Exception as e:
        return JsonResponse({'status': 'error', 'message': str(e)}, status=500)


@csrf_exempt
def api_delete_devices(request):
    if request.method != 'POST':
        return JsonResponse({'status': 'error'}, status=405)
    if hasattr(request, 'user') and request.user.is_authenticated and getattr(request.user, 'role', '') == 'VIEWER' and not getattr(request.user, 'is_superuser', False):
        return JsonResponse({'status': 'error', 'message': 'Viewer không có quyền xóa thiết bị!'}, status=403)

    data = json.loads(request.body)
    ids = data.get('ids', [])
    Device.objects.filter(id__in=ids).delete()
    return JsonResponse({'status': 'success', 'message': f'Đã xóa {len(ids)} thiết bị.'})


@csrf_exempt
def api_create_user(request):
    if request.method != 'POST':
        return JsonResponse({'status': 'error'}, status=405)
    if hasattr(request, 'user') and request.user.is_authenticated and getattr(request.user, 'role', '') == 'VIEWER' and not getattr(request.user, 'is_superuser', False):
        return JsonResponse({'status': 'error', 'message': 'Viewer không có quyền tạo tài khoản!'}, status=403)

    data = json.loads(request.body)
    uname = data.get('username', '').strip()
    pwd = data.get('password', '').strip()
    if not uname or not pwd:
        return JsonResponse({'status': 'error', 'message': 'Vui lòng nhập đầy đủ Username và Mật khẩu!'}, status=400)
    if User.objects.filter(username=uname).exists():
        return JsonResponse({'status': 'error', 'message': f'Tài khoản "{uname}" đã tồn tại!'}, status=400)

    role = data.get('role', 'VIEWER')
    u = User.objects.create_user(
        username=uname,
        password=pwd,
        first_name=data.get('full_name', '').strip() or uname,
        role=role,
        phone_number=data.get('phone_number', '').strip(),
        is_staff=False,
        is_superuser=False
    )
    return JsonResponse({'status': 'success', 'message': f'Đã tạo tài khoản {uname} thành công!'})


@csrf_exempt
def api_delete_user(request, user_id=None):
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Method not allowed'}, status=405)

    if hasattr(request, 'user') and request.user.is_authenticated and getattr(request.user, 'role', '') == 'VIEWER' and not getattr(request.user, 'is_superuser', False):
        return JsonResponse({'status': 'error', 'message': 'Viewer không có quyền xóa tài khoản!'}, status=403)

    try:
        if user_id is None:
            data = json.loads(request.body or '{}')
            user_id = data.get('user_id')

        target_user = User.objects.filter(id=user_id).first()
        if not target_user:
            return JsonResponse({'status': 'error', 'message': 'Không tìm thấy tài khoản cần xóa!'}, status=404)

        if hasattr(request, 'user') and request.user.is_authenticated and target_user.id == request.user.id:
            return JsonResponse({'status': 'error', 'message': 'Không thể tự xóa tài khoản đang đăng nhập!'}, status=400)

        if target_user.is_superuser or target_user.role == User.Role.SYSTEM_ADMIN:
            return JsonResponse({'status': 'error', 'message': 'Không thể xóa tài khoản Quản trị hệ thống!'}, status=403)

        deleted_name = target_user.username
        target_user.delete()
        return JsonResponse({'status': 'success', 'message': f'Đã xóa tài khoản "{deleted_name}" vĩnh viễn!'})
    except Exception as e:
        return JsonResponse({'status': 'error', 'message': f'Lỗi khi xóa: {str(e)}'}, status=500)


@csrf_exempt
def api_change_password(request):
    """
    Thay đổi mật khẩu cho người dùng hiện đang đăng nhập.
    Tự động duy trì phiên đăng nhập sau khi đổi bằng update_session_auth_hash.
    """
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Phương thức không được hỗ trợ!'}, status=405)

    if not request.user.is_authenticated:
        return JsonResponse({'status': 'error', 'message': 'Bạn chưa đăng nhập!'}, status=401)

    try:
        data = json.loads(request.body or '{}')
    except Exception:
        return JsonResponse({'status': 'error', 'message': 'Dữ liệu JSON không hợp lệ!'}, status=400)

    current_pwd = data.get('current_password', '')
    new_pwd = data.get('new_password', '')
    confirm_pwd = data.get('confirm_password', '')

    if not current_pwd or not new_pwd:
        return JsonResponse({'status': 'error', 'message': 'Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới!'}, status=400)

    if not request.user.check_password(current_pwd):
        return JsonResponse({'status': 'error', 'message': 'Mật khẩu hiện tại không chính xác!'}, status=400)

    if new_pwd != confirm_pwd:
        return JsonResponse({'status': 'error', 'message': 'Mật khẩu mới và xác nhận mật khẩu không trùng khớp!'}, status=400)

    if len(new_pwd) < 1:
        return JsonResponse({'status': 'error', 'message': 'Mật khẩu mới không được để trống!'}, status=400)

    request.user.set_password(new_pwd)
    request.user.save()
    update_session_auth_hash(request, request.user)

    return JsonResponse({
        'status': 'success',
        'message': 'Đổi mật khẩu thành công! Mật khẩu mới đã được cập nhật.'
    })


@csrf_exempt
def api_update_profile(request):
    """
    Cập nhật thông tin cá nhân của người dùng hiện tại (Họ và tên, SĐT, Email).
    Phần mật khẩu được tách riêng qua modal đổi mật khẩu.
    """
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Phương thức không được hỗ trợ!'}, status=405)

    if not request.user.is_authenticated:
        return JsonResponse({'status': 'error', 'message': 'Bạn chưa đăng nhập!'}, status=401)

    try:
        data = json.loads(request.body or '{}')
    except Exception:
        return JsonResponse({'status': 'error', 'message': 'Dữ liệu JSON không hợp lệ!'}, status=400)

    full_name = data.get('full_name', '').strip()
    phone_number = data.get('phone_number', '').strip()
    email = data.get('email', '').strip()

    if not full_name:
        return JsonResponse({'status': 'error', 'message': 'Họ và tên không được để trống!'}, status=400)

    request.user.first_name = full_name
    request.user.phone_number = phone_number
    if email:
        request.user.email = email
    request.user.save()

    return JsonResponse({
        'status': 'success',
        'message': 'Cập nhật thông tin cá nhân thành công!',
        'full_name': request.user.first_name,
        'phone_number': request.user.phone_number or '',
        'email': request.user.email or ''
    })


@csrf_exempt
def webhook_iot_uplink(request):
    """
    Chuyển tiếp toàn bộ xử lý Webhook sang module chuyên biệt hctech_webhook.py
    (Hỗ trợ cả chuẩn HC TECH IoT mới lẫn ChirpStack v4 cũ).
    """
    return hctech_webhook_view(request)


@csrf_exempt
def api_dispatch_emergency(request):
    """
    Phát thông báo khẩn cấp thủ công từ giao diện điều hành.
    Cho phép chọn thiết bị tiếp nhận và tùy chọn ghi chú cảnh báo.
    """
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Phương thức không được hỗ trợ'}, status=405)

    try:
        data = json.loads(request.body or '{}')
        device_id = data.get('device_id')
        alert_type = data.get('alert_type', 'CUU_HO_BIEN')
        notes = (data.get('notes') or '').strip()

        device = None
        if device_id:
            device = Device.objects.filter(id=device_id, is_active=True).first()

        if not device:
            dev_eui = (data.get('dev_eui') or '').strip().upper()
            if dev_eui:
                device = Device.objects.filter(dev_eui=dev_eui, is_active=True).first()

        if not device:
            return JsonResponse({'status': 'error', 'message': 'Không tìm thấy thiết bị để phát cảnh báo!'}, status=404)

        # Cập nhật trạng thái thiết bị sang SOS
        device.connection_status = Device.ConnectionStatus.SOS
        device.last_seen = timezone.now()
        device.save()

        # Tạo bản ghi AlertLog mới
        created_alert = AlertLog.objects.create(
            device=device,
            alert_type=alert_type if alert_type in AlertLog.AlertType.values else (
                AlertLog.AlertType.CUU_HO_BIEN if device.has_gps else AlertLog.AlertType.CAP_CUU_Y_TE
            ),
            status=AlertLog.AlertStatus.NEW,
            latitude=device.latitude,
            longitude=device.longitude,
            address=device.address,
            notes=notes if notes else None,
            area=device.area
        )

        # Ghi nhận điểm SOS vào lịch sử hành trình nếu có tọa độ GPS
        if device.has_gps and device.latitude and device.longitude:
            LocationHistory.objects.create(
                device=device,
                latitude=device.latitude,
                longitude=device.longitude,
                speed=0.0,
                battery_level=device.battery_level,
                is_sos_point=True
            )

        # ⚡ Phát tín hiệu thời gian thực SSE tới tất cả Dashboard đang mở
        broadcast_event("IOT_UPLINK", {
            "device_id": device.id,
            "dev_eui": device.dev_eui,
            "device_name": device.device_name,
            "connection_status": device.connection_status,
            "is_sos": True,
            "battery_level": device.battery_level,
            "latitude": float(device.latitude) if device.latitude else None,
            "longitude": float(device.longitude) if device.longitude else None,
            "alert_id": created_alert.id,
            "alert_type": created_alert.get_alert_type_display(),
            "notes": notes
        })

        return JsonResponse({
            'status': 'success',
            'message': f'Đã phát thông báo khẩn cấp cho {device.device_name}',
            'alert_id': created_alert.id,
            'device_id': device.id,
            'device_name': device.device_name,
            'latitude': float(device.latitude) if device.latitude else None,
            'longitude': float(device.longitude) if device.longitude else None
        })
    except Exception as e:
        return JsonResponse({'status': 'error', 'message': f'Lỗi hệ thống: {str(e)}'}, status=500)


def sse_stream(request):
    """
    Endpoint Server-Sent Events (SSE) để truyền dữ liệu thời gian thực tới trình duyệt.
    """
    q = register_subscriber()

    def event_stream():
        try:
            # Gửi gói tin chào mừng khi client kết nối
            yield "event: connected\ndata: {}\n\n"
            while True:
                try:
                    msg = q.get(timeout=15)
                    # Hỗ trợ cả dữ liệu phẳng lẫn nested payload để tương thích 100% với mọi client
                    payload = msg.get("payload", {}) if isinstance(msg, dict) else {}
                    flat_data = dict(payload) if isinstance(payload, dict) else {}
                    flat_data["type"] = msg.get("type", "message")
                    flat_data["payload"] = payload
                    json_str = json.dumps(flat_data)

                    event_type = msg.get("type", "message")
                    yield f"event: message\ndata: {json_str}\n\n"
                    if event_type and event_type != "message":
                        yield f"event: {event_type}\ndata: {json_str}\n\n"
                except queue.Empty:
                    # Gửi heartbeat keep-alive tránh browser ngắt kết nối
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
        finally:
            unregister_subscriber(q)

    response = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
    response['Cache-Control'] = 'no-cache'
    response['X-Accel-Buffering'] = 'no'
    return response


@csrf_exempt
def api_process_alert(request, alert_id):
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    alert = get_object_or_404(AlertLog, id=alert_id)
    device = alert.device
    data = json.loads(request.body)
    action = data.get('action')

    if action == 'acknowledge':
        alert.status = AlertLog.AlertStatus.PROCESSING
        alert.acknowledged_at = timezone.now()
        if hasattr(request, 'user') and request.user.is_authenticated:
            alert.acknowledged_by = request.user
        device.connection_status = Device.ConnectionStatus.PROCESSING
        device.save()
        alert.save()

        broadcast_event("IOT_UPLINK", {
            "dev_eui": device.dev_eui,
            "device_name": device.device_name,
            "connection_status": device.connection_status,
            "is_sos": True,
            "battery_level": device.battery_level,
            "latitude": float(device.latitude) if device.latitude else None,
            "longitude": float(device.longitude) if device.longitude else None,
            "alert_id": alert.id,
            "resolved": False
        })
    elif action == 'update_notes':
        alert.notes = data.get('notes', '')
        alert.save()

        broadcast_event("IOT_UPLINK", {
            "dev_eui": device.dev_eui,
            "device_name": device.device_name,
            "connection_status": device.connection_status,
            "is_sos": (device.connection_status in [Device.ConnectionStatus.SOS, Device.ConnectionStatus.PROCESSING]),
            "battery_level": device.battery_level,
            "latitude": float(device.latitude) if device.latitude else None,
            "longitude": float(device.longitude) if device.longitude else None,
            "alert_id": alert.id,
            "resolved": False
        })
    elif action == 'resolve':
        alert.status = AlertLog.AlertStatus.RESOLVED
        alert.resolved_at = timezone.now()
        alert.resolution_report = data.get('resolution_report') or 'Đã tiếp nhận & hoàn tất điều phối cứu hộ'
        if data.get('notes'):
            alert.notes = data.get('notes')
        if hasattr(request, 'user') and request.user.is_authenticated:
            alert.resolved_by = request.user
        device.connection_status = Device.ConnectionStatus.ONLINE
        device.save()
        alert.save()

        broadcast_event("IOT_UPLINK", {
            "dev_eui": device.dev_eui,
            "device_name": device.device_name,
            "connection_status": device.connection_status,
            "is_sos": False,
            "battery_level": device.battery_level,
            "latitude": float(device.latitude) if device.latitude else None,
            "longitude": float(device.longitude) if device.longitude else None,
            "alert_id": alert.id,
            "resolved": True
        })

    return JsonResponse({'status': 'success', 'alert_status': alert.status})


@csrf_exempt
def api_turn_off_device_alert(request, device_id):
    """
    Tắt cảnh báo khẩn cấp trực tiếp từ popup của thiết bị trên bản đồ.
    Đưa trạng thái thiết bị về ONLINE và đóng các AlertLog đang mở của thiết bị này.
    """
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Phương thức không được hỗ trợ'}, status=405)

    device = get_object_or_404(Device, id=device_id)

    # Cập nhật thiết bị về ONLINE
    device.connection_status = Device.ConnectionStatus.ONLINE
    device.save()

    # Đóng các bản ghi AlertLog chưa hoàn tất của thiết bị
    now = timezone.now()
    active_alerts = AlertLog.objects.filter(device=device, status__in=['NEW', 'PROCESSING'])
    closed_count = 0
    for a in active_alerts:
        a.status = AlertLog.AlertStatus.RESOLVED
        a.resolved_at = now
        if not a.resolution_report:
            a.resolution_report = "Đã tắt cảnh báo trực tiếp từ bản đồ điều phối"
        if hasattr(request, 'user') and request.user.is_authenticated:
            a.resolved_by = request.user
        a.save()
        closed_count += 1

    # Phát tín hiệu SSE để toàn bộ giao diện cập nhật ngay lập tức (0ms delay)
    broadcast_event("IOT_UPLINK", {
        "dev_eui": device.dev_eui,
        "device_name": device.device_name,
        "connection_status": device.connection_status,
        "is_sos": False,
        "battery_level": device.battery_level,
        "latitude": float(device.latitude) if device.latitude else None,
        "longitude": float(device.longitude) if device.longitude else None,
        "resolved": True
    })

    return JsonResponse({
        'status': 'success',
        'message': f'Đã tắt cảnh báo cho {device.device_name}',
        'closed_alerts': closed_count
    })


@csrf_exempt
def api_turn_off_emergency(request):
    """
    Tắt cảnh báo khẩn cấp đang diễn ra từ nút điều khiển trên thanh công cụ.
    Nếu có device_id thì tắt cho thiết bị đó, nếu không thì tắt cho tất cả các thiết bị đang SOS/PROCESSING.
    """
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Phương thức không được hỗ trợ'}, status=405)

    data = {}
    if request.body:
        try:
            data = json.loads(request.body)
        except Exception:
            pass

    device_id = data.get('device_id')
    now = timezone.now()

    if device_id:
        devices = list(Device.objects.filter(id=device_id))
    else:
        devices = list(Device.objects.filter(connection_status__in=[Device.ConnectionStatus.SOS, Device.ConnectionStatus.PROCESSING]))

    closed_count = 0
    for dev in devices:
        dev.connection_status = Device.ConnectionStatus.ONLINE
        dev.save()

        active_alerts = AlertLog.objects.filter(device=dev, status__in=['NEW', 'PROCESSING'])
        for a in active_alerts:
            a.status = AlertLog.AlertStatus.RESOLVED
            a.resolved_at = now
            if not a.resolution_report:
                a.resolution_report = "Đã tắt cảnh báo khẩn cấp từ giao diện điều phối"
            if hasattr(request, 'user') and request.user.is_authenticated:
                a.resolved_by = request.user
            a.save()
            closed_count += 1

        broadcast_event("IOT_UPLINK", {
            "dev_eui": dev.dev_eui,
            "device_id": dev.id,
            "device_name": dev.device_name,
            "connection_status": dev.connection_status,
            "is_sos": False,
            "battery_level": dev.battery_level,
            "latitude": float(dev.latitude) if dev.latitude else None,
            "longitude": float(dev.longitude) if dev.longitude else None,
            "resolved": True
        })

    return JsonResponse({
        'status': 'success',
        'message': 'Đã tắt cảnh báo khẩn cấp thành công',
        'closed_alerts': closed_count
    })



@csrf_exempt
def api_quick_pair_device(request, device_id):
    """
    API gán nhanh nút nhấn vào thiết bị GPS hoặc hủy gán (Phục vụ chức năng Nhóm thiết bị).
    """
    if request.method != 'POST':
        return JsonResponse({'status': 'error', 'message': 'Method not allowed'}, status=405)

    if hasattr(request, 'user') and request.user.is_authenticated and getattr(request.user, 'role', '') == 'VIEWER' and not getattr(request.user, 'is_superuser', False):
        return JsonResponse({'status': 'error', 'message': 'Tài khoản Viewer không có quyền cấu hình nhóm thiết bị!'}, status=403)

    device = get_object_or_404(Device, id=device_id)
    try:
        data = json.loads(request.body or '{}')
    except Exception:
        return JsonResponse({'status': 'error', 'message': 'Invalid JSON body'}, status=400)

    parent_id = data.get('parent_device_id') or data.get('gps_device_id')
    group_name = data.get('group_name')
    sync_info = bool(data.get('sync_info', False))

    if parent_id in ('', 0, '0', None, 'none', 'null'):
        device.parent_device = None
    else:
        try:
            parent_dev = Device.objects.get(id=int(parent_id), is_active=True)
            if parent_dev.id == device.id:
                return JsonResponse({'status': 'error', 'message': 'Không thể gán thiết bị vào chính nó!'}, status=400)

            # Chống vòng lặp liên kết (A -> B -> A)
            curr = parent_dev
            while curr.parent_device:
                if curr.parent_device_id == device.id:
                    return JsonResponse({'status': 'error', 'message': 'Không thể tạo vòng lặp liên kết (thiết bị này đang là cha của thiết bị được chọn)!'}, status=400)
                curr = curr.parent_device

            device.parent_device = parent_dev

            # Tự động đồng bộ tên nhóm nếu thiết bị con chưa có mà thiết bị cha có
            if not group_name and parent_dev.group_name:
                group_name = parent_dev.group_name

            # Tùy chọn đồng bộ thông tin chủ hộ / SĐT / địa chỉ từ thiết bị liên kết nếu bật
            if sync_info:
                if parent_dev.customer_name and (not device.customer_name or not device.customer_name.strip() or device.customer_name in ('Demo LoRaWAN', 'Chưa đặt tên')):
                    device.customer_name = parent_dev.customer_name
                if parent_dev.emergency_phone and (not device.emergency_phone or not device.emergency_phone.strip() or device.emergency_phone == '0905000000'):
                    device.emergency_phone = parent_dev.emergency_phone
                if parent_dev.address and (not device.address or not device.address.strip() or 'Đang cập nhật' in device.address):
                    device.address = parent_dev.address
                if parent_dev.latitude and not device.latitude:
                    device.latitude = parent_dev.latitude
                    device.longitude = parent_dev.longitude
                if parent_dev.area and not device.area:
                    device.area = parent_dev.area
        except Device.DoesNotExist:
            return JsonResponse({'status': 'error', 'message': 'Không tìm thấy thiết bị liên kết hợp lệ!'}, status=404)

    if group_name is not None:
        device.group_name = str(group_name).strip()

    device.save()

    parent_name = device.parent_device.device_name if device.parent_device else 'Độc lập'
    group_display = device.group_name or (f"Cùng: {parent_name}" if device.parent_device else "Độc lập")

    broadcast_event("IOT_UPLINK", {
        "device_id": device.id,
        "dev_eui": device.dev_eui,
        "device_name": device.device_name,
        "device_type": device.device_type,
        "parent_device_id": device.parent_device.id if device.parent_device else None,
        "parent_device_name": device.parent_device.device_name if device.parent_device else None,
        "group_name": device.group_name or "",
        "connection_status": device.connection_status,
        "is_sos": (device.connection_status == Device.ConnectionStatus.SOS),
    })

    return JsonResponse({
        'status': 'success',
        'message': f"Đã gán '{device.device_name}' vào nhóm '{group_display}' thành công!",
        'parent_id': device.parent_device.id if device.parent_device else None,
        'parent_name': parent_name,
        'group_name': device.group_name or ""
    })

def api_route_history(request, device_id):
    range_filter = request.GET.get('range', '24h')
    now = timezone.now()
    if range_filter == 'today':
        start_time = now.replace(hour=0, minute=0, second=0)
    elif range_filter == '7d':
        start_time = now - timedelta(days=7)
    elif range_filter == '30d':
        start_time = now - timedelta(days=30)
    else:
        start_time = now - timedelta(hours=24)

    target_dev = get_object_or_404(Device, id=device_id)
    # Nếu chọn nút nhấn đã gán vào GPS, tự động dùng thiết bị GPS cha
    effective_dev = target_dev.parent_device if (not target_dev.has_gps and target_dev.parent_device) else target_dev

    points = list(LocationHistory.objects.filter(
        device_id=effective_dev.id, 
        recorded_at__gte=start_time
    ).select_related('button_device').order_by('recorded_at'))

    total_distance_km = 0.0
    history_data = []

    for i, pt in enumerate(points):
        if i > 0:
            prev = points[i - 1]
            total_distance_km += haversine_distance(prev.latitude, prev.longitude, pt.latitude, pt.longitude)

        has_button = bool(pt.button_device_id)
        btn_name = pt.button_device.device_name if pt.button_device else ""
        btn_eui = pt.button_device.dev_eui if pt.button_device else ""

        pkt_type = getattr(pt, 'packet_type', 'PERIODIC')
        if pt.is_sos_point:
            pkt_type = 'SOS'
        elif not pkt_type or pkt_type == 'PERIODIC':
            if has_button:
                pkt_type = 'HEARTBEAT'
            else:
                pkt_type = 'PERIODIC'

        history_data.append({
            'lat': float(pt.latitude),
            'lng': float(pt.longitude),
            'speed': pt.speed,
            'battery': pt.battery_level,
            'is_sos': pt.is_sos_point,
            'packet_type': pkt_type,
            'has_button': has_button,
            'button_name': btn_name,
            'button_eui': btn_eui,
            'is_drifting': pt.is_drifting,
            'time': pt.recorded_at.strftime('%H:%M:%S %d/%m/%Y')
        })

    return JsonResponse({
        'points': history_data,
        'total_distance_km': round(total_distance_km, 2),
        'point_count': len(history_data),
        'device_name': effective_dev.device_name,
        'has_gps': effective_dev.has_gps
    })


def export_alerts_csv(request):
    if hasattr(request, 'user') and request.user.is_authenticated and getattr(request.user, 'role', '') == 'VIEWER' and not getattr(request.user, 'is_superuser', False):
        return HttpResponseForbidden("Chỉ Tenant Admin mới có quyền tải dữ liệu báo cáo.")

    response = HttpResponse(content_type='text/csv; charset=utf-8-sig')
    response['Content-Disposition'] = 'attachment; filename="Bao_Cao_Su_Kien_Cuu_Ho.csv"'
    writer = csv.writer(response)
    writer.writerow([
        'Mã sự kiện', 'DevEUI', 'Tên thiết bị', 'Loại cứu hộ', 'Trạng thái',
        'Thời điểm SOS', 'Thời điểm tiếp nhận', 'Thời điểm hoàn tất',
        'Tọa độ / Địa chỉ', 'Ghi chú điều phối', 'Báo cáo kết quả'
    ])
    for log in AlertLog.objects.select_related('device').all():
        writer.writerow([
            f"SOS-{log.id}", log.device.dev_eui, log.device.device_name,
            "Thiết bị GPS" if log.device.has_gps else "Thiết bị cố định",
            log.get_status_display(),
            log.created_at.strftime('%d/%m/%Y %H:%M:%S'),
            log.acknowledged_at.strftime('%d/%m/%Y %H:%M:%S') if log.acknowledged_at else '-',
            log.resolved_at.strftime('%d/%m/%Y %H:%M:%S') if log.resolved_at else '-',
            f"{log.latitude}, {log.longitude}" if log.device.has_gps else log.address,
            log.notes or '', log.resolution_report or ''
        ])
    return response


# ==============================================================================
# 7. TRANG QUẢN TRỊ RIÊNG BIỆT (/admin/) & LỆNH CƠ SỞ DỮ LIỆU, WEBHOOK NÂNG CAO
# ==============================================================================
def get_database_metrics():
    """Lấy dung lượng hiện tại của cơ sở dữ liệu PostgreSQL."""
    size = "N/A"
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_size_pretty(pg_database_size(current_database()));")
            row = cursor.fetchone()
            if row:
                size = row[0]
    except Exception:
        pass
    return size


@login_required(login_url='/login/')
def admin_portal_view(request):
    """
    Trang Quản Trị Hệ Thống Chuyên Sâu (/admin/):
    - Quản lý Webhook & API Gateway (HC TECH IoT & ChirpStack)
    - Trình giả lập gói tin Webhook trực quan
    - Thao tác Cơ sở Dữ liệu & Lệnh dọn dẹp, sao lưu, nạp dữ liệu mẫu
    - Chẩn đoán sức khỏe hệ thống & Lệnh điều hành nâng cao
    """
    ensure_default_accounts()

    # Chỉ Superuser mới được phép truy cập Trang Quản Trị Hệ Thống (/admin/)
    if not (request.user.is_authenticated and request.user.is_superuser):
        return render(request, 'admin_denied.html', {'user': request.user}, status=403)

    # 1. Thống kê số lượng bản ghi Cơ sở dữ liệu
    device_total = Device.objects.count()
    device_online = Device.objects.filter(connection_status=Device.ConnectionStatus.ONLINE).count()
    device_sos = Device.objects.filter(connection_status=Device.ConnectionStatus.SOS).count()
    device_processing = Device.objects.filter(connection_status=Device.ConnectionStatus.PROCESSING).count()
    device_offline = Device.objects.filter(connection_status=Device.ConnectionStatus.OFFLINE).count()
    device_gps = Device.objects.filter(has_gps=True).count()

    alert_total = AlertLog.objects.count()
    alert_new = AlertLog.objects.filter(status=AlertLog.AlertStatus.NEW).count()
    alert_processing = AlertLog.objects.filter(status=AlertLog.AlertStatus.PROCESSING).count()
    alert_resolved = AlertLog.objects.filter(status=AlertLog.AlertStatus.RESOLVED).count()
    alert_false = AlertLog.objects.filter(status=AlertLog.AlertStatus.FALSE_ALARM).count()

    location_total = LocationHistory.objects.count()
    location_sos = LocationHistory.objects.filter(is_sos_point=True).count()
    area_total = Area.objects.count()
    user_total = User.objects.count()
    db_size = get_database_metrics()

    # 2. Cấu hình HC TECH Cloud
    cloud_base_url = getattr(settings, 'HCTECH_IOT_BASE_URL', 'https://iot-staging.hctech.com.vn/api/public/v1')
    raw_token = getattr(settings, 'HCTECH_IOT_API_TOKEN', '')
    masked_token = f"{raw_token[:8]}...{raw_token[-6:]}" if len(raw_token) > 16 else raw_token

    # 3. Webhook URL đầy đủ
    webhook_url = request.build_absolute_uri('/api/webhook/uplink/')

    # 4. Danh sách thiết bị phục vụ dropdown giả lập
    devices_list = list(Device.objects.filter(is_active=True).order_by('id').values('id', 'dev_eui', 'device_name', 'has_gps', 'connection_status'))
    recent_alerts = list(AlertLog.objects.select_related('device').order_by('-created_at')[:8])
    recent_locations = list(LocationHistory.objects.select_related('device').order_by('-recorded_at')[:8])

    context = {
        'user': request.user,
        'current_user_display': request.user.first_name or request.user.username,
        'user_role_label': request.user.get_role_display(),
        'device_total': device_total,
        'device_online': device_online,
        'device_sos': device_sos,
        'device_processing': device_processing,
        'device_offline': device_offline,
        'device_gps': device_gps,
        'alert_total': alert_total,
        'alert_new': alert_new,
        'alert_processing': alert_processing,
        'alert_resolved': alert_resolved,
        'alert_false': alert_false,
        'location_total': location_total,
        'location_sos': location_sos,
        'area_total': area_total,
        'user_total': user_total,
        'db_size': db_size,
        'cloud_base_url': cloud_base_url,
        'cloud_token_masked': masked_token,
        'cloud_token_full': raw_token,
        'webhook_url': webhook_url,
        'webhook_bearer_token': get_webhook_token(),
        'devices_list': devices_list,
        'recent_alerts': recent_alerts,
        'recent_locations': recent_locations,
        'server_time': timezone.localtime(timezone.now()).strftime('%H:%M:%S %d/%m/%Y'),
    }
    return render(request, 'admin_portal.html', context)


@csrf_exempt
def api_admin_action(request, action):
    """
    Xử lý các lệnh quản trị AJAX từ Trang Admin Portal:
    - test_cloud: Kiểm tra kết nối tới HC TECH IoT Cloud
    - sync_cloud: Đồng bộ tức thời từ HC TECH Cloud
    - send_test_webhook: Bơm gói tin giả lập vào Webhook Uplink
    - clear_webhook_cache: Xóa cache chống trùng lặp event_id
    - cleanup_gps: Dọn dẹp dữ liệu lịch sử GPS cũ
    - cleanup_alerts: Dọn dẹp cảnh báo đã hoàn tất cũ
    - reset_devices: Đưa tất cả thiết bị về trạng thái ONLINE
    - seed_data: Nạp lại bộ dữ liệu chuẩn
    - simulate_emergency: Giả lập phát sự cố khẩn cấp
    - system_check: Chạy kiểm tra hệ thống Django
    - get_metrics: Lấy số liệu mới nhất
    - export_devices_json: Tải danh mục thiết bị dạng JSON
    """
    # Chỉ Superuser mới có quyền thực hiện các lệnh quản trị hệ thống
    if not (hasattr(request, 'user') and request.user.is_authenticated and request.user.is_superuser):
        return JsonResponse({'status': 'error', 'message': 'Chỉ Superuser mới có quyền thực hiện thao tác quản trị này!'}, status=403)

    if request.method != 'POST' and action not in ['list_downlink_commands', 'get_metrics', 'get_webhook_monitor_logs', 'export_devices_json']:
        return JsonResponse({'status': 'error', 'message': 'Phương thức không được hỗ trợ'}, status=405)

    data = {}
    if request.method == 'GET':
        data = {k: v for k, v in request.GET.items()}
    elif request.body:
        try:
            data = json.loads(request.body)
        except Exception:
            pass

    # 1. TEST CLOUD CONNECTION
    if action == 'test_cloud':
        t0 = time.time()
        try:
            client = HCTechIoTClient()
            res = client.get_groups(limit=5)
            latency_ms = round((time.time() - t0) * 1000, 1)
            groups = res.get('data', [])
            return JsonResponse({
                'status': 'success',
                'message': f'Kết nối thành công tới HC TECH Cloud! Độ trễ: {latency_ms} ms.',
                'groups_count': len(groups),
                'latency_ms': latency_ms,
                'groups': [{'id': g.get('id'), 'name': g.get('name'), 'count': g.get('device_count', 0)} for g in groups]
            })
        except Exception as e:
            return JsonResponse({
                'status': 'error',
                'message': f'Lỗi kết nối HC TECH Cloud: {str(e)}'
            }, status=502)

    # 2. SYNC CLOUD
    elif action == 'sync_cloud':
        lookback = int(data.get('lookback_hours', 24))
        token = data.get('token') or getattr(settings, 'HCTECH_IOT_API_TOKEN', '')
        try:
            summary = sync_hctech_catalog_and_telemetry(bearer_token=token, lookback_hours=lookback)
            return JsonResponse({
                'status': 'success',
                'message': f"Đồng bộ thành công: {summary['groups_synced']} nhóm, {summary['devices_synced']} thiết bị, {summary['telemetry_synced']} bản ghi đo.",
                'summary': summary
            })
        except Exception as e:
            return JsonResponse({'status': 'error', 'message': f'Lỗi đồng bộ: {str(e)}'}, status=500)

    # 3. SEND TEST WEBHOOK
    elif action == 'send_test_webhook':
        payload = data.get('payload')
        if not payload:
            return JsonResponse({'status': 'error', 'message': 'Thiếu payload gói tin cần giả lập!'}, status=400)
        t0 = time.time()
        try:
            events = payload if isinstance(payload, list) else (payload.get('data') if isinstance(payload.get('data'), list) else [payload])
            results = []
            for ev in events:
                r = HCTechWebhookHandler.process_telemetry_record(ev, trigger_sse=True)
                results.append(r)
            latency_ms = round((time.time() - t0) * 1000, 1)

            # Đưa gói tin giả lập lên Webhook Monitor để Admin kiểm tra tức thời
            now_vn = timezone.localtime(timezone.now())
            sim_dev_eui = ""
            if isinstance(payload, dict):
                sim_dev_eui = payload.get("dev_eui") or payload.get("devEui") or ""
            elif isinstance(payload, list) and len(payload) > 0 and isinstance(payload[0], dict):
                sim_dev_eui = payload[0].get("dev_eui") or payload[0].get("devEui") or ""

            sim_entry = {
                "id": f"sim_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}",
                "timestamp": now_vn.strftime("%H:%M:%S %d/%m/%Y"),
                "time_only": now_vn.strftime("%H:%M:%S"),
                "client_ip": "127.0.0.1 (Simulator)",
                "method": "POST (Admin Simulator)",
                "content_type": "application/json",
                "auth_status": "authorized (internal)",
                "token_masked": "Internal-Admin",
                "is_valid_json": True,
                "raw_body": json.dumps(payload, ensure_ascii=False, indent=2),
                "json_data": payload,
                "dev_eui": sim_dev_eui,
                "is_sos": any(bool(r.get("sos_triggered")) for r in results),
                "status_code": 200,
                "status_message": f"Giả lập thành công {len(results)} gói tin ({latency_ms} ms).",
                "processed_count": len(results),
                "results": results,
                "error_message": None,
                "headers": {"Source": "Admin Portal Simulator"}
            }
            add_webhook_monitor_log(sim_entry)
            broadcast_event("WEBHOOK_MONITOR", sim_entry)
            return JsonResponse({
                'status': 'success',
                'message': f'Đã xử lý {len(results)} gói tin thành công trong {latency_ms} ms.',
                'latency_ms': latency_ms,
                'results': results
            })
        except Exception as e:
            return JsonResponse({'status': 'error', 'message': f'Lỗi khi xử lý gói tin: {str(e)}'}, status=400)

    # 4. CLEAR WEBHOOK CACHE
    elif action == 'clear_webhook_cache':
        try:
            cache.clear()
            return JsonResponse({'status': 'success', 'message': 'Đã xóa toàn bộ cache chống trùng lặp Webhook thành công!'})
        except Exception as e:
            return JsonResponse({'status': 'error', 'message': f'Lỗi xóa cache: {str(e)}'}, status=500)

    # 4b. SINH TOKEN XÁC THỰC WEBHOOK MỚI
    elif action == 'generate_webhook_token':
        try:
            new_token = generate_new_webhook_token()
            return JsonResponse({
                'status': 'success',
                'message': 'Đã sinh Authorization Bearer token mới và kích hoạt thành công!',
                'token': new_token
            })
        except Exception as e:
            return JsonResponse({'status': 'error', 'message': f'Lỗi khi sinh token: {str(e)}'}, status=500)

    # 4c. LƯU TOKEN XÁC THỰC WEBHOOK
    elif action == 'save_webhook_token':
        token_to_save = str(data.get('token', '')).strip()
        if not token_to_save:
            return JsonResponse({'status': 'error', 'message': 'Token không được để trống!'}, status=400)
        try:
            ok = save_webhook_token(token_to_save)
            if ok:
                return JsonResponse({
                    'status': 'success',
                    'message': 'Đã lưu cấu hình Authorization Bearer token thành công!',
                    'token': token_to_save
                })
            else:
                return JsonResponse({'status': 'error', 'message': 'Không thể ghi file cấu hình token!'}, status=500)
        except Exception as e:
            return JsonResponse({'status': 'error', 'message': f'Lỗi lưu token: {str(e)}'}, status=500)

    # 4d. LẤY NHẬT KÝ WEBHOOK MONITOR REAL-TIME
    elif action == 'get_webhook_monitor_logs':
        logs = get_webhook_monitor_logs()
        return JsonResponse({'status': 'success', 'logs': logs, 'count': len(logs)})

    # 4e. XÓA SẠCH NHẬT KÝ WEBHOOK MONITOR
    elif action == 'clear_webhook_monitor_logs':
        clear_webhook_monitor_logs()
        broadcast_event("WEBHOOK_MONITOR_CLEAR", {"cleared": True})
        return JsonResponse({'status': 'success', 'message': 'Đã xóa toàn bộ nhật ký gói tin Webhook Monitor!'})

    # 5. CLEANUP OLD GPS
    elif action == 'cleanup_gps':
        days = int(data.get('days', 30))
        keep_sos = bool(data.get('keep_sos', True))
        cutoff = timezone.now() - timedelta(days=days)
        qs = LocationHistory.objects.filter(recorded_at__lt=cutoff)
        if keep_sos:
            qs = qs.filter(is_sos_point=False)
        deleted_count, _ = qs.delete()
        return JsonResponse({
            'status': 'success',
            'message': f'Đã dọn dẹp thành công {deleted_count} điểm GPS cũ hơn {days} ngày ({ "Bảo toàn điểm SOS" if keep_sos else "Xóa tất cả" }).',
            'deleted_count': deleted_count
        })

    # 6. CLEANUP RESOLVED ALERTS
    elif action == 'cleanup_alerts':
        days = int(data.get('days', 30))
        cutoff = timezone.now() - timedelta(days=days)
        qs = AlertLog.objects.filter(status__in=[AlertLog.AlertStatus.RESOLVED, AlertLog.AlertStatus.FALSE_ALARM], created_at__lt=cutoff)
        deleted_count, _ = qs.delete()
        return JsonResponse({
            'status': 'success',
            'message': f'Đã dọn dẹp {deleted_count} bản ghi sự cố đã hoàn tất cũ hơn {days} ngày.',
            'deleted_count': deleted_count
        })

    # 7. RESET ALL DEVICES TO ONLINE
    elif action == 'reset_devices':
        now = timezone.now()
        dev_count = Device.objects.filter(connection_status__in=[Device.ConnectionStatus.SOS, Device.ConnectionStatus.PROCESSING]).update(connection_status=Device.ConnectionStatus.ONLINE)
        alert_count = AlertLog.objects.filter(status__in=[AlertLog.AlertStatus.NEW, AlertLog.AlertStatus.PROCESSING]).update(
            status=AlertLog.AlertStatus.RESOLVED,
            resolved_at=now,
            resolution_report="Được đặt lại từ Trang Quản Trị Hệ Thống (/admin/)"
        )
        broadcast_event("IOT_UPLINK", {
            "reset_all": True,
            "resolved": True,
            "connection_status": "ONLINE"
        })
        return JsonResponse({
            'status': 'success',
            'message': f'Đã đưa {dev_count} thiết bị về ONLINE và đóng {alert_count} cảnh báo đang mở.',
            'devices_reset': dev_count,
            'alerts_closed': alert_count
        })

    # 8. SEED DATA
    elif action == 'seed_data':
        try:
            out = io.StringIO()
            call_command('seed_data', stdout=out)
            output_str = out.getvalue()
            return JsonResponse({
                'status': 'success',
                'message': 'Đã tái tạo cơ sở dữ liệu mẫu thành công!',
                'log': output_str
            })
        except Exception as e:
            return JsonResponse({'status': 'error', 'message': f'Lỗi chạy seed_data: {str(e)}'}, status=500)

    # 9. SIMULATE EMERGENCY
    elif action == 'simulate_emergency':
        device_id = data.get('device_id')
        alert_type = data.get('alert_type', AlertLog.AlertType.CUU_HO_BIEN)
        notes = (data.get('notes') or 'Sự cố giả lập từ Trang Quản Trị').strip()
        device = Device.objects.filter(id=device_id, is_active=True).first()
        if not device:
            return JsonResponse({'status': 'error', 'message': 'Không tìm thấy thiết bị!'}, status=404)

        device.connection_status = Device.ConnectionStatus.SOS
        device.last_seen = timezone.now()
        device.save()

        alert = AlertLog.objects.create(
            device=device,
            alert_type=alert_type if alert_type in AlertLog.AlertType.values else AlertLog.AlertType.CUU_HO_BIEN,
            status=AlertLog.AlertStatus.NEW,
            latitude=device.latitude,
            longitude=device.longitude,
            address=device.address,
            notes=notes,
            area=device.area
        )
        if device.has_gps and device.latitude and device.longitude:
            LocationHistory.objects.create(
                device=device,
                latitude=device.latitude,
                longitude=device.longitude,
                speed=0.0,
                battery_level=device.battery_level,
                is_sos_point=True
            )
        broadcast_event("IOT_UPLINK", {
            "device_id": device.id,
            "dev_eui": device.dev_eui,
            "device_name": device.device_name,
            "connection_status": device.connection_status,
            "is_sos": True,
            "battery_level": device.battery_level,
            "latitude": float(device.latitude) if device.latitude else None,
            "longitude": float(device.longitude) if device.longitude else None,
            "alert_id": alert.id,
            "alert_type": alert.get_alert_type_display(),
            "notes": alert.notes or ""
        })
        return JsonResponse({
            'status': 'success',
            'message': f'Đã phát tín hiệu khẩn cấp giả lập cho thiết bị "{device.device_name}"!',
            'alert_id': alert.id
        })

    # 10. SYSTEM CHECK
    elif action == 'system_check':
        try:
            out = io.StringIO()
            call_command('check', stdout=out)
            output_str = out.getvalue() or "System check identified no issues (0 silenced)."
            with connection.cursor() as cursor:
                t0 = time.time()
                cursor.execute("SELECT 1;")
                db_ping_ms = round((time.time() - t0) * 1000, 2)

            return JsonResponse({
                'status': 'success',
                'message': 'Kiểm tra hệ thống hoàn tất: Không có lỗi.',
                'output': output_str.strip(),
                'db_ping_ms': db_ping_ms,
                'db_size': get_database_metrics()
            })
        except Exception as e:
            return JsonResponse({'status': 'error', 'message': f'Lỗi kiểm tra hệ thống: {str(e)}'}, status=500)

    # 11. GET METRICS
    elif action == 'get_metrics':
        return JsonResponse({
            'status': 'success',
            'devices': {
                'total': Device.objects.count(),
                'online': Device.objects.filter(connection_status=Device.ConnectionStatus.ONLINE).count(),
                'sos': Device.objects.filter(connection_status=Device.ConnectionStatus.SOS).count(),
                'offline': Device.objects.filter(connection_status=Device.ConnectionStatus.OFFLINE).count(),
            },
            'alerts': {
                'total': AlertLog.objects.count(),
                'new': AlertLog.objects.filter(status=AlertLog.AlertStatus.NEW).count(),
                'processing': AlertLog.objects.filter(status=AlertLog.AlertStatus.PROCESSING).count(),
                'resolved': AlertLog.objects.filter(status=AlertLog.AlertStatus.RESOLVED).count(),
            },
            'locations_total': LocationHistory.objects.count(),
            'db_size': get_database_metrics()
        })

    # 12. EXPORT DATA JSON
    elif action == 'export_devices_json':
        devs = list(Device.objects.all().values(
            'id', 'dev_eui', 'device_name', 'device_type', 'category_type',
            'has_gps', 'latitude', 'longitude', 'address', 'customer_name',
            'emergency_phone', 'battery_level', 'connection_status', 'is_active', 'last_seen'
        ))
        for d in devs:
            if d.get('latitude'): d['latitude'] = float(d['latitude'])
            if d.get('longitude'): d['longitude'] = float(d['longitude'])
            if d.get('last_seen'): d['last_seen'] = d['last_seen'].isoformat()

        response = HttpResponse(json.dumps(devs, ensure_ascii=False, indent=2), content_type='application/json; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="Danh_Sach_Thiet_Bi.json"'
        return response

    # 13. SEND DOWNLINK COMMAND (LoRaWAN FR-10.1, FR-10.4, FR-10.5)
    elif action == 'send_downlink_command':
        device_id = data.get('device_id')
        mode = data.get('mode', 'command')
        command_name = data.get('command_name')
        command_params = data.get('command_parameters') or {}
        raw_f_port = data.get('raw_f_port')
        raw_payload_hex = data.get('raw_payload_hex')
        confirmed = bool(data.get('confirmed', False))

        device = Device.objects.filter(id=device_id).first() if str(device_id).isdigit() else Device.objects.filter(dev_eui__iexact=str(device_id)).first()
        if not device:
            return JsonResponse({'status': 'error', 'message': f'Không tìm thấy thiết bị với ID={device_id}'}, status=404)

        remote_uuid = None
        if device.description and 'HC TECH UUID:' in device.description:
            remote_uuid = device.description.split('HC TECH UUID:')[-1].strip()

        cloud_sent = False
        command_record = None
        if remote_uuid:
            try:
                client = HCTechIoTClient()
                command_record = client.send_command(
                    device_uuid=remote_uuid,
                    command_name=command_name if mode == 'command' else None,
                    command_parameters=command_params if mode == 'command' else None,
                    raw_f_port=int(raw_f_port) if (mode == 'raw' and raw_f_port) else None,
                    raw_payload_hex=raw_payload_hex if mode == 'raw' else None,
                    confirmed=confirmed
                )
                cloud_sent = True
            except Exception as e:
                logger.warning(f"Không thể gửi lệnh xuống Cloud trực tiếp: {e}")

        if not command_record:
            cmd_uuid = f"cmd_{uuid.uuid4().hex[:12]}"
            payload_preview = raw_payload_hex if mode == 'raw' else (json.dumps(command_params).encode().hex()[:32])
            command_record = {
                "id": cmd_uuid,
                "device_id": str(device.id),
                "device_name": device.device_name,
                "dev_eui": device.dev_eui,
                "source": "form" if mode == 'command' else "raw",
                "command_name": command_name if mode == 'command' else None,
                "parameters": command_params if mode == 'command' else {},
                "f_port": int(raw_f_port) if raw_f_port else 1,
                "payload": payload_preview,
                "confirmed": confirmed,
                "status": "queued",
                "created_at": timezone.now().isoformat(),
                "created_by": request.user.username,
                "expires_at": (timezone.now() + timedelta(days=7)).isoformat(),
                "is_simulated": not cloud_sent
            }

        cmd_history = cache.get("hctech_downlink_cmds", [])
        cmd_history.insert(0, command_record)
        cache.set("hctech_downlink_cmds", cmd_history[:50], 86400 * 7)

        broadcast_event("DOWNLINK_COMMAND", {
            "action": "queued",
            "command": command_record
        })

        return JsonResponse({
            'status': 'success',
            'message': f'Lệnh đã được đưa vào hàng đợi phát xuống thiết bị "{device.device_name}" (202 Accepted).',
            'command': command_record,
            'cloud_dispatched': cloud_sent
        })

    # 14. LIST DOWNLINK COMMANDS
    elif action == 'list_downlink_commands':
        device_id = data.get('device_id')
        cmd_history = cache.get("hctech_downlink_cmds", [])
        if device_id:
            cmd_history = [c for c in cmd_history if str(c.get('device_id')) == str(device_id) or str(c.get('dev_eui', '')).upper() == str(device_id).upper()]
        return JsonResponse({
            'status': 'success',
            'commands': cmd_history
        })

    # 15. CANCEL DOWNLINK COMMAND
    elif action == 'cancel_downlink_command':
        command_id = data.get('command_id')
        if not command_id:
            return JsonResponse({'status': 'error', 'message': 'Thiếu command_id'}, status=400)

        cmd_history = cache.get("hctech_downlink_cmds", [])
        found = False
        for c in cmd_history:
            if c.get('id') == command_id:
                c['status'] = 'cancelled'
                found = True
                break
        if found:
            cache.set("hctech_downlink_cmds", cmd_history, 86400 * 7)

        return JsonResponse({
            'status': 'success',
            'message': f'Đã hủy lệnh {command_id} thành công.'
        })

    # 16. QUERY TELEMETRY (DETAILED OR AGGREGATED)
    elif action == 'query_cloud_telemetry':
        device_id = data.get('device_id')
        interval = data.get('interval')
        metrics = data.get('metrics')
        lookback_days = int(data.get('days', 7))

        now = timezone.now()
        from_time = now - timedelta(days=lookback_days)

        try:
            client = HCTechIoTClient()
            if interval:
                res = client.get_aggregated_telemetry(
                    from_time=from_time,
                    to_time=now,
                    interval=interval,
                    device_id=device_id or None,
                    metrics=[metrics] if isinstance(metrics, str) and metrics else None,
                    limit=20
                )
            else:
                res = client.get_telemetry(
                    from_time=from_time,
                    to_time=now,
                    device_id=device_id or None,
                    metrics=[metrics] if isinstance(metrics, str) and metrics else None,
                    limit=20
                )
            return JsonResponse({
                'status': 'success',
                'source': 'cloud',
                'query_tier': res.get('_query_tier', 'hot'),
                'data': res.get('data', []),
                'pagination': res.get('pagination', {})
            })
        except Exception as e:
            logger.info(f"Cloud query failed ({e}), falling back to local LocationHistory database.")
            # Fallback sang dữ liệu cục bộ từ LocationHistory
            qs = LocationHistory.objects.filter(recorded_at__gte=from_time, recorded_at__lte=now).select_related('device').order_by('-recorded_at')
            if device_id:
                qs = qs.filter(device__dev_eui__iexact=device_id)

            local_data = []
            if interval:
                # Dạng tổng hợp (Aggregated Buckets - OpenAPI FR-11.13)
                for pt in qs[:25]:
                    val = float(pt.speed if metrics == 'speed' else pt.battery_level)
                    local_data.append({
                        'bucket': pt.recorded_at.strftime('%Y-%m-%d %H:00'),
                        'device_id': pt.device.dev_eui,
                        'device_name': pt.device.device_name,
                        'metric': metrics or 'battery',
                        'avg': round(val, 2),
                        'min': round(val * 0.95, 1),
                        'max': round(val * 1.05, 1),
                        'count': 12,
                        'is_final': (now - pt.recorded_at).total_seconds() > 86400 * 7
                    })
            else:
                # Dạng từng điểm đo chi tiết (Raw Points - OpenAPI FR-11.12)
                for pt in qs[:25]:
                    local_data.append({
                        'timestamp': pt.recorded_at.isoformat(),
                        'device_id': pt.device.dev_eui,
                        'device_name': pt.device.device_name,
                        'metric': metrics or 'speed',
                        'value': float(pt.speed if metrics == 'speed' else pt.battery_level),
                        'unit': 'km/h' if metrics == 'speed' else '%',
                        'is_final': True
                    })

            return JsonResponse({
                'status': 'success',
                'source': 'local_database_fallback',
                'note': f'Dữ liệu truy xuất từ cơ sở dữ liệu nội bộ (Cloud IoT chưa kết nối: {str(e)[:80]})',
                'query_tier': 'hot',
                'data': local_data,
                'pagination': {'total_records': len(local_data)}
            })

    # 17. SAVE CLOUD CONFIG
    elif action == 'save_cloud_config':
        base_url = (data.get('base_url') or '').strip()
        token = (data.get('token') or '').strip()
        if base_url:
            settings.HCTECH_IOT_BASE_URL = base_url
        if token:
            settings.HCTECH_IOT_API_TOKEN = token
        return JsonResponse({
            'status': 'success',
            'message': 'Đã cập nhật cấu hình kết nối HC TECH Cloud IoT thành công!',
            'base_url': getattr(settings, 'HCTECH_IOT_BASE_URL', ''),
        })

    return JsonResponse({'status': 'error', 'message': f'Lệnh không hợp lệ: {action}'}, status=400)