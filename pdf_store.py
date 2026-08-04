"""
Persistent storage for PDFs uploaded to the app (currently: anything
uploaded through the Sign tab). Lets the person download or re-sign the
same file later without re-uploading, and delete ones they no longer need.

Mount PDF_DIR's parent as a volume so this survives container restarts.
"""

import json
import os
import threading
import time
import uuid

PDF_DIR = os.environ.get("PDF_STORAGE_DIR", "/app/data/pdfs")
INDEX_PATH = os.path.join(PDF_DIR, "index.json")

_lock = threading.Lock()


def _ensure_dirs():
    os.makedirs(PDF_DIR, exist_ok=True)
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


def list_pdfs():
    """Most recently uploaded first."""
    return sorted(_load_index(), key=lambda r: r["created_at"], reverse=True)


def save_pdf(pdf_bytes: bytes, filename: str = "") -> dict:
    _ensure_dirs()

    pdf_id = uuid.uuid4().hex
    stored_filename = f"{pdf_id}.pdf"
    with open(os.path.join(PDF_DIR, stored_filename), "wb") as f:
        f.write(pdf_bytes)

    record = {
        "id": pdf_id,
        "filename": filename.strip() or "document.pdf",
        "stored_filename": stored_filename,
        "size": len(pdf_bytes),
        "created_at": time.time(),
    }

    with _lock:
        records = _load_index()
        records.append(record)
        _save_index(records)

    return record


def _find(pdf_id: str):
    return next((r for r in _load_index() if r["id"] == pdf_id), None)


def get_pdf_bytes(pdf_id: str) -> bytes:
    record = _find(pdf_id)
    if not record:
        raise FileNotFoundError(f"No saved PDF with id '{pdf_id}'")
    with open(os.path.join(PDF_DIR, record["stored_filename"]), "rb") as f:
        return f.read()


def get_record(pdf_id: str):
    record = _find(pdf_id)
    if not record:
        raise FileNotFoundError(f"No saved PDF with id '{pdf_id}'")
    return record


def delete_pdf(pdf_id: str) -> bool:
    with _lock:
        records = _load_index()
        record = next((r for r in records if r["id"] == pdf_id), None)
        if not record:
            return False
        records = [r for r in records if r["id"] != pdf_id]
        _save_index(records)

    path = os.path.join(PDF_DIR, record["stored_filename"])
    if os.path.exists(path):
        os.remove(path)
    return True
