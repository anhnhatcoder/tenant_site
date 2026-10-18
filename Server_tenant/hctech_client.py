import time
import logging
from datetime import datetime, timedelta, timezone as dt_timezone
from typing import Optional, List, Dict, Generator, Any

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

# Múi giờ chuẩn theo tài liệu FR-11.19 (Asia/Ho_Chi_Minh, UTC+7)
VN_TZ = dt_timezone(timedelta(hours=7))


class HCTechAPIError(Exception):
    """
    Ngoại lệ chuẩn hóa cho các lỗi trả về từ HC TECH IoT Public API (SRS chương 15).
    Ví dụ: IOT-COM-001 (Bad Request), IOT-API-011 (Vượt giới hạn 31 ngày), IOT-CMD-003 (Hàng đợi đầy).
    """
    def __init__(
        self,
        status_code: int,
        error_code: str,
        message: str,
        remediation: Optional[str] = None,
        details: Optional[dict] = None,
        trace_id: Optional[str] = None
    ):
        self.status_code = status_code
        self.error_code = error_code
        self.message = message
        self.remediation = remediation or ""
        self.details = details or {}
        self.trace_id = trace_id
        
        info = f"[{status_code} {error_code}] {message}"
        if self.remediation:
            info += f" | Khắc phục: {self.remediation}"
        if self.details:
            info += f" | Details: {self.details}"
        if self.trace_id:
            info += f" (trace_id={self.trace_id})"
        super().__init__(info)


