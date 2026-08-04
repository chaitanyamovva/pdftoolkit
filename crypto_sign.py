"""
Optional cryptographic (PAdES-style) signing layer.

This applies a real digital signature (RSA + SHA-256) on top of a PDF
using pyHanko. A self-signed certificate is generated automatically on
first run and stored under CERT_DIR. Self-signed means it's
cryptographically valid (tamper-evident, verifiable) but not backed by
a public Certificate Authority, so viewers will show it as "signature
valid" but "identity not verified" unless you swap in your own
CA-issued cert/key.
"""

import datetime
import os

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from pyhanko.sign import PdfSignatureMetadata, signers
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

CERT_DIR = os.environ.get("SIGNER_CERT_DIR", "/app/certs")
CERT_PATH = os.path.join(CERT_DIR, "cert.pem")
KEY_PATH = os.path.join(CERT_DIR, "key.pem")


def ensure_cert(common_name: str = "PDF Signer (self-signed)"):
    """Create a self-signed cert/key pair if one doesn't exist yet."""
    os.makedirs(CERT_DIR, exist_ok=True)
    if os.path.exists(CERT_PATH) and os.path.exists(KEY_PATH):
        return

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    with open(KEY_PATH, "wb") as f:
        f.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    with open(CERT_PATH, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def crypto_sign_pdf(
    input_path: str,
    output_path: str,
    signer_name: str = "",
    reason: str = "",
    location: str = "",
    field_name: str = "Signature1",
):
    """Apply an invisible cryptographic signature field to the PDF."""
    ensure_cert()

    signer = signers.SimpleSigner.load(
        key_file=KEY_PATH,
        cert_file=CERT_PATH,
        key_passphrase=None,
    )

    meta = PdfSignatureMetadata(
        field_name=field_name,
        reason=reason or None,
        location=location or None,
        name=signer_name or None,
    )

    with open(input_path, "rb") as inf:
        writer = IncrementalPdfFileWriter(inf)
        out_buffer = signers.sign_pdf(writer, meta, signer=signer)

    with open(output_path, "wb") as outf:
        outf.write(out_buffer.getbuffer())
