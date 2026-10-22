import json
import logging
import secrets
import time
import uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from typing import Optional, Dict, Any, List

import requests
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .models import Device, Area, AlertLog, LocationHistory
from .sse import broadcast_event
from .hctech_client import HCTechIoTClient, HCTechAPIError, VN_TZ

logger = logging.getLogger(__name__)

WEBHOOK_SECRET_FILENAME = "webhook_secret.json"

# ==============================================================================
# HÀNG ĐỢI NHẬT KÝ WEBHOOK MONITOR THỜI GIAN THỰC (RING BUFFER LƯU TRÊN RAM)
# ==============================================================================
_WEBHOOK_MONITOR_LOGS: List[Dict[str, Any]] = []
_MAX_MONITOR_LOGS = 100


def add_webhook_monitor_log(entry: Dict[str, Any]):
    """Thêm 1 gói tin vào hàng đợi monitor và giữ tối đa _MAX_MONITOR_LOGS phần tử mới nhất."""
    global _WEBHOOK_MONITOR_LOGS
    _WEBHOOK_MONITOR_LOGS.insert(0, entry)
    if len(_WEBHOOK_MONITOR_LOGS) > _MAX_MONITOR_LOGS:
        _WEBHOOK_MONITOR_LOGS = _WEBHOOK_MONITOR_LOGS[:_MAX_MONITOR_LOGS]


def get_webhook_monitor_logs() -> List[Dict[str, Any]]:
    """Lấy danh sách các gói tin gần nhất đã tiếp nhận."""
    return list(_WEBHOOK_MONITOR_LOGS)


def clear_webhook_monitor_logs():
    """Xóa sạch hàng đợi log gói tin webhook."""
    global _WEBHOOK_MONITOR_LOGS
    _WEBHOOK_MONITOR_LOGS.clear()


def get_webhook_secret_file_path() -> Path:
    """Đường dẫn tệp cấu hình lưu trữ Authorization Bearer Token trên ổ đĩa."""
    base_dir = getattr(settings, "BASE_DIR", None)
    if base_dir:
        return Path(base_dir) / WEBHOOK_SECRET_FILENAME
    return Path(__file__).resolve().parent.parent / WEBHOOK_SECRET_FILENAME


