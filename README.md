# PDF Signer

A small self-hosted app for signing PDFs:

1. **Signature library** — draw a signature, type your name, or upload an
   image of your signature. Every signature you create is saved to a
   persistent library so you can reuse it later without recreating it;
   pick any saved signature from the list before signing, or delete ones
   you don't need anymore.
2. **Visual signature** — place your chosen signature anywhere on any page.
3. **Cryptographic signature (optional)** — apply a real digital signature
   (RSA + SHA-256, PAdES-style via pyHanko) on top, so the file is
   tamper-evident. Uses a self-signed certificate generated automatically
   on first run.

Comes with both a web UI and a matching REST API.

## PDF toolbox

Beyond signing, the app includes an "Other PDF tools" tab with:

- **Organize pages** — drag to reorder, rotate 90° at a time, or delete pages, then save.
- **Merge** — combine multiple PDFs into one, in the order you pick them.
- **Extract pages** — pull out specific pages (e.g. `1,3,5-8`) into a new PDF.
- **Compress** — shrink file size (uses Ghostscript if available for real image downsampling, falls back to qpdf's stream optimization otherwise).
- **Fill form** — detects real AcroForm fields (text/checkbox/choice) and lets you fill them in the browser. PDFs without actual form fields aren't supported here — use the Sign tab's drag-and-drop placement to stamp text/images onto those instead.
- **Convert to Word** — extracts text and tables into an editable `.docx`. This isn't a pixel-perfect layout clone; complex formatting and images won't carry over.
- **Add password** / **Remove password** — standard PDF encryption via `pypdf`.

There's also an in-app **Docs** tab with a plain-language explanation of every tool and its limitations, and a **My PDFs** tab (see below).

### Tool API endpoints
All under `/api/tools/`, accepting `multipart/form-data` unless noted:

| Endpoint | Fields | Notes |
|---|---|---|
| `POST /organize/pages` | `pdf` | Returns `{token, pages}` (thumbnails) |
| `POST /organize/apply` | JSON `{token, order, rotations}` | `order` = list of original 0-based page indices in new order (omit to delete); `rotations` = `{index: degrees}` |
| `POST /merge` | `pdfs` (multiple files) | Order = upload order |
| `POST /extract` | `pdf`, `pages` (e.g. `1,3,5-8`) | |
| `POST /compress` | `pdf`, `quality` (`screen`/`ebook`/`printer`) | Response has `X-Original-Size`/`X-Compressed-Size` headers |
| `POST /form-fields` | `pdf` | Returns `{token, fields}`; errors if no fillable fields exist |
| `POST /fill` | JSON `{token, values}` | `token` from `/form-fields` |
| `POST /to-word` | `pdf` | Returns `.docx` |
| `POST /protect` | `pdf`, `user_password`, `owner_password` (optional) | |
| `POST /unlock` | `pdf`, `password` | 400 with an error message on wrong password |

## My PDFs (saved uploads)

Every PDF uploaded through the **Sign** tab is automatically saved to a persistent library under `/app/data/pdfs`, so you can download it again later or reuse it (via "Sign again") without re-uploading. Delete entries you no longer need from the **My PDFs** tab.

This auto-save currently only covers the Sign tab's upload — PDFs uploaded directly into the other tools (Merge, Compress, etc.) are processed and returned but not added to this library.

Endpoints: `GET /api/pdfs`, `GET /api/pdfs/<id>/download`, `DELETE /api/pdfs/<id>`, `POST /api/pdfs/<id>/load-for-signing`.

## Deploying on TrueNAS SCALE

**Easiest way — Install via YAML:**

1. Create the two datasets first: `apps/pdf-signer/certs` and `apps/pdf-signer/data` under your pool (**Datasets** → your pool → **Add Dataset**).
2. Go to **Apps** → **Discover Apps** → **Custom App**, and switch to the **Install via YAML** tab.
3. Open `truenas-compose.yaml` from this project, edit the three marked spots (image name, port, pool name), and paste the result in.
4. Save/Deploy, then browse to `http://<truenas-ip>:<port>`.

If your SCALE version doesn't have "Install via YAML", use the form-based Custom App UI instead — same image, port, and two volume mounts, just entered field-by-field.

## Running it elsewhere (or testing locally first)

**Option A — scripts (Windows/PowerShell):**

```powershell
# Test it locally first
.\run-local.ps1

# Build & push to Docker Hub for TrueNAS (or any remote host) to pull
.\publish.ps1 -DockerHubUser your_dockerhub_username
```

**Option B — manual commands:**

```bash
docker build -t pdf-signer .
docker run -p 5000:5000 pdf-signer
```

or with docker-compose (keeps the same signing certificate and signature
library across restarts):

```bash
docker compose up --build
```

Then open http://localhost:5000

## API

### `POST /api/upload`
`multipart/form-data` with a `pdf` field. Returns a `token` and a base64 PNG
preview of every page (so a client can build a placement UI).

```json
{ "token": "abc123", "pages": [{ "index": 0, "width_pt": 612, "height_pt": 792, "image_base64": "..." }] }
```

### `GET /api/signatures`
Lists every saved signature, most recent first.

```json
{ "signatures": [{ "id": "...", "label": "My signature", "created_at": 173..., "image_base64": "..." }] }
```

### `POST /api/signatures`
Add a signature to the persistent library. Either:
- `multipart/form-data` with a `file` field (image upload) and optional `label`, or
- `application/json`: `{"mode": "drawn", "image_base64": "data:image/png;base64,...", "label": "..."}`
  or `{"mode": "typed", "text": "Jane Doe", "label": "..."}`

Returns the new record (id, label, created_at, image_base64).

### `DELETE /api/signatures/<id>`
Removes a saved signature.

### `POST /api/sign`
`application/json` body:

```json
{
  "token": "abc123",
  "page_index": 0,
  "x_pct": 0.1, "y_pct": 0.8, "w_pct": 0.25, "h_pct": 0.08,
  "saved_signature_id": "abc123",
  "crypto_sign": true,
  "signer_name": "Jane Doe",
  "reason": "I approve this document",
  "location": "Calgary, AB"
}
```

- `saved_signature_id` must reference a signature already added via `POST /api/signatures`.
- `x_pct`/`y_pct`/`w_pct`/`h_pct` are fractions (0–1) of the page; `y_pct`
  is measured from the **top** of the page.
- `crypto_sign` is optional. When true, the fields above it (`signer_name`,
  `reason`, `location`) are embedded in the digital signature metadata.

Returns the signed PDF as a file download.

## About the cryptographic signature

The app generates its own self-signed certificate the first time it runs
(stored in `/app/certs`). This makes the signature cryptographically valid
and tamper-evident — if the PDF is modified afterward, verification will
fail. However, since it isn't issued by a public Certificate Authority,
PDF viewers (e.g. Adobe Acrobat) will show the signature as valid but the
**signer identity as unverified**.

To use a "real", CA-trusted signature instead:

1. Get a code/document-signing certificate + private key (PEM format) from
   a CA or your organization's PKI.
2. Mount them into the container, replacing the generated ones:
   ```bash
   docker run -p 5000:5000 \
     -v /path/to/your/cert.pem:/app/certs/cert.pem \
     -v /path/to/your/key.pem:/app/certs/key.pem \
     pdf-signer
   ```

## Notes

- Uploaded files and intermediate PDFs are stored temporarily under
  `/tmp/pdf-signer` inside the container and are not automatically purged
  — for a production deployment, add a cleanup cron or restart policy.
- Your signature library is stored under `/app/data/signatures` — **mount
  this as a volume** (see `docker-compose.yml`) or it will be lost when the
  container is recreated.
- Max upload size is 25 MB (edit `MAX_CONTENT_LENGTH` in `app.py` to change).