class HCTechIoTClient:
    """
    HTTP Client giao tiếp với Nền tảng Quản lý IoT Tập trung HC TECH (HCTech IoT Platform v1.2.0):
    Tuân thủ hợp đồng OpenAPI openapi.yaml:
    - Kênh API công khai: https://iot.hctech.com.vn/api/public/v1 (hoặc staging)
    - Xác thực: Bearer Token (ApiKeyAuth: data:read, downlink:write, devices:manage)
    - Quản lý dữ liệu đo đạc (Telemetry & Aggregated Telemetry)
    - Quản lý danh mục (Catalog: Groups, Devices, DeviceMetrics)
    - Quản lý lệnh điều khiển LoRaWAN (Downlink Commands: Form-based & Raw bytes)
    """
    PROD_BASE_URL = "https://iot.hctech.com.vn/api/public/v1"
    STAGING_BASE_URL = "https://iot-staging.hctech.com.vn/api/public/v1"
    DEFAULT_BASE_URL = "https://iot-staging.hctech.com.vn/api/public/v1"
    MAX_DAYS_SINGLE_DEVICE = 31  # Giới hạn P-13 = 31 ngày (FR-11.18, SRS 9.4.3)

    def __init__(self, bearer_token: Optional[str] = None, base_url: Optional[str] = None, timeout: int = 20):
        self.base_url = (base_url or getattr(settings, "HCTECH_IOT_BASE_URL", self.DEFAULT_BASE_URL)).rstrip("/")
        self.token = bearer_token or getattr(settings, "HCTECH_IOT_API_TOKEN", "")
        self.timeout = timeout

        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "Content-Type": "application/json",
        })
        if self.token:
            self.session.headers.update({"Authorization": f"Bearer {self.token}"})

    @staticmethod
    def to_rfc3339(dt: datetime) -> str:
        """
        Chuyển đổi datetime sang chuỗi RFC 3339 có offset múi giờ +07:00 (FR-11.19).
        Ví dụ: '2026-08-01T00:00:00+07:00'
        """
        if dt.tzinfo is None or dt.tzinfo.utcoffset(dt) is None:
            dt = dt.replace(tzinfo=VN_TZ)
        else:
            dt = dt.astimezone(VN_TZ)
        return dt.isoformat(timespec="seconds")

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Any] = None,
        max_retries: int = 3
    ) -> Dict[str, Any]:
        """
        Gửi HTTP request kèm xử lý Rate Limit (Header Retry-After - FR-12.8) và bóc tách mã lỗi chuẩn.
        """
        url = f"{self.base_url}/{path.lstrip('/')}"
        clean_params = {k: v for k, v in (params or {}).items() if v is not None and v != ""}

        for attempt in range(max_retries):
            try:
                response = self.session.request(
                    method=method,
                    url=url,
                    params=clean_params,
                    json=json_body,
                    timeout=self.timeout
                )
            except requests.RequestException as exc:
                logger.error(f"[HCTech API] Lỗi kết nối mạng ({url}): {exc}")
                if attempt == max_retries - 1:
                    raise
                time.sleep(2 ** attempt)
                continue

            # Xử lý Rate Limit (HTTP 429) dựa theo Header 'Retry-After'
            if response.status_code == 429:
                retry_after = int(response.headers.get("Retry-After", 5))
                logger.warning(f"[HCTech API] Chạm giới hạn tần suất (429). Chờ {retry_after}s trước khi thử lại...")
                time.sleep(retry_after)
                continue

            # Theo dõi tầng dữ liệu (X-Query-Tier: hot | warm | cold - RB-08)
            query_tier = response.headers.get("X-Query-Tier")
            if query_tier == "cold":
                logger.info(f"[HCTech API] Truy vấn {path} chạm tầng dữ liệu lạnh (X-Query-Tier=cold).")

            if response.status_code == 204:
                return {"_status": 204, "_success": True}

            if response.ok:
                data = response.json() if response.content else {}
                if isinstance(data, dict):
                    if query_tier:
                        data["_query_tier"] = query_tier
                    data["_status_code"] = response.status_code
                return data

            # Bóc tách cấu trúc lỗi JSON theo schema Error của HC TECH
            try:
                err_payload = response.json()
            except ValueError:
                err_payload = {}

            raise HCTechAPIError(
                status_code=response.status_code,
                error_code=err_payload.get("error_code", f"HTTP_{response.status_code}"),
                message=err_payload.get("message", response.text),
                remediation=err_payload.get("remediation", ""),
                details=err_payload.get("details", {}),
                trace_id=err_payload.get("trace_id"),
            )

        raise RuntimeError(f"[HCTech API] Vượt quá số lần thử lại ({max_retries}) cho {url}")

    def ping(self) -> Dict[str, Any]:
        """
        Kiểm tra độ trễ mạng và tính sẵn sàng của HC TECH IoT Cloud API.
        """
        t0 = time.time()
        res = self.get_groups(limit=1)
        latency_ms = round((time.time() - t0) * 1000, 1)
        return {
            "ok": True,
            "latency_ms": latency_ms,
            "base_url": self.base_url,
            "query_tier": res.get("_query_tier", "hot"),
            "groups_total": (res.get("pagination") or {}).get("total_count", 0)
        }

    def _paginate(self, path: str, base_params: Dict[str, Any], limit: int = 100) -> Generator[Dict[str, Any], None, None]:
        """
        Trình duyệt phân trang tự động bằng con trỏ (cursor pagination - FR-11.12).
        Giữ nguyên các tham số lọc của trang đã sinh ra cursor để tránh lỗi 400 IOT-COM-001.
        """
        cursor = None
        while True:
            params = dict(base_params)
            params["limit"] = limit
            if cursor:
                params["cursor"] = cursor

            res = self._request("GET", path, params=params)
            items = res.get("data", [])
            for item in items:
                yield item

            pagination = res.get("pagination") or {}
            cursor = pagination.get("next_cursor")
            if not cursor:
                break

    # ==========================================================================
    # 1. CATALOG APIs (FR-11.14)
    # ==========================================================================
    def get_groups(self, cursor: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        """
        GET /groups — Danh mục nhóm (FR-11.14, FR-03.1, FR-03.2).
        Nhóm phẳng một cấp, mỗi nhóm đúng một loại kết nối (lorawan, mqtt, http).
        """
        return self._request("GET", "/groups", params={"cursor": cursor, "limit": limit})

    def iter_all_groups(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Lấy toàn bộ danh sách nhóm phẳng một cấp thuộc tenant."""
        return list(self._paginate("/groups", {}, limit=limit))

    def get_devices(
        self,
        group_id: Optional[str] = None,
        status: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: int = 100
    ) -> Dict[str, Any]:
        """
        GET /devices — Danh mục thiết bị trong phạm vi tenant (FR-11.14, FR-11.17).
        :param group_id: UUID của nhóm (tùy chọn).
        :param status: 'active', 'disabled', hoặc 'retired' (FR-05.10a).
        """
        if status and status not in ("active", "disabled", "retired"):
            raise ValueError("Tham số status chỉ nhận: 'active', 'disabled', hoặc 'retired'.")
        params = {"group_id": group_id, "status": status, "cursor": cursor, "limit": limit}
        return self._request("GET", "/devices", params=params)

    def iter_all_devices(
        self,
        group_id: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Tự động duyệt qua toàn bộ cursor để lấy hết thiết bị thuộc tenant."""
        return list(self._paginate("/devices", {"group_id": group_id, "status": status}, limit=limit))

    def get_device_metrics(self, device_uuid: str, include_deprecated: bool = True) -> List[Dict[str, Any]]:
        """
        GET /devices/{deviceId}/metrics — Các đại lượng thiết bị này cung cấp (FR-11.14).
        Đọc từ danh mục đầu ra của phiên bản gói hồ sơ đang gán.
        """
        res = self._request("GET", f"/devices/{device_uuid}/metrics")
        # Schema DeviceMetrics: { "device_id": "...", "package": {...}, "metrics": [...] }
        raw_metrics = res.get("metrics")
        if raw_metrics is None:
            raw_metrics = res.get("data") if isinstance(res.get("data"), list) else (res if isinstance(res, list) else [])
        
        if not include_deprecated and isinstance(raw_metrics, list):
            return [m for m in raw_metrics if not m.get("deprecated", False)]
        return raw_metrics or []

    # ==========================================================================
    # 2. TELEMETRY APIs (FR-11.11 -> FR-11.13)
    # ==========================================================================
    def get_telemetry(
        self,
        from_time: datetime,
        to_time: datetime,
        device_id: Optional[str] = None,
        group_id: Optional[str] = None,
        metrics: Optional[List[str]] = None,
        cursor: Optional[str] = None,
        limit: int = 100
    ) -> Dict[str, Any]:
        """
        GET /telemetry — Truy vấn dữ liệu đo chi tiết (FR-11.11).
        Truyền ĐÚNG MỘT trong hai: device_id hoặc group_id (FR-11.11, tránh lỗi 400 IOT-COM-001).
        """
        if bool(device_id) == bool(group_id):
            raise ValueError("Phải truyền ĐÚNG MỘT trong hai tham số: 'device_id' hoặc 'group_id' (FR-11.11).")

        metrics_str = ",".join(metrics) if isinstance(metrics, (list, tuple)) else metrics
        params = {
            "device_id": device_id,
            "group_id": group_id,
            "from": self.to_rfc3339(from_time),
            "to": self.to_rfc3339(to_time),
            "metrics": metrics_str,
            "cursor": cursor,
            "limit": limit,
        }
        return self._request("GET", "/telemetry", params=params)

    def fetch_all_telemetry(
        self,
        from_time: datetime,
        to_time: datetime,
        device_id: Optional[str] = None,
        group_id: Optional[str] = None,
        metrics: Optional[List[str]] = None,
        group_device_count: int = 1,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Lấy toàn bộ lịch sử dữ liệu đo trong khoảng thời gian bất kỳ.
        Tự động chia nhỏ khoảng thời gian theo giới hạn P-13 (FR-11.18, tránh lỗi IOT-API-011):
        - 1 thiết bị: Tối đa 31 ngày / lần truy vấn.
        - Theo nhóm: Tối đa max(1, 31 // số_thiết_bị_trong_nhóm) ngày / lần truy vấn.
        """
        if bool(device_id) == bool(group_id):
            raise ValueError("Phải truyền ĐÚNG MỘT trong hai tham số: 'device_id' hoặc 'group_id'.")

        max_days = self.MAX_DAYS_SINGLE_DEVICE if device_id else max(1, self.MAX_DAYS_SINGLE_DEVICE // max(1, group_device_count))
        max_window = timedelta(days=max_days)

        all_records: List[Dict[str, Any]] = []
        chunk_start = from_time

        while chunk_start < to_time:
            chunk_end = min(chunk_start + max_window, to_time)
            metrics_str = ",".join(metrics) if isinstance(metrics, (list, tuple)) else metrics

            base_params = {
                "device_id": device_id,
                "group_id": group_id,
                "from": self.to_rfc3339(chunk_start),
                "to": self.to_rfc3339(chunk_end),
                "metrics": metrics_str,
            }
            for record in self._paginate("/telemetry", base_params, limit=limit):
                all_records.append(record)

            chunk_start = chunk_end

        return all_records

    def get_aggregated_telemetry(
        self,
        from_time: datetime,
        to_time: datetime,
        interval: str = "hour",
        device_id: Optional[str] = None,
        group_id: Optional[str] = None,
        metrics: Optional[List[str]] = None,
        cursor: Optional[str] = None,
        limit: int = 100
    ) -> Dict[str, Any]:
        """
        GET /telemetry/aggregated — Truy vấn số liệu tổng hợp theo giờ hoặc ngày (FR-11.13).
        Trả về min, max, avg, sum, count, out_of_range_count và is_final.
        :param interval: Bắt buộc chọn 'hour' hoặc 'day'.
        """
        if interval not in ("hour", "day"):
            raise ValueError("Tham số interval bắt buộc phải là 'hour' hoặc 'day' (FR-11.13).")
        if bool(device_id) == bool(group_id):
            raise ValueError("Phải truyền ĐÚNG MỘT trong hai: 'device_id' hoặc 'group_id'.")

        metrics_str = ",".join(metrics) if isinstance(metrics, (list, tuple)) else metrics
        params = {
            "device_id": device_id,
            "group_id": group_id,
            "interval": interval,
            "from": self.to_rfc3339(from_time),
            "to": self.to_rfc3339(to_time),
            "metrics": metrics_str,
            "cursor": cursor,
            "limit": limit,
        }
        return self._request("GET", "/telemetry/aggregated", params=params)

    def fetch_all_aggregated_telemetry(
        self,
        from_time: datetime,
        to_time: datetime,
        interval: str = "hour",
        device_id: Optional[str] = None,
        group_id: Optional[str] = None,
        metrics: Optional[List[str]] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Duyệt lấy toàn bộ các khoảng tổng hợp qua con trỏ cursor."""
        metrics_str = ",".join(metrics) if isinstance(metrics, (list, tuple)) else metrics
        base_params = {
            "device_id": device_id,
            "group_id": group_id,
            "interval": interval,
            "from": self.to_rfc3339(from_time),
            "to": self.to_rfc3339(to_time),
            "metrics": metrics_str,
        }
        return list(self._paginate("/telemetry/aggregated", base_params, limit=limit))

    # ==========================================================================
    # 3. DOWNLINK COMMANDS APIs (FR-10.1, FR-10.4, FR-10.5)
    # ==========================================================================
    def send_command(
        self,
        device_uuid: str,
        command_name: Optional[str] = None,
        command_parameters: Optional[Dict[str, Any]] = None,
        raw_f_port: Optional[int] = None,
        raw_payload_hex: Optional[str] = None,
        confirmed: bool = False
    ) -> Dict[str, Any]:
        """
        POST /devices/{deviceId}/commands — Gửi lệnh xuống thiết bị LoRaWAN (FR-10.1, SRS 10).
        Cần phạm vi 'downlink:write'.
        Hỗ trợ 2 cách gửi (chọn đúng một theo schema CommandRequest):
        - Cách 1: Form command theo gói hồ sơ: command_name + command_parameters
        - Cách 2: Raw hex bytes: raw_f_port (1-223) + raw_payload_hex (tối đa 242 bytes hex)
        Phản hồi 202: Lệnh đã vào hàng đợi (với thiết bị Class A, lệnh chỉ gửi khi thiết bị thức dậy).
        """
        body: Dict[str, Any] = {"confirmed": bool(confirmed)}

        if command_name:
            body["command"] = {
                "name": command_name,
                "parameters": command_parameters or {}
            }
        elif raw_f_port is not None and raw_payload_hex:
            if not (1 <= raw_f_port <= 223):
                raise ValueError("Cổng f_port ứng dụng LoRaWAN phải nằm trong khoảng từ 1 đến 223.")
            clean_hex = raw_payload_hex.strip().replace(" ", "").lower()
            if len(clean_hex) % 2 != 0 or len(clean_hex) > 484:  # 242 byte = 484 hex chars
                raise ValueError("Payload thô phải là chuỗi Hex hợp lệ (độ dài chẵn, tối đa 242 byte).")
            body["raw"] = {
                "f_port": raw_f_port,
                "payload": clean_hex
            }
        else:
            raise ValueError("Phải cung cấp ĐÚNG MỘT trong hai: Form Command (command_name) hoặc Raw Hex (raw_f_port & raw_payload_hex).")

        return self._request("POST", f"/devices/{device_uuid}/commands", json_body=body)

    def list_commands(
        self,
        device_uuid: str,
        status: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: int = 100
    ) -> Dict[str, Any]:
        """
        GET /devices/{deviceId}/commands — Hàng đợi và lịch sử lệnh của thiết bị (FR-10.4, FR-10.5).
        Trạng thái vòng đời lệnh: pending, queued, sent, delivered, failed, cancelled, expired.
        """
        valid_statuses = ("pending", "queued", "sent", "delivered", "failed", "cancelled", "expired")
        if status and status not in valid_statuses:
            raise ValueError(f"Trạng thái lệnh không hợp lệ. Chọn từ: {valid_statuses}")

        params = {"status": status, "cursor": cursor, "limit": limit}
        return self._request("GET", f"/devices/{device_uuid}/commands", params=params)

    def cancel_command(self, device_uuid: str, command_id: str) -> bool:
        """
        DELETE /devices/{deviceId}/commands/{commandId} — Hủy lệnh chưa phát xuống (FR-10.4).
        Chỉ hủy được lệnh ở trạng thái 'pending' hoặc 'queued'.
        Trả về True nếu thành công (HTTP 204 No Content).
        """
        res = self._request("DELETE", f"/devices/{device_uuid}/commands/{command_id}")
        return res.get("_success", True)