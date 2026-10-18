import json
import queue
import threading

_subscribers_lock = threading.Lock()
_subscribers = []


def register_subscriber():
    """Đăng ký một client SSE mới."""
    q = queue.Queue(maxsize=50)
    with _subscribers_lock:
        _subscribers.append(q)
    return q


def unregister_subscriber(q):
    """Hủy đăng ký client khi đóng trình duyệt hoặc ngắt kết nối."""
    with _subscribers_lock:
        if q in _subscribers:
            _subscribers.remove(q)


def broadcast_event(event_type: str, data: dict):
    """
    Phát sự kiện đến tất cả các trình duyệt đang mở Dashboard.
    """
    message = {
        "type": event_type,
        "payload": data
    }
    with _subscribers_lock:
        for q in list(_subscribers):
            try:
                q.put_nowait(message)
            except queue.Full:
                pass