def get_webhook_token(auto_generate_if_empty: bool = True) -> str:
    """
    Lấy Authorization Bearer Token hiện hành của Webhook:
    1. Ưu tiên đọc từ tệp cấu hình JSON bền vững (webhook_secret.json).
    2. Fallback sang biến môi trường hoặc settings.HCTECH_WEBHOOK_SECRET.
    3. Nếu chưa tồn tại và auto_generate_if_empty=True -> Tự động sinh token mặc định và lưu lại.
    """
    secret_file = get_webhook_secret_file_path()
    if secret_file.exists():
        try:
            with open(secret_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                token = str(data.get("token", "")).strip()
                if token:
                    return token
        except Exception as e:
            logger.warning(f"[HCTech Webhook] Lỗi khi đọc {WEBHOOK_SECRET_FILENAME}: {e}")

    env_token = str(getattr(settings, "HCTECH_WEBHOOK_SECRET", "") or "").strip()
    if env_token:
        return env_token

    if auto_generate_if_empty:
        return generate_new_webhook_token()

    return ""


def save_webhook_token(token: str) -> bool:
    """Lưu vĩnh viễn Bearer Token vào tệp JSON bền vững."""
    token = str(token).strip()
    if not token:
        return False
    secret_file = get_webhook_secret_file_path()
    try:
        data = {
            "token": token,
            "updated_at": timezone.now().isoformat()
        }
        with open(secret_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        logger.info(f"[HCTech Webhook] Đã lưu Authorization Bearer Token mới vào {secret_file.name}")
        return True
    except Exception as e:
        logger.error(f"[HCTech Webhook] Không thể ghi file {secret_file}: {e}")
        return False


def generate_new_webhook_token() -> str:
    """Sinh chuỗi Bearer Token ngẫu nhiên có độ bảo mật cao và lưu vào hệ thống."""
    raw_secret = secrets.token_hex(24)
    new_token = f"hctech_sec_{raw_secret}"
    save_webhook_token(new_token)
    return new_token


def safe_decimal(val, default=None):
    """Chuyển đổi an toàn sang Decimal, tránh crash khi nhận chuỗi rỗng hoặc giá trị không hợp lệ."""
    if val is None:
        return default
    try:
        s = str(val).strip()
        if not s or s.lower() in ("none", "null", "nan", "undefined"):
            return default
        return Decimal(s)
    except Exception:
        return default


def is_truthy_sos(val, key_name="") -> bool:
    """
    Xác định chính xác tín hiệu kích hoạt SOS từ các cảm biến / nút nhấn:
    (MokoSmart LW006/LW001/LW004/LW013/002, Milesight WS101, Dragino, Netvox, HC TECH)
    - Tránh bắt nhầm các cờ chế độ (work_mode=1, report_type=1, device_status=1) của LW006 làm SOS giả.
    """
    if val is None or val is False:
        return False
    if val is True:
        return True

    k_lower = str(key_name).lower() if key_name else ""

    if isinstance(val, (int, float)):
        if val <= 0:
            return False
        # Chỉ coi số > 0 là SOS nếu key_name là trường cảnh báo khẩn cấp (sos, alarm, alert, is_sos)
        return any(w in k_lower for w in ("sos", "alarm", "alert", "panic", "emergency"))

    if isinstance(val, dict):
        return any(is_truthy_sos(v, key_name=k) for k, v in val.items())
    if isinstance(val, (list, tuple)):
        return any(is_truthy_sos(v, key_name=key_name) for v in val)

    if isinstance(val, str):
        normalized = val.strip().lower().replace('-', ' ').replace('_', ' ')
        if not normalized:
            return False

        # Bỏ qua các trạng thái bình thường hoặc heartbeat:
        if normalized.startswith(("no ", "not ", "none ", "non ")) or normalized in (
            "no", "none", "zero", "idle", "normal", "standby", "regular", "periodic",
            "heartbeat", "keepalive", "telemetry", "ok", "ready", "off", "false", "0"
        ):
            return False

        if any(neg in normalized for neg in (
            "no event", "no trigger", "no alarm", "not trigger", "not pressed",
            "exit", "heartbeat", "keepalive", "alarm off",
            "alarm stop", "cancel", "released", "normal", "standby", "unpressed"
        )):
            return False

        sos_explicit_patterns = (
            "event 1 trigger", "event1 trigger", "event 2 trigger", "event2 trigger", "event trigger",
            "sos", "emergency", "panic", "fall down", "man down", "distress", "help"
        )
        if any(kw in normalized for kw in sos_explicit_patterns):
            return True

        if any(kw in normalized for kw in (
            "short press", "long press", "double press", "single press", "button press", "key press", "double click"
        )):
            return True

        if normalized in ("press", "pressed", "click", "alarm", "true"):
            return True

        if normalized in ("1", "yes") and any(w in k_lower for w in ("sos", "alarm", "alert", "panic", "emergency")):
            return True

    return False


def extract_heartbeat_interval(payload: Dict[str, Any], metrics: Dict[str, Any]) -> Optional[int]:
    """
    Trích xuất chu kỳ uplink / heartbeat (giây) từ payload của IoT Platform:
    Hỗ trợ cả JSON phẳng, measurements (HC TECH OutboundRecord), object (ChirpStack v4), attributes.
    Ví dụ:
    - {"heartbeat_interval": 60}
    - {"uplink_interval": 300}
    - {"interval": "120"}
    - {"period": "5m"} -> 300
    - {"measurements": [{"name": "uplink_interval", "value": 60}]}
    """
    candidate_keys = (
        "heartbeat_interval", "heartbeatInterval", "uplink_interval", "uplinkInterval",
        "heartbeat", "interval", "period", "uplink_period", "uplinkPeriod",
        "heartbeat_seconds", "heartbeatSeconds", "uplink_seconds", "uplinkSeconds",
        "heartbeat_time", "heartbeatTime", "uplink_time", "uplinkTime",
        "report_interval", "reportInterval", "reporting_interval",
        "thoi_gian_uplink", "chu_ky_uplink", "thoi_gian_heartbeat",
        "heart_beat_interval", "uplink_cycle"
    )
    val = None
    if isinstance(metrics, dict):
        for k in candidate_keys:
            if k in metrics and metrics[k] is not None:
                val = metrics[k]
                break
    if val is None and isinstance(payload, dict):
        for k in candidate_keys:
            if k in payload and payload[k] is not None:
                val = payload[k]
                break

    if val is not None:
        try:
            s_val = str(val).strip().lower()
            if s_val.endswith('m') and not s_val.endswith('ms'):
                return max(1, int(float(s_val[:-1]) * 60))
            if s_val.endswith('h'):
                return max(1, int(float(s_val[:-1]) * 3600))
            if s_val.endswith('s'):
                s_val = s_val[:-1].strip()
            num = float(s_val)
            if num > 0:
                return max(1, int(num))
        except (ValueError, TypeError):
            pass
    return None


def _broadcast_device_status_update(device: Device):
    """Phát sự kiện SSE IOT_UPLINK khi trạng thái kết nối của thiết bị thay đổi theo heartbeat."""
    local_last_seen = timezone.localtime(device.last_seen) if device.last_seen else None
    broadcast_event("IOT_UPLINK", {
        "device_id": device.id,
        "dev_eui": device.dev_eui,
        "device_name": device.device_name,
        "device_type": device.device_type,
        "device_type_display": device.get_device_type_display(),
        "category_type": device.category_type,
        "category_type_display": device.get_category_type_display() if device.category_type else "Cấp Cứu/Y tế",
        "customer_name": device.customer_name or "",
        "emergency_phone": device.emergency_phone or "",
        "is_pending_assignment": not bool(device.customer_name and device.customer_name.strip()),
        "parent_device_id": device.parent_device.id if device.parent_device else None,
        "parent_device_name": device.parent_device.device_name if device.parent_device else None,
        "group_name": device.group_name or "",
        "address": device.address or "",
        "has_gps": device.has_gps,
        "connection_status": device.connection_status,
        "connection_status_display": device.get_connection_status_display(),
        "is_sos": (device.connection_status == Device.ConnectionStatus.SOS),
        "battery_level": device.battery_level,
        "latitude": float(device.latitude) if device.latitude else None,
        "longitude": float(device.longitude) if device.longitude else None,
        "heartbeat_interval": device.heartbeat_interval or 300,
        "last_seen": local_last_seen.strftime('%d/%m/%Y %H:%M:%S') if local_last_seen else "Chưa kết nối",
        "reported_at": local_last_seen.strftime('%H:%M:%S %d/%m/%Y') if local_last_seen else "",
        "device_updated": True
    })


def get_device_offline_timeout(interval: int) -> int:
    """
    Tính thời gian chờ ngầm trước khi xác định thiết bị Mất kết nối (OFFLINE):
    - Thiết bị gửi liên tục (chu kỳ ngắn <= 120 giây, ví dụ nút nhấn 60s, gateway 10s):
      Server ngầm đợi thêm x3 thời gian (ví dụ 60s -> đợi 180s) để bù độ trễ mạng hoặc gói tin LoRaWAN đến trễ.
    - Thiết bị lâu lâu gửi (chu kỳ dài > 120 giây, ví dụ GPS Tracker 300s, 600s, 1800s):
      Server ngầm đợi thêm x2 thời gian (ví dụ 600s -> đợi 1200s, 1800s -> đợi 3600s).
    """
    safe_interval = max(1, int(interval)) if interval else 60
    if safe_interval <= 120:
        return safe_interval * 3
    return safe_interval * 2


def evaluate_device_connection_statuses(now=None, broadcast=True) -> Dict[str, Any]:
    """
    Kiểm tra và cập nhật trạng thái hoạt động (ONLINE / OFFLINE) của các thiết bị
    dựa vào thời gian nhận phản hồi cuối (last_seen) so với thời gian chờ ngầm (timeout):
    - Thiết bị gửi liên tục (chu kỳ <= 120s): ngầm đợi x3 chu kỳ (ví dụ 60s -> đợi 180s).
    - Thiết bị lâu lâu gửi (chu kỳ > 120s): ngầm đợi x2 chu kỳ (ví dụ 600s -> đợi 1200s).
    
    Quy tắc:
    - Bỏ qua thiết bị đang ở trạng thái khẩn cấp (SOS, PROCESSING) hoặc bảo trì (MAINTENANCE).
    - Thiết bị không có last_seen hoặc (now - last_seen).total_seconds() > timeout_seconds:
      -> Chuyển thành OFFLINE.
    - Thiết bị có last_seen và (now - last_seen).total_seconds() <= timeout_seconds:
      -> Khôi phục thành ONLINE.
    - Tự động phát SSE IOT_UPLINK nếu có thay đổi trạng thái.
    """
    if now is None:
        now = timezone.now()

    devices = list(Device.objects.filter(is_active=True).exclude(
        connection_status__in=[
            Device.ConnectionStatus.SOS,
            Device.ConnectionStatus.PROCESSING,
            Device.ConnectionStatus.MAINTENANCE
        ]
    ).select_related('parent_device'))

    turned_offline = []
    turned_online = []

    for d in devices:
        interval = d.heartbeat_interval if (d.heartbeat_interval and d.heartbeat_interval > 0) else 60
        timeout_seconds = get_device_offline_timeout(interval)
        is_timed_out = (d.last_seen is None) or ((now - d.last_seen).total_seconds() > timeout_seconds)

        if is_timed_out and d.connection_status != Device.ConnectionStatus.OFFLINE:
            d.connection_status = Device.ConnectionStatus.OFFLINE
            turned_offline.append(d)
        elif not is_timed_out and d.connection_status != Device.ConnectionStatus.ONLINE:
            d.connection_status = Device.ConnectionStatus.ONLINE
            turned_online.append(d)

    if turned_offline:
        Device.objects.filter(id__in=[d.id for d in turned_offline]).update(connection_status=Device.ConnectionStatus.OFFLINE)
        if broadcast:
            for d in turned_offline:
                try:
                    _broadcast_device_status_update(d)
                except Exception as e:
                    logger.debug(f"[Heartbeat] Lỗi broadcast offline device {d.dev_eui}: {e}")

    if turned_online:
        Device.objects.filter(id__in=[d.id for d in turned_online]).update(connection_status=Device.ConnectionStatus.ONLINE)
        if broadcast:
            for d in turned_online:
                try:
                    _broadcast_device_status_update(d)
                except Exception as e:
                    logger.debug(f"[Heartbeat] Lỗi broadcast online device {d.dev_eui}: {e}")

    return {
        "checked_count": len(devices),
        "turned_offline": len(turned_offline),
        "turned_online": len(turned_online),
    }


class HCTechWebhookHandler:
    """
    Quản lý luồng nhận dữ liệu từ Webhook HC TECH IoT Platform (v1.2.0) và đồng bộ vào Django:
    Tuân thủ nghiêm ngặt 3 nguyên tắc Webhook trong openapi.yaml:
    1. Số lần giao: Ít nhất một lần (At-least-once — FR-11.21).
    2. Thứ tự: Không bảo đảm (Out-of-order — FR-11.22): Sắp xếp theo 'reported_at', gói tin cũ đến sau không ghi đè tọa độ mới.
    3. Trùng lặp: Lọc trùng bằng 'event_id' lưu cache 24h (FR-11.23).
    4. Tuân thủ OutboundRecord schema (FR-11.15): measurements, link_info, package, decode_status, decode_reason, attributes.
    5. Phát tín hiệu thời gian thực SSE broadcast_event("IOT_UPLINK", ...) tới Dashboard.
    """
    EVENT_CACHE_TTL = 86400  # Lưu event_id trong 24 giờ để lọc trùng (FR-11.23)

    @classmethod
    def is_duplicate_event(cls, event_id: Optional[str]) -> bool:
        """Kiểm tra và đánh dấu event_id đã được xử lý hay chưa (FR-11.23)."""
        if not event_id:
            return False
        cache_key = f"hctech_webhook_evt_{event_id}"
        if cache.get(cache_key):
            return True
        cache.set(cache_key, True, timeout=cls.EVENT_CACHE_TTL)
        return False

    @staticmethod
    def extract_metrics_dict(payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Chuẩn hóa số đo từ cả 3 định dạng:
        - HC TECH 'measurements' list (openapi.yaml OutboundRecord schema)
        - ChirpStack v4 'object' dict
        - JSON phẳng
        """
        result: Dict[str, Any] = {}
        out_of_range_metrics: List[str] = []

        # 1. Định dạng chuẩn của HC TECH: "measurements": [{"name": "temperature", "value": 28.5, "unit": "Cel", "out_of_range": false}, ...]
        measurements = payload.get("measurements")
        if isinstance(measurements, list):
            for m in measurements:
                if isinstance(m, dict):
                    key = m.get("name") or m.get("metric") or m.get("key")
                    if key is not None:
                        result[key] = m.get("value")
                        if m.get("out_of_range") is True:
                            out_of_range_metrics.append(str(key))
        elif isinstance(measurements, dict):
            result.update(measurements)

        # 2. Định dạng ChirpStack v4 ("object": {...})
        decoded_obj = payload.get("object")
        if isinstance(decoded_obj, dict):
            result.update(decoded_obj)

        # 3. Các thuộc tính bổ sung từ "attributes" của HC TECH (hằng số gói hồ sơ - FR-08.14)
        attributes = payload.get("attributes")
        if isinstance(attributes, dict):
            for k, v in attributes.items():
                result.setdefault(k, v)

        # 4. Các trường phẳng ở cấp ngoài cùng
        for flat_key in (
            "latitude", "longitude", "battery", "battery_level", "battery_value", "speed",
            "is_sos", "sos", "button_event", "buttonEvent", "button_action", "buttonAction",
            "button_status", "buttonStatus", "alarm", "alarm_status", "alarmStatus",
            "alarm_type", "alarmType", "alarm_event", "alarmEvent", "report_type", "reportType",
            "event_type", "eventType", "event", "action_type", "actionType", "action",
            "device_status", "deviceStatus", "device_mode", "deviceMode", "work_mode", "workMode"
        ):
            if flat_key in payload and flat_key not in result:
                result[flat_key] = payload[flat_key]

        if out_of_range_metrics:
            result["_out_of_range"] = out_of_range_metrics

        return result

    @classmethod
    def process_telemetry_record(cls, payload: Dict[str, Any], trigger_sse: bool = True) -> Dict[str, Any]:
        """
        Xử lý 1 bản ghi dữ liệu đo (nhận từ Webhook hoặc kéo từ GET /telemetry).
        Tuân thủ schema OutboundRecord từ openapi.yaml.
        """
        event_id = payload.get("event_id") or payload.get("id")
        schema_version = payload.get("schema_version", "1.0")
        decode_status = payload.get("decode_status", "ok")
        decode_reason = payload.get("decode_reason")
        link_info = payload.get("link_info") or {}
        package_info = payload.get("package") or {}

        # Xác định mã định danh thiết bị (Ưu tiên dev_eui, fallback sang device_id UUID)
        device_info = payload.get("device") or payload.get("deviceInfo") or {}
        raw_identifier = (
            payload.get("dev_eui")
            or payload.get("devEui")
            or device_info.get("devEui")
            or device_info.get("dev_eui")
            or payload.get("device_id")
            or device_info.get("id")
            or ""
        ).strip()

        if not raw_identifier:
            raise ValueError("Bản ghi thiếu định danh thiết bị (dev_eui hoặc device.id).")

        dev_eui_key = raw_identifier.upper()

        # Phân tích thời điểm gửi dữ liệu 'reported_at' (RFC 3339 - FR-11.22, mốc chính thức)
        reported_at_str = payload.get("reported_at") or payload.get("time") or payload.get("timestamp")
        reported_at = parse_datetime(reported_at_str) if isinstance(reported_at_str, str) else None
        if not reported_at:
            reported_at = timezone.now()
        elif timezone.is_naive(reported_at):
            reported_at = timezone.make_aware(reported_at, VN_TZ)
        local_reported_at = timezone.localtime(reported_at)

        # Bóc tách các thông số đo đạc
        metrics = cls.extract_metrics_dict(payload)

        raw_lat = metrics.get("latitude") if "latitude" in metrics else metrics.get("lat")
        raw_lng = metrics.get("longitude") if "longitude" in metrics else (metrics.get("lng") if "lng" in metrics else metrics.get("lon"))
        lat_dec = safe_decimal(raw_lat)
        lng_dec = safe_decimal(raw_lng)
        battery = metrics.get("battery") or metrics.get("battery_level") or metrics.get("battery_value")
        speed = metrics.get("speed", 0.0)

        # Xác định tín hiệu bấm nút khẩn cấp SOS một cách toàn diện
        sos_candidate_keys = [
            "button_event", "buttonEvent", "button_action", "buttonAction",
            "button_status", "buttonStatus", "button", "btn_status", "btn_action",
            "press_type", "pressType", "click_type", "clickType",
            "is_sos", "sos", "sos_status", "sosStatus",
            "alarm", "alarm_status", "alarmStatus", "alarm_event", "alarmEvent",
            "alarm_type", "alarmType", "alert_type", "alertType",
            "event_type", "eventType"
        ]

        is_sos = False
        # 1. Kiểm tra trong metrics
        for k in sos_candidate_keys:
            if k in metrics and is_truthy_sos(metrics[k], key_name=k):
                is_sos = True
                break

        # 2. Kiểm tra trực tiếp trong payload
        if not is_sos:
            for k in sos_candidate_keys:
                if k in payload and is_truthy_sos(payload[k], key_name=k):
                    is_sos = True
                    break

        # 3. Kiểm tra trong decoded object (ChirpStack v4)
        if not is_sos and isinstance(payload.get("object"), dict):
            for k in sos_candidate_keys:
                if k in payload["object"] and is_truthy_sos(payload["object"][k]):
                    is_sos = True
                    break

        # 4. Kiểm tra qua event string
        if not is_sos:
            raw_event = str(payload.get("event_type") or payload.get("event") or payload.get("type") or "").strip()
            if raw_event and is_truthy_sos(raw_event):
                is_sos = True

        # 5. Nếu thiết bị là nút nhấn (MokoSmart / LoRaWAN Button) và có cờ bấm phím
        device_name_check = (device_info.get("name") or payload.get("device_name") or "").lower()
        if not is_sos and any(kw in device_name_check for kw in ("nút", "button", "mokosmart", "moko", "ws101", "lw004", "lw013", "lw002", "lw006", "002", "006")):
            for k, v in metrics.items():
                if any(sub in k.lower() for sub in ("press", "click", "btn", "button", "alarm", "event")) and is_truthy_sos(v):
                    is_sos = True
                    break

        # QUAN TRỌNG: GỠ BỎ CHẶN LỌC TRÙNG KHI BÁO ĐỘNG SOS
        # Nếu là gói tin SOS khẩn cấp, KHÔNG lọc trùng để cho phép kiểm thử bấm nút liên tục!
        # Chỉ kiểm tra lọc trùng với gói tin bình thường (telemetry định kỳ):
        if not is_sos and cls.is_duplicate_event(event_id):
            logger.info(f"[HCTech Webhook] Bỏ qua gói tin thường trùng lặp event_id={event_id} (FR-11.23)")
            return {"status": "ignored_duplicate", "event_id": event_id}

        # Tự động gán nhóm / khu vực nếu payload cung cấp thông tin nhóm
        group_id = device_info.get("group_id") or payload.get("group_id")
        group_name = device_info.get("group_name") or payload.get("group_name")
        area_obj = None
        if group_id:
            area_obj, _ = Area.objects.get_or_create(
                code=str(group_id)[:50],
                defaults={"name": group_name or f"Nhóm {str(group_id)[:8]}"}
            )

        # Nhận diện loại thiết bị phù hợp
        detected_device_type = Device.DeviceType.NUT_NHAN
        raw_dev_name = (device_info.get("name") or device_info.get("deviceName") or payload.get("device_name") or "").lower()
        if "camera" in raw_dev_name or "cam" in raw_dev_name:
            detected_device_type = Device.DeviceType.CAMERA
        elif "gateway" in raw_dev_name or "gw" in raw_dev_name:
            detected_device_type = Device.DeviceType.GATEWAY

        # Trích xuất chu kỳ heartbeat / uplink do nền tảng IoT truyền kèm trong JSON
        incoming_interval = extract_heartbeat_interval(payload, metrics)

        # Tìm hoặc tạo mới thiết bị trong Database
        device = Device.objects.filter(dev_eui__iexact=dev_eui_key).first()
        if device and not device.is_active:
            # Thiết bị trước đó bị vô hiệu hóa / ẩn -> Phục hồi hoạt động trở lại khi nhận tín hiệu mới
            device.is_active = True
            device.save(update_fields=['is_active'])
            logger.info(f"[HCTech Webhook] Tái kích hoạt thiết bị {dev_eui_key} (is_active -> True) do nhận tín hiệu mới.")

        is_new_device = False
        if not device:
            is_new_device = True
            
            # TỰ ĐỘNG TRA CỨU TỪ HC TECH IOT CLOUD API ĐỂ NẠP THÔNG TIN CHÍNH XÁC
            cloud_name = None
            cloud_hb = None
            try:
                from .hctech_client import HCTechIoTClient
                c_client = HCTechIoTClient()
                catalog_cache_key = "hctech_cloud_devices_list"
                dev_list = cache.get(catalog_cache_key)
                if dev_list is None:
                    dev_res = c_client.get_devices()
                    dev_list = dev_res.get("data", []) if isinstance(dev_res, dict) else []
                    cache.set(catalog_cache_key, dev_list, 180)

                clean_eui = dev_eui_key.strip().lower()
                for d in dev_list:
                    d_id = d.get("id")
                    if not d_id:
                        continue
                    item_cache_key = f"hctech_cloud_dev_detail_{d_id}"
                    d_detail = cache.get(item_cache_key)
                    if d_detail is None:
                        try:
                            d_detail = c_client._request("GET", f"/devices/{d_id}")
                            cache.set(item_cache_key, d_detail, 3600)
                        except Exception:
                            d_detail = {}
                    
                    d_id_str = str(d.get("id") or "").strip().lower()
                    d_eui_str = str(d_detail.get("dev_eui") or d.get("dev_eui") or "").strip().lower()
                    # Khớp theo cả Device UUID (như user chỉ định) hoặc Hardware DevEUI
                    if clean_eui in (d_id_str, d_eui_str):
                        cloud_name = d_detail.get("name") or d.get("name")
                        p_ver_id = d_detail.get("package_version_id")
                        if p_ver_id:
                            cloud_hb = c_client.get_package_version_uplink_interval(package_version_id=p_ver_id)
                        if not cloud_hb:
                            offline_th = d_detail.get("offline_threshold") or {}
                            if isinstance(offline_th, dict) and offline_th.get("seconds"):
                                th_sec = int(offline_th["seconds"])
                                cloud_hb = 60 if th_sec == 180 else th_sec
                        logger.info(f"[HCTech Webhook] Khớp thiết bị Cloud API cho {clean_eui}: name='{cloud_name}', heartbeat={cloud_hb}s")
                        break
            except Exception as api_err:
                logger.warning(f"[HCTech Webhook] Không thể tra cứu API IoT Cloud cho {dev_eui_key}: {api_err}")

            if not cloud_hb:
                pkg_data = payload.get("package") or {}
                if isinstance(pkg_data, dict) and pkg_data.get("id"):
                    try:
                        from .hctech_client import HCTechIoTClient
                        c_client = HCTechIoTClient()
                        cloud_hb = c_client.get_package_version_uplink_interval(
                            package_id=pkg_data.get("id"),
                            version=pkg_data.get("version")
                        )
                        if cloud_hb:
                            logger.info(f"[HCTech Webhook] Tra cứu uplink_interval từ package payload: {cloud_hb}s")
                    except Exception as pkg_err:
                        logger.warning(f"[HCTech Webhook] Lỗi tra cứu package uplink: {pkg_err}")

            custom_cust_name = str(payload.get("customer_name") or "").strip()
            custom_phone = str(payload.get("emergency_phone") or "").strip()
            device_display_name = (
                cloud_name
                or device_info.get("name")
                or device_info.get("deviceName")
                or payload.get("device_name")
                or f"Thiết bị mới ({dev_eui_key[-6:]})"
            )
            final_heartbeat = cloud_hb or incoming_interval or 60

            device = Device.objects.create(
                dev_eui=dev_eui_key,
                device_name=device_display_name,
                device_type=detected_device_type,
                area=area_obj,
                customer_name=custom_cust_name,
                emergency_phone=custom_phone,
                category_type=Device.CategoryType.CAP_CUU_Y_TE,
                has_gps=bool(lat_dec is not None and lng_dec is not None),
                latitude=lat_dec if lat_dec is not None else Decimal("16.05440700"),
                longitude=lng_dec if lng_dec is not None else Decimal("108.20216700"),
                heartbeat_interval=final_heartbeat,
                connection_status=Device.ConnectionStatus.SOS if is_sos else Device.ConnectionStatus.ONLINE,
                last_seen=reported_at,
            )
            logger.info(f"[HCTech Webhook] Đã phát hiện và nạp thiết bị mới {dev_eui_key} (Name='{device.device_name}', Heartbeat={device.heartbeat_interval}s) -> Chờ gán thông tin")
        else:
            if area_obj and not device.area:
                device.area = area_obj
            
            # Đồng bộ chính xác uplink_interval từ package version nếu có trong payload
            pkg_data = payload.get("package") or {}
            resolved_pkg_hb = None
            if isinstance(pkg_data, dict) and pkg_data.get("id"):
                try:
                    from .hctech_client import HCTechIoTClient
                    c_client = HCTechIoTClient()
                    resolved_pkg_hb = c_client.get_package_version_uplink_interval(
                        package_id=pkg_data.get("id"),
                        version=pkg_data.get("version")
                    )
                except Exception:
                    pass

            target_interval = resolved_pkg_hb or incoming_interval
            if target_interval and device.heartbeat_interval != target_interval:
                device.heartbeat_interval = target_interval
                device.save(update_fields=['heartbeat_interval'])
                logger.info(f"[HCTech Webhook] Đã cập nhật chu kỳ heartbeat={target_interval}s từ package cho thiết bị {device.dev_eui}")

        # Đảm bảo gói tin cũ đến muộn (do Webhook không bảo đảm thứ tự - FR-11.22) không ghi đè tọa độ mới hơn
        is_newer_packet = (device.last_seen is None) or (reported_at >= device.last_seen)

        if is_newer_packet:
            device.last_seen = reported_at
            # Nếu thiết bị trước đó đang OFFLINE và gói tin này không phải SOS thì khôi phục ONLINE
            if device.connection_status == Device.ConnectionStatus.OFFLINE and not is_sos:
                device.connection_status = Device.ConnectionStatus.ONLINE
            if lat_dec is not None and lng_dec is not None:
                device.latitude = lat_dec
                device.longitude = lng_dec
                device.has_gps = True
            if battery is not None:
                try:
                    device.battery_level = max(0, min(100, int(float(battery))))
                except (ValueError, TypeError):
                    pass

        # Ghi nhận chất lượng sóng vô tuyến (link_info - FR-13.4a)
        radio_quality_str = ""
        if isinstance(link_info, dict) and link_info:
            rssi = link_info.get("rssi")
            snr = link_info.get("snr")
            q_level = link_info.get("quality_level")
            radio_parts = []
            if rssi is not None: radio_parts.append(f"RSSI={rssi}dBm")
            if snr is not None: radio_parts.append(f"SNR={snr}dB")
            if q_level: radio_parts.append(f"Chất lượng={q_level}")
            radio_quality_str = ", ".join(radio_parts)

        paired_gps = device.parent_device if (device.parent_device and device.parent_device.has_gps) else None
        created_alert = None

        if is_sos:
            uplink_notes = (payload.get("notes") or metrics.get("notes") or "").strip()
            if uplink_notes.startswith("Tín hiệu vô tuyến"):
                uplink_notes = ""

            custom_type = payload.get("alert_type")
            if custom_type and custom_type in AlertLog.AlertType.values:
                final_alert_type = custom_type
            else:
                final_alert_type = AlertLog.AlertType.CUU_HO_BIEN if device.has_gps else AlertLog.AlertType.CAP_CUU_Y_TE

            device.connection_status = Device.ConnectionStatus.SOS

            # ==============================================================
            # CHỐNG TRÙNG BÁO ĐỘNG (Alert Deduplication / Debounce Window):
            # Trong vòng ALERT_COOLDOWN_SECONDS (mặc định 30 giây), nếu cùng một thiết bị
            # gửi nhiều gói tin SOS (do nút nhấn gửi lại chùm sóng hoặc người dùng ấn liên tục),
            # hệ thống sẽ gom vào cảnh báo hiện tại, KHÔNG tạo thêm AlertLog mới trùng lặp!
            # ==============================================================
            ALERT_COOLDOWN_SECONDS = getattr(settings, 'ALERT_COOLDOWN_SECONDS', 30)
            now_dt = timezone.now()
            recent_alert = AlertLog.objects.filter(
                device=device,
                created_at__gte=now_dt - timedelta(seconds=ALERT_COOLDOWN_SECONDS)
            ).order_by('-id').first()

            if recent_alert:
                diff_sec = (now_dt - recent_alert.created_at).total_seconds()
                logger.info(
                    f"[HCTech Webhook] 🛡️ Chống trùng báo động: Bỏ qua tạo mới AlertLog cho {device.dev_eui}. "
                    f"Đã có Alert #{recent_alert.id} tạo cách đây {diff_sec:.1f}s (< {ALERT_COOLDOWN_SECONDS}s)."
                )
                if lat_dec is not None and lng_dec is not None:
                    recent_alert.latitude = lat_dec
                    recent_alert.longitude = lng_dec
                    recent_alert.save(update_fields=['latitude', 'longitude'])
                created_alert = recent_alert
            else:
                # Tạo mới AlertLog cho nút nhấn
                created_alert = AlertLog.objects.create(
                    device=device,
                    alert_type=final_alert_type,
                    status=AlertLog.AlertStatus.NEW,
                    latitude=device.latitude,
                    longitude=device.longitude,
                    address=device.address,
                    notes=uplink_notes or None,
                    area=device.area,
                )
                logger.info(f"[HCTech Webhook] 🚨 BÁO ĐỘNG SOS TỨC THÌ cho thiết bị {device.dev_eui} - Alert #{created_alert.id}")

            # NẾU NÚT NHẤN ĐÃ GÁN CHO THIẾT BỊ GPS (VD: Tàu cá / Xe cứu hộ):
            if paired_gps:
                paired_gps.connection_status = Device.ConnectionStatus.SOS
                paired_gps.save()

                # Tạo AlertLog cho thiết bị GPS nếu chưa có cảnh báo đang mở
                if not AlertLog.objects.filter(device=paired_gps, status=AlertLog.AlertStatus.NEW).exists():
                    p_alert = AlertLog.objects.create(
                        device=paired_gps,
                        alert_type=AlertLog.AlertType.CUU_HO_BIEN,
                        status=AlertLog.AlertStatus.NEW,
                        latitude=paired_gps.latitude or device.latitude,
                        longitude=paired_gps.longitude or device.longitude,
                        address=paired_gps.address,
                        notes=f"🚨 SOS kích hoạt từ nút nhấn liên kết: {device.device_name} ({device.dev_eui})",
                        area=paired_gps.area,
                    )
                    logger.info(f"[HCTech Webhook] 🚨 Đã kích hoạt SOS cho GPS cha: {paired_gps.device_name} - Alert #{p_alert.id}")

                # Ghi nhận điểm SOS trên hành trình Replay của thiết bị GPS cha
                target_lat = paired_gps.latitude or lat_dec or device.latitude
                target_lng = paired_gps.longitude or lng_dec or device.longitude
                if target_lat is not None and target_lng is not None:
                    lh_sos = LocationHistory.objects.create(
                        device=paired_gps,
                        latitude=target_lat,
                        longitude=target_lng,
                        speed=float(speed or 0.0),
                        battery_level=paired_gps.battery_level,
                        is_sos_point=True,
                        packet_type='SOS',
                        button_device=device,
                    )
                    LocationHistory.objects.filter(id=lh_sos.id).update(recorded_at=reported_at)
                    logger.info(f"[HCTech Webhook] 📍 Đã lưu điểm SOS trên Replay của GPS {paired_gps.device_name} từ nút {device.device_name}")

                # Phát sự kiện thời gian thực cho GPS cha tới Dashboard
                broadcast_event("IOT_UPLINK", {
                    "schema_version": schema_version,
                    "event_id": f"paired_sos_{event_id}",
                    "device_id": paired_gps.id,
                    "dev_eui": paired_gps.dev_eui,
                    "device_name": paired_gps.device_name,
                    "device_type": paired_gps.device_type,
                    "device_type_display": paired_gps.get_device_type_display(),
                    "category_type": paired_gps.category_type,
                    "category_type_display": paired_gps.get_category_type_display() if paired_gps.category_type else "Cấp Cứu/Y tế",
                    "customer_name": paired_gps.customer_name,
                    "emergency_phone": paired_gps.emergency_phone,
                    "has_gps": paired_gps.has_gps,
                    "connection_status": paired_gps.connection_status,
                    "connection_status_display": paired_gps.get_connection_status_display(),
                    "is_sos": True,
                    "battery_level": paired_gps.battery_level,
                    "latitude": float(paired_gps.latitude) if paired_gps.latitude else None,
                    "longitude": float(paired_gps.longitude) if paired_gps.longitude else None,
                    "notes": f"🚨 SOS từ nút nhấn: {device.device_name}",
                    "reported_at": local_reported_at.strftime('%H:%M:%S %d/%m/%Y'),
                })

        elif is_newer_packet:
            raw_event_text = str(metrics.get("event_type") or payload.get("event_type") or metrics.get("event") or payload.get("event") or "").strip().lower()
            is_exit_event = any(kw in raw_event_text for kw in ("exit", "alarm stop", "alarm off", "cancel", "stop", "no event", "no trigger", "normal", "heartbeat"))
            if is_exit_event:
                device.connection_status = Device.ConnectionStatus.ONLINE
                now_res = timezone.now()
                AlertLog.objects.filter(device=device, status=AlertLog.AlertStatus.NEW).update(
                    status=AlertLog.AlertStatus.RESOLVED,
                    resolved_at=now_res,
                    resolution_report="Đã hủy báo động tự động qua gói tin Event 1 Exit từ thiết bị."
                )
                logger.info(f"[HCTech Webhook] Nhận tín hiệu Event 1 Exit từ thiết bị {device.dev_eui} -> Khôi phục ONLINE và đóng cảnh báo")
            elif device.connection_status == Device.ConnectionStatus.OFFLINE:
                device.connection_status = Device.ConnectionStatus.ONLINE

            # KHI NHẬN HEARTBEAT TỪ NÚT NHẤN ĐÃ GÁN VÀO GPS:
            # "còn hearbeat thì hiện nút bình thường ko sos"
            if paired_gps and not is_sos:
                target_lat = paired_gps.latitude or device.latitude
                target_lng = paired_gps.longitude or device.longitude
                if target_lat is not None and target_lng is not None:
                    lh_hb = LocationHistory.objects.create(
                        device=paired_gps,
                        latitude=target_lat,
                        longitude=target_lng,
                        speed=float(speed or 0.0),
                        battery_level=paired_gps.battery_level,
                        is_sos_point=False,
                        packet_type='HEARTBEAT',
                        button_device=device,
                    )
                    LocationHistory.objects.filter(id=lh_hb.id).update(recorded_at=reported_at)
                    logger.info(f"[HCTech Webhook] 🔘 Đã lưu điểm Heartbeat bình thường cho nút {device.device_name} trên hành trình Replay GPS {paired_gps.device_name}")

        device.save()

        # Lưu lịch sử tọa độ GPS cho chính thiết bị (nếu thiết bị có GPS và truyền tọa độ riêng)
        if device.has_gps and lat_dec is not None and lng_dec is not None and not is_sos:
            lh = LocationHistory.objects.create(
                device=device,
                latitude=lat_dec,
                longitude=lng_dec,
                speed=float(speed or 0.0),
                battery_level=device.battery_level,
                is_sos_point=False,
                packet_type='PERIODIC',
            )
            LocationHistory.objects.filter(id=lh.id).update(recorded_at=reported_at)
        elif device.has_gps and lat_dec is not None and lng_dec is not None and is_sos and not paired_gps:
            lh = LocationHistory.objects.create(
                device=device,
                latitude=lat_dec,
                longitude=lng_dec,
                speed=float(speed or 0.0),
                battery_level=device.battery_level,
                is_sos_point=True,
                packet_type='SOS',
            )
            LocationHistory.objects.filter(id=lh.id).update(recorded_at=reported_at)

        # Phát sự kiện thời gian thực qua SSE tới giao diện Dashboard (0ms delay)
        is_pending = not bool(device.customer_name and device.customer_name.strip())
        local_reported_at = timezone.localtime(reported_at)
        if trigger_sse:
            broadcast_event("IOT_UPLINK", {
                "schema_version": schema_version,
                "event_id": event_id,
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
                "parent_device_id": device.parent_device.id if device.parent_device else None,
                "parent_device_name": device.parent_device.device_name if device.parent_device else None,
                "group_name": device.group_name or "",
                "is_new_device": is_new_device,
                "address": device.address or "",
                "has_gps": device.has_gps,
                "connection_status": device.connection_status,
                "connection_status_display": device.get_connection_status_display(),
                "is_sos": is_sos,
                "battery_level": device.battery_level,
                "heartbeat_interval": device.heartbeat_interval or 300,
                "last_seen": local_reported_at.strftime('%d/%m/%Y %H:%M:%S'),
                "latitude": float(device.latitude) if device.latitude else None,
                "longitude": float(device.longitude) if device.longitude else None,
                "speed": float(speed or 0.0),
                "alert_id": created_alert.id if created_alert else None,
                "alert_type": created_alert.get_alert_type_display() if created_alert else None,
                "notes": created_alert.notes if created_alert else "",
                "decode_status": decode_status,
                "decode_reason": decode_reason,
                "link_quality": radio_quality_str,
                "reported_at": local_reported_at.strftime('%H:%M:%S %d/%m/%Y'),
                "reported_at_iso": local_reported_at.isoformat(),
            })

        return {
            "status": "ok",
            "event_id": event_id,
            "device_id": device.id,
            "dev_eui": device.dev_eui,
            "sos_triggered": is_sos,
            "decode_status": decode_status,
            "decode_reason": decode_reason,
            "reported_at": reported_at.isoformat(),
        }


def sync_hctech_catalog_and_telemetry(bearer_token: Optional[str] = None, lookback_hours: int = 24) -> Dict[str, Any]:
    """
    Hàm đồng bộ dữ liệu toàn diện từ HC TECH Public API (/groups, /devices, /devices/{id}/metrics, /telemetry)
    về các bảng Area, Device, LocationHistory và AlertLog của Django.
    """
    client = HCTechIoTClient(bearer_token=bearer_token)
    summary = {"groups_synced": 0, "devices_synced": 0, "telemetry_synced": 0}

    # 1. Đồng bộ danh mục Nhóm (/groups) -> Bảng Area
    groups = client.iter_all_groups()
    group_map: Dict[str, Area] = {}
    for g in groups:
        g_id = g.get("id") or g.get("group_id")
        g_name = g.get("name") or f"Nhóm {str(g_id)[:8]}"
        if g_id:
            area_obj, _ = Area.objects.update_or_create(
                code=str(g_id)[:50],
                defaults={
                    "name": g_name,
                    "description": f"Đồng bộ từ HC TECH Group (Loại kết nối: {g.get('type', g.get('connection_type', 'LoRaWAN'))})"
                }
            )
            group_map[str(g_id)] = area_obj
            summary["groups_synced"] += 1

    # 2. Đồng bộ danh mục Thiết bị (/devices) -> Bảng Device
    remote_devices = client.iter_all_devices()
    now = timezone.now()
    from_time = now - timedelta(hours=lookback_hours)

    for d in remote_devices:
        remote_uuid = str(d.get("id") or d.get("device_id") or "").strip()
        dev_eui = str(d.get("dev_eui") or d.get("devEui") or remote_uuid).strip().upper()
        if not dev_eui:
            continue

        remote_status = d.get("status", "active")
        is_active = (remote_status == "active")
        conn_status_raw = d.get("connection_status")
        if conn_status_raw == "online":
            conn_status = Device.ConnectionStatus.ONLINE
        elif conn_status_raw in ("never_seen", "disabled", "not_applicable"):
            conn_status = Device.ConnectionStatus.MAINTENANCE
        else:
            conn_status = Device.ConnectionStatus.OFFLINE

        # Kiểm tra danh mục đại lượng đo (/devices/{deviceId}/metrics) để tự động nhận diện GPS
        has_gps = False
        if remote_uuid:
            try:
                dev_metrics = client.get_device_metrics(remote_uuid)
                metric_names = {str(m.get("name") or m.get("metric") or "").lower() for m in dev_metrics}
                if {"latitude", "longitude", "gps", "speed"} & metric_names:
                    has_gps = True
            except (HCTechAPIError, requests.RequestException, Exception) as e:
                logger.warning(f"Không lấy được metrics cho thiết bị {remote_uuid}: {e}")

        area_obj = group_map.get(str(d.get("group_id") or ""))
        Device.objects.update_or_create(
            dev_eui=dev_eui,
            defaults={
                "device_name": d.get("name") or d.get("device_name") or f"Thiết bị {dev_eui[-6:]}",
                "area": area_obj,
                "is_active": is_active,
                "has_gps": has_gps,
                "connection_status": conn_status,
                "description": f"HC TECH UUID: {remote_uuid}",
            }
        )
        summary["devices_synced"] += 1

        # 3. Truy vấn dữ liệu đo (/telemetry) của thiết bị trong khoảng lookback_hours
        if remote_uuid and lookback_hours > 0:
            try:
                records = client.fetch_all_telemetry(
                    from_time=from_time,
                    to_time=now,
                    device_id=remote_uuid,
                )
                for rec in records:
                    rec.setdefault("dev_eui", dev_eui)
                    HCTechWebhookHandler.process_telemetry_record(rec, trigger_sse=False)
                    summary["telemetry_synced"] += 1
            except (HCTechAPIError, requests.RequestException, Exception) as e:
                logger.warning(f"Lỗi khi đồng bộ telemetry cho thiết bị {remote_uuid}: {e}")

    return summary


# ==============================================================================
# DJANGO VIEWS CHO WEBHOOK & ĐỒNG BỘ CLOUD
# ==============================================================================
@csrf_exempt
def hctech_webhook_view(request):
    """
    Endpoint nhận Webhook trực tiếp từ nền tảng HC TECH IoT hoặc ChirpStack v4.
    Đường dẫn chuẩn: POST /api/webhook/uplink/
    Yêu cầu bảo mật: Header 'Authorization: Bearer <token>' hoặc 'X-Webhook-Secret: <token>'
    Tích hợp Live Webhook Ingestion Monitor: Đưa mọi chuỗi JSON nhận được lên Monitor Admin tức thời.
    """
    raw_body_str = ""
    try:
        raw_body_str = request.body.decode("utf-8", errors="replace")
    except Exception:
        pass

    client_ip = request.META.get("HTTP_X_FORWARDED_FOR") or request.META.get("REMOTE_ADDR") or "unknown"
    if "," in client_ip:
        client_ip = client_ip.split(",")[0].strip()

    auth_header = request.headers.get("Authorization", "").strip()
    custom_header = request.headers.get("X-Webhook-Secret", "").strip()

    token = ""
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
    elif auth_header:
        token = auth_header
    elif custom_header:
        token = custom_header

    token_masked = f"{token[:6]}...{token[-4:]}" if len(token) > 10 else (token or "None")

    expected_token = get_webhook_token(auto_generate_if_empty=True)
    is_auth_ok = True
    if expected_token:
        is_auth_ok = bool(token and token == expected_token)

    parsed_json = None
    is_valid_json = False
    parse_error = None
    if raw_body_str:
        try:
            parsed_json = json.loads(raw_body_str)
            is_valid_json = True
        except Exception as e:
            parse_error = str(e)

    # Nhận diện sơ bộ thông tin gói tin để hiển thị nổi bật trên Monitor
    preview_deveui = ""
    preview_is_sos = False
    if isinstance(parsed_json, dict):
        dev_info = parsed_json.get("device") or parsed_json.get("deviceInfo") or {}
        preview_deveui = (
            parsed_json.get("dev_eui") or parsed_json.get("devEui") or
            dev_info.get("devEui") or dev_info.get("dev_eui") or
            dev_info.get("id") or parsed_json.get("device_id") or ""
        )
        for k in ("is_sos", "sos", "alarm", "button_event", "buttonAction", "press", "event_type", "event"):
            if k in parsed_json and is_truthy_sos(parsed_json[k]):
                preview_is_sos = True
                break
        if not preview_is_sos and isinstance(parsed_json.get("measurements"), list):
            for m in parsed_json["measurements"]:
                if isinstance(m, dict) and m.get("name") in ("event_type", "event", "alarm", "sos", "is_sos", "button_event", "button"):
                    if is_truthy_sos(m.get("value")):
                        preview_is_sos = True
                        break
    elif isinstance(parsed_json, list) and len(parsed_json) > 0 and isinstance(parsed_json[0], dict):
        dev_info = parsed_json[0].get("device") or parsed_json[0].get("deviceInfo") or {}
        preview_deveui = (
            parsed_json[0].get("dev_eui") or parsed_json[0].get("devEui") or
            dev_info.get("devEui") or dev_info.get("dev_eui") or
            dev_info.get("id") or parsed_json[0].get("device_id") or ""
        )
        for k in ("is_sos", "sos", "alarm", "button_event", "buttonAction", "press", "event_type", "event"):
            if k in parsed_json[0] and is_truthy_sos(parsed_json[0][k]):
                preview_is_sos = True
                break
        if not preview_is_sos and isinstance(parsed_json[0].get("measurements"), list):
            for m in parsed_json[0]["measurements"]:
                if isinstance(m, dict) and m.get("name") in ("event_type", "event", "alarm", "sos", "is_sos", "button_event", "button"):
                    if is_truthy_sos(m.get("value")):
                        preview_is_sos = True
                        break

    monitor_id = f"wh_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
    now_vn = timezone.localtime(timezone.now())

    initial_status_code = 200
    if request.method != "POST":
        initial_status_code = 405
    elif not is_auth_ok:
        initial_status_code = 401
    elif not is_valid_json:
        initial_status_code = 400

    monitor_entry = {
        "id": monitor_id,
        "timestamp": now_vn.strftime("%H:%M:%S %d/%m/%Y"),
        "time_only": now_vn.strftime("%H:%M:%S"),
        "client_ip": client_ip,
        "method": request.method,
        "content_type": request.content_type,
        "auth_status": "authorized" if is_auth_ok else "unauthorized",
        "token_masked": token_masked,
        "is_valid_json": is_valid_json,
        "raw_body": raw_body_str,
        "json_data": parsed_json,
        "dev_eui": preview_deveui,
        "is_sos": preview_is_sos,
        "status_code": initial_status_code,
        "status_message": "Đang phân tích & xử lý..." if initial_status_code == 200 else ("401 Unauthorized" if initial_status_code == 401 else ("400 Invalid JSON" if initial_status_code == 400 else "405 Method Not Allowed")),
        "processed_count": 0,
        "error_message": parse_error,
        "headers": {
            "Authorization": auth_header or None,
            "X-Webhook-Secret": custom_header or None,
            "Content-Type": request.content_type,
            "User-Agent": request.headers.get("User-Agent")
        }
    }

    # BẮT BUỘC: Đưa mọi chuỗi JSON nhận được lên Monitor Admin tức thời qua SSE
    add_webhook_monitor_log(monitor_entry)
    broadcast_event("WEBHOOK_MONITOR", monitor_entry)

    if request.method != "POST":
        return JsonResponse({"error": "Method not allowed. Chỉ nhận POST theo OpenAPI."}, status=405)

    if not is_auth_ok:
        logger.warning(f"[HCTech Webhook] 401 Unauthorized: Thiếu hoặc sai Authorization Bearer token từ {client_ip}")
        return JsonResponse({
            "status": "error",
            "error": "Unauthorized",
            "message": "Webhook yêu cầu xác thực. Vui lòng cung cấp Header 'Authorization: Bearer <token>' hợp lệ."
        }, status=401)

    if not is_valid_json:
        return JsonResponse({"error": "Invalid JSON body", "detail": parse_error}, status=400)

    events = parsed_json if isinstance(parsed_json, list) else (parsed_json.get("data") if isinstance(parsed_json.get("data"), list) else [parsed_json])
    results = []

    for ev in events:
        try:
            res = HCTechWebhookHandler.process_telemetry_record(ev, trigger_sse=True)
            results.append(res)
        except Exception as exc:
            logger.exception(f"[HCTech Webhook] Lỗi khi xử lý bản ghi: {exc}")
            results.append({"status": "error", "message": str(exc)})

    # Cập nhật kết quả lên Monitor Admin
    monitor_entry["status_code"] = 200
    monitor_entry["status_message"] = f"Xử lý thành công {len(results)} bản ghi."
    monitor_entry["processed_count"] = len(results)
    monitor_entry["results"] = results
    broadcast_event("WEBHOOK_MONITOR_UPDATE", {
        "id": monitor_id,
        "status_code": 200,
        "status_message": monitor_entry["status_message"],
        "results": results
    })

    return JsonResponse({
        "status": "ok",
        "processed": len(results),
        "results": results
    })


@csrf_exempt
def api_sync_from_hctech(request):
    """
    Endpoint cho phép Admin kích hoạt đồng bộ danh mục thiết bị & dữ liệu đo từ HC TECH Cloud.
    """
    if request.method != "POST":
        return JsonResponse({"status": "error", "message": "Method not allowed"}, status=405)

    try:
        payload = json.loads(request.body or "{}")
        token = payload.get("token") or getattr(settings, "HCTECH_IOT_API_TOKEN", "")
        lookback_hours = int(payload.get("lookback_hours", 24))
        result = sync_hctech_catalog_and_telemetry(bearer_token=token, lookback_hours=lookback_hours)
        return JsonResponse({"status": "success", "summary": result})
    except HCTechAPIError as api_err:
        return JsonResponse({
            "status": "error",
            "error_code": api_err.error_code,
            "message": api_err.message,
            "remediation": api_err.remediation,
            "details": api_err.details,
            "trace_id": api_err.trace_id,
        }, status=api_err.status_code)
    except Exception as exc:
        return JsonResponse({"status": "error", "message": str(exc)}, status=500)