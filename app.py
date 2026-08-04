import base64
import os
import uuid

from flask import Flask, jsonify, render_template, request, send_file

from pdf_tools import (
    get_pdf_page_previews,
    render_typed_signature_png,
    stamp_signature_image,
    strip_light_background,
)
from crypto_sign import crypto_sign_pdf, ensure_cert
import signature_store
import pdf_store
import tools

UPLOAD_DIR = os.environ.get("SIGNER_TMP_DIR", "/tmp/pdf-signer")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25 MB

# Make sure a signing certificate exists before we accept any requests.
ensure_cert()


def _path_for(token: str, suffix: str) -> str:
    safe_token = "".join(c for c in token if c.isalnum() or c in "-_")
    return os.path.join(UPLOAD_DIR, f"{safe_token}{suffix}")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/upload", methods=["POST"])
def upload():
    if "pdf" not in request.files:
        return jsonify({"error": "No file field named 'pdf' in request"}), 400

    file = request.files["pdf"]
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only .pdf files are supported"}), 400

    pdf_bytes = file.read()

    token = uuid.uuid4().hex
    src_path = _path_for(token, "_src.pdf")
    with open(src_path, "wb") as f:
        f.write(pdf_bytes)

    try:
        previews = get_pdf_page_previews(src_path)
    except Exception as exc:  # noqa: BLE001
        os.remove(src_path)
        return jsonify({"error": f"Could not read PDF: {exc}"}), 400

    # Save to the persistent "My PDFs" library so it can be downloaded or
    # re-signed later without re-uploading. Best-effort - a storage hiccup
    # here shouldn't block the person from continuing to sign right now.
    saved_pdf_id = None
    try:
        record = pdf_store.save_pdf(pdf_bytes, filename=file.filename)
        saved_pdf_id = record["id"]
    except Exception:  # noqa: BLE001
        pass

    return jsonify({"token": token, "pages": previews, "saved_pdf_id": saved_pdf_id})


@app.route("/api/pdfs", methods=["GET"])
def list_pdfs():
    return jsonify({"pdfs": pdf_store.list_pdfs()})


@app.route("/api/pdfs/<pdf_id>/download", methods=["GET"])
def download_pdf(pdf_id):
    try:
        record = pdf_store.get_record(pdf_id)
        pdf_bytes = pdf_store.get_pdf_bytes(pdf_id)
    except FileNotFoundError:
        return jsonify({"error": "PDF not found"}), 404
    return _send_bytes(pdf_bytes, record["filename"], "application/pdf")


@app.route("/api/pdfs/<pdf_id>", methods=["DELETE"])
def delete_pdf(pdf_id):
    if pdf_store.delete_pdf(pdf_id):
        return jsonify({"deleted": pdf_id})
    return jsonify({"error": "PDF not found"}), 404


@app.route("/api/pdfs/<pdf_id>/load-for-signing", methods=["POST"])
def load_pdf_for_signing(pdf_id):
    """Re-use a saved PDF in the Sign tab without re-uploading it."""
    try:
        record = pdf_store.get_record(pdf_id)
        pdf_bytes = pdf_store.get_pdf_bytes(pdf_id)
    except FileNotFoundError:
        return jsonify({"error": "PDF not found"}), 404

    token = uuid.uuid4().hex
    src_path = _path_for(token, "_src.pdf")
    with open(src_path, "wb") as f:
        f.write(pdf_bytes)

    try:
        previews = get_pdf_page_previews(src_path)
    except Exception as exc:  # noqa: BLE001
        os.remove(src_path)
        return jsonify({"error": f"Could not read PDF: {exc}"}), 400

    return jsonify({"token": token, "pages": previews, "filename": record["filename"]})


@app.route("/api/signatures", methods=["GET"])
def list_signatures():
    records = signature_store.list_signatures()
    out = []
    for r in records:
        try:
            image_b64 = signature_store.signature_to_base64(r["id"])
        except FileNotFoundError:
            continue
        out.append({**r, "image_base64": image_b64})
    return jsonify({"signatures": out})


