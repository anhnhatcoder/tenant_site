import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests

BASE_URL = "http://localhost:5000"
WEBHOOK_URL = f"{BASE_URL}/api/webhook/uplink/"
SECRET_FILE = Path(__file__).resolve().parent / "webhook_secret.json"

def get_token():
    if SECRET_FILE.exists():
        with open(SECRET_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("token", "")
    return "hctech_sec_9e4a81bf6217c05d762e8316a3c9b740e51240a581e649d2"

def make_lw006_payload(lat, lng, bat, reported_iso):
    return {
        "device": {
            "id": "c819c6d0-59a5-4862-8418-efc3adbc07d9",
            "name": "lw006",
            "group_id": "07450fa0-8f1b-47ed-8223-9f6f69d9b25c",
            "group_name": "GPS "
        },
        "package": {
            "id": "01a0e8f6-a599-70fd-a7c9-3c78f86c667f",
            "version": "1.1.0"
        },
        "event_id": f"cs:{uuid.uuid4()}",
        "link_info": {
            "snr": 14.8,
            "rssi": -83,
            "data_rate": 5,
            "quality_level": "very_good"
        },
        "tenant_id": "ee3d1244-be03-41c8-9df1-076d619ec292",
        "received_at": reported_iso,
        "reported_at": reported_iso,
        "measurements": [
            {"name": "battery_level", "unit": "%", "value": bat},
            {"name": "charging_status", "unit": None, "value": "no charging"},
            {"name": "device_mode", "unit": None, "value": "Periodic Mode"},
            {"name": "device_status", "unit": None, "value": "No"},
            {"name": "latitude", "unit": "deg", "value": lat},
            {"name": "longitude", "unit": "deg", "value": lng},
            {"name": "pdop", "unit": "1", "value": 9.6},
            {"name": "fix_age", "unit": "s", "value": 153},
            {"name": "position_trigger", "unit": None, "value": "Working Mode"},
            {"name": "payload_type", "unit": None, "value": "L76 Pos Success"}
        ],
        "decode_reason": None,
        "decode_status": "ok",
        "schema_version": "1.0"
    }

def make_btn002_heartbeat_payload(reported_iso):
    return {
        "device": {
            "id": "01a13343-9244-7461-91c0-3abaa04f4b5a",
            "name": "Nút nhấn mokosmart 002",
            "group_id": "f16d97b3-d627-4ef6-afed-7a20646cc8bc",
            "group_name": "Nút nhấn"
        },
        "package": {
            "id": "01a0e8f6-a46e-7159-8ba7-9bc006db3040",
            "version": "1.1.0"
        },
        "event_id": f"cs:{uuid.uuid4()}",
        "link_info": {
            "snr": 14,
            "rssi": -33,
            "data_rate": 2,
            "quality_level": "very_good"
        },
        "tenant_id": "ee3d1244-be03-41c8-9df1-076d619ec292",
        "received_at": reported_iso,
        "reported_at": reported_iso,
        "measurements": [
            {"name": "temperature", "unit": "Cel", "value": 29},
            {"name": "battery_voltage", "unit": "V", "value": 3.546},
            {"name": "event_type", "unit": None, "value": "no event triggered"}
        ],
        "decode_reason": None,
        "decode_status": "ok",
        "schema_version": "1.0"
    }

def simulate_route_replay():
    headers = {
        "Authorization": f"Bearer {get_token()}",
        "Content-Type": "application/json"
    }
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(minutes=25)
    start_iso = start_time.isoformat().replace("+00:00", "Z")

    # Bước 1: Đảm bảo 2 thiết bị đã tồn tại và lấy ID trong DB
    r1 = requests.post(WEBHOOK_URL, headers=headers, json=make_lw006_payload(10.8418266, 106.7154116, 100, start_iso)).json()
    r2 = requests.post(WEBHOOK_URL, headers=headers, json=make_btn002_heartbeat_payload(start_iso)).json()
    lw006_db_id = r1["results"][0]["device_id"]
    btn002_db_id = r2["results"][0]["device_id"]

    # Bước 2: Gán 'Nút nhấn mokosmart 002' vào GPS 'lw006'
    print(f"[*] Liên kết 'Nút nhấn mokosmart 002' (ID={btn002_db_id}) vào GPS 'lw006' (ID={lw006_db_id})...")
    requests.post(
        f"{BASE_URL}/api/devices/{btn002_db_id}/pair/",
        json={"parent_device_id": lw006_db_id, "group_name": "Nhóm GPS lw006", "sync_info": False},
        timeout=10
    )

    # Bước 3: Bơm lộ trình 6 điểm quanh tọa độ mẫu 10.8418266, 106.7154116
    waypoints = [
        (5,  10.8418266, 106.7154116, 100, False, "Điểm xuất phát (Tọa độ gốc Mẫu 1)"),
        (10, 10.8431000, 106.7138000, 99,  True,  "Điểm 2 + Nút nhấn gửi Heartbeat"),
        (15, 10.8449000, 106.7115000, 98,  False, "Điểm 3 di chuyển dọc sông Sài Gòn"),
        (20, 10.8465000, 106.7098000, 97,  True,  "Điểm 4 + Nút nhấn gửi Heartbeat"),
        (23, 10.8482000, 106.7112000, 96,  False, "Điểm 5 rẽ hướng Đông Bắc"),
        (25, 10.8495000, 106.7135000, 95,  True,  "Điểm kết thúc hiện tại + Nút nhấn gửi Heartbeat")
    ]

    print("[*] Đang gửi dữ liệu hành trình Replay cho lw006...")
    for idx, (offset_min, lat, lng, bat, send_btn_hb, desc) in enumerate(waypoints, start=1):
        pt_time = datetime.now(timezone.utc) if idx == len(waypoints) else (start_time + timedelta(minutes=offset_min))
        pt_iso = pt_time.isoformat().replace("+00:00", "Z")

        # Gửi tọa độ của lw006
        requests.post(WEBHOOK_URL, headers=headers, json=make_lw006_payload(lat, lng, bat, pt_iso), timeout=10)

        # Nếu tại điểm này có nút nhấn báo Heartbeat bình thường
        if send_btn_hb:
            requests.post(WEBHOOK_URL, headers=headers, json=make_btn002_heartbeat_payload(pt_iso), timeout=10)

        print(f"   [Điểm {idx}/6] ({lat}, {lng}) -> {desc}")
        time.sleep(0.5)

    print("\n[✅ HOÀN TẤT] Đã tạo lộ trình Replay cho 'lw006' và 'Nút nhấn mokosmart 002' mà không gây báo động SOS!")

if __name__ == "__main__":
    simulate_route_replay()