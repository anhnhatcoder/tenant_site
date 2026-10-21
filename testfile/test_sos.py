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

def send_sos():
    headers = {
        "Authorization": f"Bearer {get_token()}",
        "Content-Type": "application/json"
    }
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # Chuẩn JSON Mẫu 2 nhưng kích hoạt "event 1 trigger" (Bấm nút SOS)
    payload_sos = {
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
            {"name": "event_type", "unit": None, "value": "event 1 trigger"}
        ],
        "decode_reason": None,
        "decode_status": "ok",
        "schema_version": "1.0"
    }

    print("[🚨] Đang gửi tín hiệu bấm nút SOS từ 'Nút nhấn mokosmart 002'...")
    res = requests.post(WEBHOOK_URL, headers=headers, json=payload_sos, timeout=10)
    print(f"[+] HTTP Status: {res.status_code}")
    print(json.dumps(res.json(), indent=2, ensure_ascii=False))

if __name__ == "__main__":
    send_sos()