@app.route("/api/signatures", methods=["POST"])
def create_signature():
    """
    Add a signature to the persistent library. Accepts either:
      - multipart/form-data with a 'file' field (uploaded image) and
        optional 'label' field, or
      - application/json: {"mode": "drawn", "image_base64": "...", "label": "..."}
        or {"mode": "typed", "text": "Jane Doe", "label": "..."}
    """
    label = ""
    image_bytes = None

    if "file" in request.files:
        label = request.form.get("label", "")
        raw_bytes = request.files["file"].read()
        try:
            image_bytes = strip_light_background(raw_bytes)
        except Exception:  # noqa: BLE001
            # If background removal fails for any reason, fall back to the
            # original image rather than losing the upload entirely.
            image_bytes = raw_bytes
    else:
        data = request.get_json(silent=True) or {}
        label = data.get("label", "")
        mode = data.get("mode")
        if mode == "typed":
            text = (data.get("text") or "").strip()
            if not text:
                return jsonify({"error": "text is required for mode='typed'"}), 400
            image_bytes = render_typed_signature_png(text)
            label = label or text
        elif mode == "drawn":
            b64 = data.get("image_base64", "")
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            if not b64:
                return jsonify({"error": "image_base64 is required for mode='drawn'"}), 400
            try:
                image_bytes = base64.b64decode(b64)
            except Exception:  # noqa: BLE001
                return jsonify({"error": "image_base64 is not valid base64"}), 400
        else:
            return jsonify({"error": "Provide a 'file' upload, or JSON with mode='drawn'/'typed'"}), 400

    if not image_bytes:
        return jsonify({"error": "No image data received"}), 400

    try:
        record = signature_store.save_signature(image_bytes, label=label)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not save signature: {exc}"}), 400

    return jsonify({**record, "image_base64": signature_store.signature_to_base64(record["id"])}), 201


@app.route("/api/signatures/<sig_id>", methods=["DELETE"])
def delete_signature(sig_id):
    if signature_store.delete_signature(sig_id):
        return jsonify({"deleted": sig_id})
    return jsonify({"error": "Signature not found"}), 404


