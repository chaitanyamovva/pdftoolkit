FROM python:3.11-slim

# pypdfium2 and cryptography wheels are prebuilt for slim, but keep basic
# build tools around in case a source build is ever triggered.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libjpeg62-turbo \
        zlib1g \
        ghostscript \
        qpdf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Certificate, signature library, saved-PDFs library, and temp upload storage
RUN mkdir -p /app/certs /app/data/signatures /app/data/pdfs /tmp/pdf-signer

ENV FLASK_ENV=production \
    SIGNER_CERT_DIR=/app/certs \
    SIGNATURE_DIR=/app/data/signatures \
    PDF_STORAGE_DIR=/app/data/pdfs \
    SIGNER_TMP_DIR=/tmp/pdf-signer \
    PYTHONUNBUFFERED=1

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "60", "app:app"]
