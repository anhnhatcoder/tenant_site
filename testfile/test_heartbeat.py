import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
import requests

WEBHOOK_URL = "http://localhost:5000/api/webhook/uplink/"
SECRET_FILE = Path(__file__).resolve().parent / "webhook_secret.json"

def get_token():
    if SECRET_FILE.exists():
        with open(SECRET_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("token", "")
    return "hctech_sec_9e4a81bf6217c05d762e8316a3c9b740e51240a581e649d2"

def send_heartbeat():
    headers = {
        "Authorization": f"Bearer {get_token()}",
        "Content-Type": "application/json"
    }
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # 1. Gói tin Mẫu 1: Thiết bị GPS lw006 báo vị trí định kỳ
    payload_lw006 = {
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
        "received_at": now_iso,
        "reported_at": now_iso,
        "measurements": [
            {"name": "battery_level", "unit": "%", "value": 100},
            {"name": "charging_status", "unit": None, "value": "no charging"},
            {"name": "device_mode", "unit": None, "value": "Periodic Mode"},
            {"name": "device_status", "unit": None, "value": "No"},
            {"name": "latitude", "unit": "deg", "value": 10.8418266},
            {"name": "longitude", "unit": "deg", "value": 106.7154116},
            {"name": "pdop", "unit": "1", "value": 9.6},
            {"name": "fix_age", "unit": "s", "value": 153},
            {"name": "position_trigger", "unit": None, "value": "Working Mode"},
            {"name": "payload_type", "unit": None, "value": "L76 Pos Success"}
        ],
        "decode_reason": None,
        "decode_status": "ok",
        "schema_version": "1.0"
    }

    # 2. Gói tin Mẫu 2: Nút nhấn mokosmart 002 gửi Heartbeat ("no event triggered")
    payload_btn002 = {
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
        "received_at": now_iso,
        "reported_at": now_iso,
        "measurements": [
            {"name": "temperature", "unit": "Cel", "value": 29},
            {"name": "battery_voltage", "unit": "V", "value": 3.546},
            {"name": "event_type", "unit": None, "value": "no event triggered"}
        ],
        "decode_reason": None,
        "decode_status": "ok",
        "schema_version": "1.0"
    }

    print("[*] Gửi Heartbeat cho thiết bị GPS lw006 (Mẫu 1) và Nút nhấn mokosmart 002 (Mẫu 2)...")
    res = requests.post(WEBHOOK_URL, headers=headers, json=[payload_lw006, payload_btn002], timeout=10)
    print(f"[+] HTTP Status: {res.status_code}")
    print(json.dumps(res.json(), indent=2, ensure_ascii=False))

if __name__ == "__main__":
    send_heartbeat()