@app.route("/api/sign", methods=["POST"])
def sign():
    """
    Expected JSON body:
    {
      "token": "...",
      "page_index": 0,
      "x_pct": 0.1, "y_pct": 0.8, "w_pct": 0.25, "h_pct": 0.08,
      "saved_signature_id": "abc123",   // from /api/signatures
      "crypto_sign": true,
      "signer_name": "Jane Doe",
      "reason": "I approve this document",
      "location": "Calgary, AB"
    }
    """
    data = request.get_json(silent=True) or {}

    token = data.get("token")
    if not token:
        return jsonify({"error": "Missing 'token' - upload a PDF first"}), 400

    src_path = _path_for(token, "_src.pdf")
    if not os.path.exists(src_path):
        return jsonify({"error": "Unknown or expired token, please re-upload"}), 404

    sig_id = data.get("saved_signature_id")
    if not sig_id:
        return jsonify({"error": "Missing 'saved_signature_id' - pick a signature from your library"}), 400

    try:
        sig_bytes = signature_store.get_signature_bytes(sig_id)
    except FileNotFoundError:
        return jsonify({"error": "That signature no longer exists"}), 404

    try:
        page_index = int(data.get("page_index", 0))
        x_pct = float(data.get("x_pct", 0.1))
        y_pct = float(data.get("y_pct", 0.8))
        w_pct = float(data.get("w_pct", 0.25))
        h_pct = float(data.get("h_pct", 0.08))
    except (TypeError, ValueError):
        return jsonify({"error": "x_pct/y_pct/w_pct/h_pct/page_index must be numbers"}), 400

    visual_path = _path_for(token, "_visual.pdf")

    try:
        stamp_signature_image(
            src_path, visual_path, page_index, x_pct, y_pct, w_pct, h_pct, sig_bytes
        )
    except IndexError:
        return jsonify({"error": "page_index out of range"}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Failed to stamp signature: {exc}"}), 500

    final_path = visual_path
    if data.get("crypto_sign"):
        signed_path = _path_for(token, "_signed.pdf")
        try:
            crypto_sign_pdf(
                visual_path,
                signed_path,
                signer_name=data.get("signer_name", ""),
                reason=data.get("reason", ""),
                location=data.get("location", ""),
            )
            final_path = signed_path
        except Exception as exc:  # noqa: BLE001
            return jsonify({"error": f"Failed to apply cryptographic signature: {exc}"}), 500

    return send_file(
        final_path,
        mimetype="application/pdf",
        as_attachment=True,
        download_name="signed.pdf",
    )


def _read_upload(field_name: str = "pdf") -> bytes:
    if field_name not in request.files:
        raise ValueError(f"No file field named '{field_name}' in request")
    return request.files[field_name].read()


def _send_bytes(data: bytes, filename: str, mimetype: str):
    from io import BytesIO
    return send_file(BytesIO(data), mimetype=mimetype, as_attachment=True, download_name=filename)


@app.route("/api/tools/merge", methods=["POST"])
def tools_merge():
    files = request.files.getlist("pdfs")
    if len(files) < 2:
        return jsonify({"error": "Upload at least two PDFs to merge"}), 400
    try:
        merged = tools.merge_pdfs([f.read() for f in files])
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not merge PDFs: {exc}"}), 400
    return _send_bytes(merged, "merged.pdf", "application/pdf")


@app.route("/api/tools/extract", methods=["POST"])
def tools_extract():
    try:
        pdf_bytes = _read_upload("pdf")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    page_spec = request.form.get("pages", "").strip()
    if not page_spec:
        return jsonify({"error": "Specify which pages to extract, e.g. '1,3,5-8'"}), 400

    try:
        result = tools.extract_pages(pdf_bytes, page_spec)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not extract pages: {exc}"}), 400
    return _send_bytes(result, "extracted.pdf", "application/pdf")


@app.route("/api/tools/compress", methods=["POST"])
def tools_compress():
    try:
        pdf_bytes = _read_upload("pdf")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    quality = request.form.get("quality", "ebook")
    try:
        result = tools.compress_pdf(pdf_bytes, quality=quality)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not compress PDF: {exc}"}), 500

    from flask import Response
    resp = Response(result, mimetype="application/pdf")
    resp.headers["Content-Disposition"] = "attachment; filename=compressed.pdf"
    resp.headers["X-Original-Size"] = str(len(pdf_bytes))
    resp.headers["X-Compressed-Size"] = str(len(result))
    return resp


@app.route("/api/tools/form-fields", methods=["POST"])
def tools_form_fields():
    try:
        pdf_bytes = _read_upload("pdf")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        fields = tools.get_form_fields(pdf_bytes)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not read form fields: {exc}"}), 400

    if not fields:
        return jsonify({"error": "This PDF doesn't have fillable form fields. Use the signature/stamp tool to place text manually instead."}), 400

    token = uuid.uuid4().hex
    with open(_path_for(token, "_form.pdf"), "wb") as f:
        f.write(pdf_bytes)

    return jsonify({"token": token, "fields": fields})


@app.route("/api/tools/fill", methods=["POST"])
def tools_fill():
    data = request.get_json(silent=True) or {}
    token = data.get("token")
    values = data.get("values", {})

    if not token:
        return jsonify({"error": "Missing 'token' - upload a PDF via /api/tools/form-fields first"}), 400

    src_path = _path_for(token, "_form.pdf")
    if not os.path.exists(src_path):
        return jsonify({"error": "Unknown or expired token, please re-upload"}), 404

    with open(src_path, "rb") as f:
        pdf_bytes = f.read()

    try:
        filled = tools.fill_form(pdf_bytes, values)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not fill form: {exc}"}), 500

    return _send_bytes(filled, "filled.pdf", "application/pdf")


@app.route("/api/tools/to-word", methods=["POST"])
def tools_to_word():
    try:
        pdf_bytes = _read_upload("pdf")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        docx_bytes = tools.pdf_to_docx(pdf_bytes)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not convert to Word: {exc}"}), 500

    return _send_bytes(
        docx_bytes, "converted.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )


@app.route("/api/tools/protect", methods=["POST"])
def tools_protect():
    try:
        pdf_bytes = _read_upload("pdf")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    user_password = request.form.get("user_password", "").strip()
    owner_password = request.form.get("owner_password", "").strip()
    if not user_password:
        return jsonify({"error": "A password is required"}), 400

    try:
        protected = tools.protect_pdf(pdf_bytes, user_password, owner_password)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not protect PDF: {exc}"}), 500

    return _send_bytes(protected, "protected.pdf", "application/pdf")


@app.route("/api/tools/unlock", methods=["POST"])
def tools_unlock():
    try:
        pdf_bytes = _read_upload("pdf")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    password = request.form.get("password", "").strip()
    if not password:
        return jsonify({"error": "Enter the PDF's password"}), 400

    try:
        unlocked = tools.unlock_pdf(pdf_bytes, password)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not unlock PDF: {exc}"}), 500

    return _send_bytes(unlocked, "unlocked.pdf", "application/pdf")


@app.route("/api/tools/organize/pages", methods=["POST"])
def tools_organize_pages():
    try:
        pdf_bytes = _read_upload("pdf")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        thumbnails = tools.get_page_thumbnails(pdf_bytes)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not read PDF: {exc}"}), 400

    token = uuid.uuid4().hex
    with open(_path_for(token, "_organize.pdf"), "wb") as f:
        f.write(pdf_bytes)

    return jsonify({"token": token, "pages": thumbnails})


@app.route("/api/tools/organize/apply", methods=["POST"])
def tools_organize_apply():
    data = request.get_json(silent=True) or {}
    token = data.get("token")
    order = data.get("order")
    rotations = data.get("rotations", {})

    if not token:
        return jsonify({"error": "Missing 'token' - upload a PDF via /api/tools/organize/pages first"}), 400
    if not isinstance(order, list) or not order:
        return jsonify({"error": "Missing or empty 'order'"}), 400

    src_path = _path_for(token, "_organize.pdf")
    if not os.path.exists(src_path):
        return jsonify({"error": "Unknown or expired token, please re-upload"}), 404

    with open(src_path, "rb") as f:
        pdf_bytes = f.read()

    try:
        result = tools.organize_pdf(pdf_bytes, order, rotations)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Could not organize PDF: {exc}"}), 500

    return _send_bytes(result, "organized.pdf", "application/pdf")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
