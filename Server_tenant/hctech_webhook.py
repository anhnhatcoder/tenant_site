import json
import logging
from datetime import timedelta
from decimal import Decimal
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


def is_truthy_sos(val) -> bool:
    """
    Xác định chính xác tín hiệu kích hoạt SOS từ các cảm biến/nút nhấn:
    - Nhận diện các trạng thái nhấn: True, 1, 'press', 'short_press', 'long_press', 'double_press', 'sos', 'alarm', 'emergency', 'trigger'
    - Bỏ qua các trạng thái không phải báo động: False, 0, 'normal', 'idle', 'none', 'released', 'off', 'standby'
    """
    if val is None or val is False:
        return False
    if val is True:
        return True
    if isinstance(val, (int, float)):
        return val > 0
    if isinstance(val, str):
        normalized = val.strip().lower()
        if normalized in ("true", "1", "yes", "press", "short_press", "long_press", "double_press", "sos", "alarm", "emergency", "trigger"):
            return True
        if normalized in ("false", "0", "no", "normal", "idle", "none", "released", "off", "standby"):
            return False
    return bool(val)


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
        for flat_key in ("latitude", "longitude", "battery", "battery_level", "battery_value", "speed", "is_sos", "sos", "button_event", "alarm"):
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
        if cls.is_duplicate_event(event_id):
            logger.info(f"[HCTech Webhook] Bỏ qua gói tin trùng lặp event_id={event_id} (FR-11.23)")
            return {"status": "ignored_duplicate", "event_id": event_id}

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

        # Bóc tách các thông số đo đạc
        metrics = cls.extract_metrics_dict(payload)

        raw_lat = metrics.get("latitude") if "latitude" in metrics else metrics.get("lat")
        raw_lng = metrics.get("longitude") if "longitude" in metrics else (metrics.get("lng") if "lng" in metrics else metrics.get("lon"))
        lat_dec = safe_decimal(raw_lat)
        lng_dec = safe_decimal(raw_lng)
        battery = metrics.get("battery") or metrics.get("battery_level") or metrics.get("battery_value")
        speed = metrics.get("speed", 0.0)

        # Xác định tín hiệu bấm nút khẩn cấp SOS một cách chính xác
        button_event = metrics.get("button_event")
        button_status = button_event.get("status") if isinstance(button_event, dict) else button_event
        is_sos = (
            is_truthy_sos(button_status)
            or is_truthy_sos(metrics.get("is_sos"))
            or is_truthy_sos(metrics.get("sos"))
            or is_truthy_sos(metrics.get("alarm"))
            or str(payload.get("event_type", "")).strip().lower() == "sos"
        )

        # Tự động gán nhóm / khu vực nếu payload cung cấp thông tin nhóm
        group_id = device_info.get("group_id") or payload.get("group_id")
        group_name = device_info.get("group_name") or payload.get("group_name")
        area_obj = None
        if group_id:
            area_obj, _ = Area.objects.get_or_create(
                code=str(group_id)[:50],
                defaults={"name": group_name or f"Nhóm {str(group_id)[:8]}"}
            )

        # Tìm hoặc tạo mới thiết bị trong Database
        device = Device.objects.filter(dev_eui__iexact=dev_eui_key).first()
        if not device:
            device = Device.objects.create(
                dev_eui=dev_eui_key,
                device_name=device_info.get("name") or device_info.get("deviceName") or payload.get("device_name") or f"Thiết bị {dev_eui_key[-6:]}",
                area=area_obj,
                customer_name=payload.get("customer_name", "Đơn vị vận hành HC TECH IoT"),
                emergency_phone=payload.get("emergency_phone", "0905111222"),
                category_type=Device.CategoryType.CAP_CUU_Y_TE,
                has_gps=bool(lat_dec is not None and lng_dec is not None),
                latitude=lat_dec if lat_dec is not None else Decimal("16.05440700"),
                longitude=lng_dec if lng_dec is not None else Decimal("108.20216700"),
                connection_status=Device.ConnectionStatus.ONLINE,
                last_seen=reported_at,
            )
        elif area_obj and not device.area:
            device.area = area_obj

        # Đảm bảo gói tin cũ đến muộn (do Webhook không bảo đảm thứ tự - FR-11.22) không ghi đè tọa độ mới hơn
        is_newer_packet = (device.last_seen is None) or (reported_at >= device.last_seen)

        if is_newer_packet:
            device.last_seen = reported_at
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

        created_alert = None
        if is_sos:
            uplink_notes = (payload.get("notes") or metrics.get("notes") or "").strip()
            if radio_quality_str and not uplink_notes:
                uplink_notes = f"Tín hiệu vô tuyến: {radio_quality_str}"

            custom_type = payload.get("alert_type")
            if custom_type and custom_type in AlertLog.AlertType.values:
                final_alert_type = custom_type
            else:
                final_alert_type = AlertLog.AlertType.CUU_HO_BIEN if device.has_gps else AlertLog.AlertType.CAP_CUU_Y_TE

            device.connection_status = Device.ConnectionStatus.SOS

            # Chống tạo trùng lặp AlertLog nếu thiết bị đã có cảnh báo đang mở trong 5 phút qua
            existing_alert = AlertLog.objects.filter(
                device=device,
                status__in=[AlertLog.AlertStatus.NEW, AlertLog.AlertStatus.PROCESSING],
                created_at__gte=timezone.now() - timedelta(minutes=5)
            ).order_by('-created_at').first()

            if existing_alert:
                created_alert = existing_alert
                if uplink_notes and not existing_alert.notes:
                    existing_alert.notes = uplink_notes
                    existing_alert.save()
            else:
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
        elif is_newer_packet and device.connection_status == Device.ConnectionStatus.OFFLINE:
            device.connection_status = Device.ConnectionStatus.ONLINE

        device.save()

        # Lưu lịch sử tọa độ GPS phục vụ tính năng Replay hành trình
        if device.has_gps and lat_dec is not None and lng_dec is not None:
            lh = LocationHistory.objects.create(
                device=device,
                latitude=lat_dec,
                longitude=lng_dec,
                speed=float(speed or 0.0),
                battery_level=device.battery_level,
                is_sos_point=is_sos,
            )
            LocationHistory.objects.filter(id=lh.id).update(recorded_at=reported_at)

        # Phát sự kiện thời gian thực qua SSE tới giao diện Dashboard (0ms delay)
        if trigger_sse:
            broadcast_event("IOT_UPLINK", {
                "schema_version": schema_version,
                "event_id": event_id,
                "device_id": device.id,
                "dev_eui": device.dev_eui,
                "device_name": device.device_name,
                "connection_status": device.connection_status,
                "is_sos": is_sos,
                "battery_level": device.battery_level,
                "latitude": float(device.latitude) if device.latitude else None,
                "longitude": float(device.longitude) if device.longitude else None,
                "speed": float(speed or 0.0),
                "alert_id": created_alert.id if created_alert else None,
                "alert_type": created_alert.get_alert_type_display() if created_alert else None,
                "notes": created_alert.notes if created_alert else "",
                "decode_status": decode_status,
                "decode_reason": decode_reason,
                "link_quality": radio_quality_str,
                "reported_at": reported_at.isoformat(),
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
    """
    if request.method != "POST":
        return JsonResponse({"error": "Method not allowed. Chỉ nhận POST theo OpenAPI."}, status=405)

    try:
        body = json.loads(request.body)
    except Exception:
        return JsonResponse({"error": "Invalid JSON body"}, status=400)

    events = body if isinstance(body, list) else (body.get("data") if isinstance(body.get("data"), list) else [body])
    results = []

    for ev in events:
        try:
            res = HCTechWebhookHandler.process_telemetry_record(ev, trigger_sse=True)
            results.append(res)
        except Exception as exc:
            logger.exception(f"[HCTech Webhook] Lỗi khi xử lý bản ghi: {exc}")
            results.append({"status": "error", "message": str(exc)})

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