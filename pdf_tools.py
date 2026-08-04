"""
Core PDF manipulation helpers.

Two independent capabilities live here:
  1. get_pdf_page_previews  -> render each page as a PNG so the browser
     can show the user where they're about to place a signature.
  2. stamp_signature_image / stamp_signature_text -> burn a *visual*
     signature onto a chosen page at a chosen (x, y, w, h) box.

Cryptographic (PAdES) signing lives in crypto_sign.py and is applied
*after* the visual stamp, as a separate optional step.
"""

import io
import base64

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.utils import ImageReader


def get_pdf_page_previews(pdf_path: str, dpi: int = 110):
    """Render every page of the PDF to a base64 PNG + report its size in points."""
    pdf = pdfium.PdfDocument(pdf_path)
    previews = []
    try:
        scale = dpi / 72.0
        for i in range(len(pdf)):
            page = pdf[i]
            width_pt, height_pt = page.get_size()
            bitmap = page.render(scale=scale)
            pil_image = bitmap.to_pil().convert("RGB")
            buf = io.BytesIO()
            pil_image.save(buf, format="PNG")
            previews.append(
                {
                    "index": i,
                    "width_pt": width_pt,
                    "height_pt": height_pt,
                    "image_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
                }
            )
    finally:
        pdf.close()
    return previews


def get_page_count(pdf_path: str) -> int:
    reader = PdfReader(pdf_path)
    return len(reader.pages)


def _box_to_pdf_coords(page_w, page_h, x_pct, y_pct, w_pct, h_pct):
    """UI sends x/y/w/h as fractions (0-1) of the page, with y measured
    from the TOP of the page (like CSS). PDF coordinates have origin at
    bottom-left, so we flip y here."""
    w = w_pct * page_w
    h = h_pct * page_h
    x = x_pct * page_w
    y = page_h - (y_pct * page_h) - h
    return x, y, w, h


def stamp_signature_image(
    pdf_path: str,
    output_path: str,
    page_index: int,
    x_pct: float,
    y_pct: float,
    w_pct: float,
    h_pct: float,
    sig_png_bytes: bytes,
):
    """Overlay a drawn signature (PNG with transparency) onto one page."""
    reader = PdfReader(pdf_path)
    writer = PdfWriter()

    target_page = reader.pages[page_index]
    page_w = float(target_page.mediabox.width)
    page_h = float(target_page.mediabox.height)
    x, y, w, h = _box_to_pdf_coords(page_w, page_h, x_pct, y_pct, w_pct, h_pct)

    sig_img = Image.open(io.BytesIO(sig_png_bytes)).convert("RGBA")

    packet = io.BytesIO()
    c = rl_canvas.Canvas(packet, pagesize=(page_w, page_h))
    c.drawImage(ImageReader(sig_img), x, y, width=w, height=h, mask="auto")
    c.save()
    packet.seek(0)
    overlay_page = PdfReader(packet).pages[0]

    for i, page in enumerate(reader.pages):
        if i == page_index:
            page.merge_page(overlay_page)
        writer.add_page(page)

    with open(output_path, "wb") as f:
        writer.write(f)


def strip_light_background(image_bytes: bytes, feather: float = 25.0, pad: int = 10, max_dim: int = 1400) -> bytes:
    """
    Isolate dark ink strokes from whatever background they were photographed
    on, make everything else transparent, and crop tightly to just the
    signature.

    Real phone photos usually have a lighting gradient/vignette (corners
    darker than center), which breaks a single global brightness threshold -
    it ends up splitting "dark corner" from "light center" instead of "ink"
    from "paper". To handle this, we estimate a smooth local-background map
    (heavy downsample + upsample, which blurs away thin ink strokes but keeps
    the broad lighting gradient), then flag a pixel as ink only if it's
    darker than *its own local neighborhood's* background - not a single
    global cutoff.

    This won't fix a photo taken at an angle (that needs a straighter photo
    or the Draw tab instead), but it removes background/vignette and
    tight-crops to just the signature.
    """
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)  # respect the phone's camera rotation
    img = img.convert("RGBA")

    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))), Image.LANCZOS)

    arr = np.array(img).astype(np.float32)
    gray = arr[..., :3].mean(axis=2)
    h, w = gray.shape

    small_w, small_h = max(8, w // 40), max(8, h // 40)
    gray_img = Image.fromarray(np.clip(gray, 0, 255).astype(np.uint8), mode="L")
    small = gray_img.resize((small_w, small_h), Image.BILINEAR)
    background = small.resize((w, h), Image.BICUBIC)
    background_arr = np.array(background).astype(np.float32)

    # Positive when darker than the local background estimate -> ink.
    # A small noise floor is subtracted first so ordinary paper-grain/sensor
    # noise (a few gray levels either side of the local background) stays
    # fully transparent instead of showing up as faint background speckle.
    diff = background_arr - gray
    noise_floor = 8.0
    new_alpha = np.clip(((diff - noise_floor) / feather) * 255.0, 0.0, 255.0)

    arr[..., 3] = new_alpha
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGBA")

    # Tight-crop to the bounding box of high-confidence ink pixels (fully
    # opaque, i.e. diff >= feather) so a single stray noise speck with weak
    # partial opacity can't drag the crop box out wide. The padding below
    # still pulls in the softer feathered edges around the real strokes.
    alpha_arr = np.array(out)[..., 3]
    visible = np.where(alpha_arr >= 250)
    if visible[0].size > 0:
        top, bottom = int(visible[0].min()), int(visible[0].max())
        left, right = int(visible[1].min()), int(visible[1].max())
        left = max(0, left - pad)
        top = max(0, top - pad)
        right = min(out.width - 1, right + pad)
        bottom = min(out.height - 1, bottom + pad)
        out = out.crop((left, top, right + 1, bottom + 1))

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def render_typed_signature_png(text: str, width_pt: float = 420, height_pt: float = 130, font_size: float = 46) -> bytes:
    """Turn typed text into a standalone transparent-background PNG signature,
    so it can be stamped and saved to the signature library exactly like a
    drawn or uploaded one (one unified pipeline downstream)."""
    packet = io.BytesIO()
    c = rl_canvas.Canvas(packet, pagesize=(width_pt, height_pt))
    c.setFont("Helvetica-Oblique", font_size)
    c.drawString(18, (height_pt - font_size) / 2, text)
    c.save()
    packet.seek(0)

    pdf = pdfium.PdfDocument(packet)
    try:
        page = pdf[0]
        bitmap = page.render(scale=3)
        pil_image = bitmap.to_pil().convert("RGBA")
    finally:
        pdf.close()

    # Make near-white background pixels transparent so it overlays cleanly.
    pixels = pil_image.getdata()
    new_pixels = [
        (r, g, b, 0) if (r > 240 and g > 240 and b > 240) else (r, g, b, a)
        for (r, g, b, a) in pixels
    ]
    pil_image.putdata(new_pixels)

    buf = io.BytesIO()
    pil_image.save(buf, format="PNG")
    return buf.getvalue()
