"""
Persistent signature library.

Every signature the user creates (drawn, typed, or uploaded) is normalized
to a PNG and stored under SIGNATURE_DIR, with a small JSON index alongside
it. This lets the app list past signatures and re-use them without asking
the user to draw/type/upload again each time.

Mount SIGNATURE_DIR's parent as a volume so this survives container
restarts (see docker-compose.yml / TrueNAS deployment notes).
"""

import base64
import io
import json
import os
import threading
import time
import uuid

from PIL import Image

SIGNATURE_DIR = os.environ.get("SIGNATURE_DIR", "/app/data/signatures")
INDEX_PATH = os.path.join(SIGNATURE_DIR, "index.json")
MAX_DIMENSION = 800  # cap stored image size, keeps the library lightweight

_lock = threading.Lock()


def _ensure_dirs():
    os.makedirs(SIGNATURE_DIR, exist_ok=True)
    if not os.path.exists(INDEX_PATH):
        with open(INDEX_PATH, "w") as f:
            json.dump([], f)


def _load_index():
    _ensure_dirs()
    with open(INDEX_PATH, "r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def _save_index(records):
    with open(INDEX_PATH, "w") as f:
        json.dump(records, f, indent=2)


def list_signatures():
    """Most recently created first."""
    return sorted(_load_index(), key=lambda r: r["created_at"], reverse=True)


def save_signature(image_bytes: bytes, label: str = "") -> dict:
    """Normalize any image bytes to a capped-size PNG and add it to the library."""
    _ensure_dirs()

    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    if max(img.size) > MAX_DIMENSION:
        ratio = MAX_DIMENSION / max(img.size)
        img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))))

    sig_id = uuid.uuid4().hex
    filename = f"{sig_id}.png"
    with open(os.path.join(SIGNATURE_DIR, filename), "wb") as f:
        img.save(f, format="PNG")

    record = {
        "id": sig_id,
        "label": label.strip() or "Untitled signature",
        "filename": filename,
        "created_at": time.time(),
    }

    with _lock:
        records = _load_index()
        records.append(record)
        _save_index(records)

    return record


def _find(sig_id: str):
    return next((r for r in _load_index() if r["id"] == sig_id), None)


def get_signature_bytes(sig_id: str) -> bytes:
    record = _find(sig_id)
    if not record:
        raise FileNotFoundError(f"No saved signature with id '{sig_id}'")
    with open(os.path.join(SIGNATURE_DIR, record["filename"]), "rb") as f:
        return f.read()


def signature_to_base64(sig_id: str) -> str:
    return base64.b64encode(get_signature_bytes(sig_id)).decode("ascii")


def delete_signature(sig_id: str) -> bool:
    with _lock:
        records = _load_index()
        record = next((r for r in records if r["id"] == sig_id), None)
        if not record:
            return False
        records = [r for r in records if r["id"] != sig_id]
        _save_index(records)

    path = os.path.join(SIGNATURE_DIR, record["filename"])
    if os.path.exists(path):
        os.remove(path)
    return True
