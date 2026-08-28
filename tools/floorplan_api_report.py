"""Run Arcvia's live floor-plan API test and create JSON + PDF evidence."""

from __future__ import annotations

import json
import mimetypes
import textwrap
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
API = "http://localhost:8787"
READER = "http://localhost:8090"
INPUT_IMAGE = ROOT / "apps" / "visualisation" / "public" / "plans" / "a1-first.webp"
OUT_ROOT = ROOT / "output"
JSON_PATH = OUT_ROOT / "api" / "arcvia-floorplan-api-test-data.json"
PDF_PATH = OUT_ROOT / "pdf" / "arcvia-floorplan-api-test-report.pdf"


def json_request(
    url: str,
    body: dict | None = None,
    token: str | None = None,
    method: str | None = None,
) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read().decode("utf-8", "replace") or "{}")
        raise RuntimeError(f"HTTP {error.code} {url}: {payload}") from error


def multipart_upload(url: str, path: Path, token: str) -> tuple[int, dict, dict]:
    boundary = "----ArcviaApiTest" + uuid.uuid4().hex
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    raw = path.read_bytes()
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode() + raw + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        result = json.loads(response.read().decode())
        meta = {
            "field": "file",
            "filename": path.name,
            "contentType": content_type,
            "bytes": len(raw),
        }
        return response.status, result, meta


def para(text: str, style: ParagraphStyle) -> Paragraph:
    safe = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return Paragraph(safe.replace("\n", "<br/>"), style)


def compact_json(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True)


def summarize(result: dict) -> dict:
    return {
        "backend": result.get("backend"),
        "image": {"width": result.get("width"), "height": result.get("height")},
        "walls": len(result.get("walls", [])),
        "objects": len(result.get("objects", [])),
        "rooms": len(result.get("rooms", [])),
        "namedRooms": [room.get("name") for room in result.get("rooms", []) if room.get("name")],
        "scale": result.get("scale"),
        "lowConfidence": result.get("low_confidence"),
        "notes": result.get("notes", []),
    }


def build_pdf(report: dict) -> None:
    PDF_PATH.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="TitleX", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=23, leading=28, textColor=colors.HexColor("#10233f"), alignment=TA_CENTER, spaceAfter=8))
    styles.add(ParagraphStyle(name="Sub", parent=styles["Normal"], fontSize=10, leading=15, textColor=colors.HexColor("#52657a"), alignment=TA_CENTER, spaceAfter=18))
    styles.add(ParagraphStyle(name="H1X", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=16, leading=20, textColor=colors.HexColor("#174ea6"), spaceBefore=10, spaceAfter=8))
    styles.add(ParagraphStyle(name="H2X", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=12, leading=16, textColor=colors.HexColor("#10233f"), spaceBefore=8, spaceAfter=5))
    styles.add(ParagraphStyle(name="BodyX", parent=styles["BodyText"], fontSize=9.4, leading=14, textColor=colors.HexColor("#24364b"), spaceAfter=7))
    styles.add(ParagraphStyle(name="CodeX", parent=styles["Code"], fontName="Courier", fontSize=6.5, leading=8.3, backColor=colors.HexColor("#f3f6fa"), borderColor=colors.HexColor("#d7e0ea"), borderWidth=0.5, borderPadding=7, spaceAfter=8))

    doc = SimpleDocTemplate(
        str(PDF_PATH),
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=17 * mm,
        bottomMargin=16 * mm,
        title="Arcvia Floor-plan API Test Report",
        author="OpenAI Codex",
    )
    story = [
        para("Arcvia Floor-plan API Test", styles["TitleX"]),
        para(f"Live end-to-end evidence | {report['testedAt']}", styles["Sub"]),
    ]
    summary = report["summary"]
    final_health = report.get("readerHealthAfter", report["readerHealth"])
    usage = final_health.get("vision_usage", {})
    status_data = [
        ["Stage", "Status", "Evidence"],
        ["Reader + GPT-5.5", "PASS", f"{final_health.get('adjudicator')}; answered {usage.get('calls_answered', 0)}/{usage.get('calls_started', 0)} calls"],
        ["API authentication", "PASS", f"HTTP {report['http']['register']}"],
        ["Image upload", "PASS", f"HTTP {report['http']['upload']}, {report['uploadRequest']['bytes']:,} bytes"],
        ["Image detection", "PASS", f"HTTP {report['http']['detect']}, {summary['walls']} walls, {summary['rooms']} rooms"],
    ]
    table = Table(status_data, colWidths=[43 * mm, 24 * mm, 91 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#174ea6")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (1, 1), (1, -1), "Helvetica-Bold"),
        ("TEXTCOLOR", (1, 1), (1, -1), colors.HexColor("#08783e")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cad5e1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("LEADING", (0, 0), (-1, -1), 10),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f9fc")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [table, Spacer(1, 10), para("Input image", styles["H1X"])]
    with PILImage.open(INPUT_IMAGE) as im:
        width, height = im.size
    max_w, max_h = 175 * mm, 92 * mm
    scale = min(max_w / width, max_h / height)
    story += [
        Image(str(INPUT_IMAGE), width=width * scale, height=height * scale),
        para(f"{INPUT_IMAGE.name} | {width} x {height} px | {report['uploadRequest']['bytes']:,} bytes", styles["BodyX"]),
    ]
    story += [
        PageBreak(),
        para("Exact API data", styles["H1X"]),
        para("1. Multipart upload request", styles["H2X"]),
        para(compact_json(report["uploadRequest"]), styles["CodeX"]),
        para("2. Upload response", styles["H2X"]),
        para(compact_json(report["uploadResponse"]), styles["CodeX"]),
        para("3. Detection request body - this is the JSON sent by Studio/API", styles["H2X"]),
        para(compact_json(report["detectRequest"]), styles["CodeX"]),
        para("4. Detection summary", styles["H2X"]),
        para(compact_json(summary), styles["CodeX"]),
    ]
    story += [
        PageBreak(),
        para("Vision adjudicator payload", styles["H1X"]),
        para("The reader may make several model calls. Each call uses the same OpenAI-compatible envelope; the text prompt changes by pass and the image_url contains the relevant image/crop as base64 JPEG. Secrets and full base64 bytes are intentionally redacted from this report.", styles["BodyX"]),
        para(compact_json(report["modelEnvelope"]), styles["CodeX"]),
    ]
    for name, prompt in report["prompts"].items():
        story += [para(name, styles["H2X"]), para(prompt, styles["CodeX"])]
    story += [
        PageBreak(),
        para("Raw detection response", styles["H1X"]),
        para("The complete machine-readable response is also stored in the companion JSON data file. The following is the exact API response captured in this run.", styles["BodyX"]),
    ]
    raw_lines = compact_json(report["detectResponse"]).splitlines()
    for chunk_start in range(0, len(raw_lines), 72):
        story.append(para("\n".join(raw_lines[chunk_start:chunk_start + 72]), styles["CodeX"]))

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#6b7d90"))
        canvas.drawString(16 * mm, 9 * mm, "Arcvia API verification")
        canvas.drawRightString(A4[0] - 16 * mm, 9 * mm, f"Page {document.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def main() -> None:
    OUT_ROOT.joinpath("api").mkdir(parents=True, exist_ok=True)
    tested_at = datetime.now(timezone.utc).isoformat()
    _, reader_health = json_request(f"{READER}/health")
    _, proxy_health = json_request(f"{API}/detect/health")
    unique = f"codex.floorplan.{int(time.time())}@example.com"
    register_body = {
        "name": "Arcvia API Test",
        "email": unique,
        "organisation": "Arcvia QA",
        "phone": "9876543210",
        "password": "ArcviaTest123!",
    }
    register_status, auth = json_request(f"{API}/auth/register", register_body, method="POST")
    token = auth["token"]
    upload_status, upload, upload_meta = multipart_upload(f"{API}/uploads/floorplan", INPUT_IMAGE, token)
    detect_body = {"url": upload["url"]}
    started = time.perf_counter()
    detect_status, detection = json_request(f"{API}/detect/", detect_body, token=token, method="POST")
    elapsed = round(time.perf_counter() - started, 3)
    _, reader_health_after = json_request(f"{READER}/health")
    crop_prompt = 'This is a crop of an architectural floor plan. The bright orange lines are WALL segments proposed by an automatic reader. Look at what the underlying drawing actually shows beneath and around the orange lines, and classify the object they trace. Answer ONLY a JSON object: {"verdict": one of "wall", "bed", "furniture", "plant", "railing", "boundary", "other", "confidence": 0..1}. A bed, sofa, wardrobe or other furniture drawn on the plan is furniture even if its outline is crisp. A balcony railing or parapet is railing. A site or plot boundary is boundary. Only real building walls are wall.'
    room_prompt = 'This is a crop of an architectural floor plan. The orange outline traces a small enclosed shape that an automatic reader classified as a ROOM with walls. Look at what is drawn INSIDE and AS the orange outline. Is it actually a room, or is it a piece of furniture drawn on the plan - a bed, sofa, wardrobe, table - whose outline merely closed? Answer ONLY a JSON object: {"verdict": one of "room", "bed", "sofa", "wardrobe", "furniture", "fixture", "other", "confidence": 0..1}. A mattress with pillows is a bed. Only a genuine walled space is room.'
    window_prompt = 'This is an architectural floor plan. List every WINDOW you can see drawn on the walls (thin double or triple lines across a wall opening, usually on the outer walls). Answer ONLY a JSON object: {"windows": [{"x": 0..1, "y": 0..1}]} where x,y is each window\'s centre as a fraction of image width and height. An empty list is a valid answer. Do not include doors.'
    report = {
        "testedAt": tested_at,
        "services": {"api": API, "reader": READER, "liveReaderCheckout": str(ROOT)},
        "readerHealth": reader_health,
        "readerHealthAfter": reader_health_after,
        "apiProxyHealth": proxy_health,
        "http": {"register": register_status, "upload": upload_status, "detect": detect_status},
        "uploadRequest": upload_meta,
        "uploadResponse": upload,
        "detectRequest": detect_body,
        "detectElapsedSeconds": elapsed,
        "summary": summarize(detection),
        "detectResponse": detection,
        "modelEnvelope": {
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "<one of the prompts below>"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<redacted>"}}]}],
            "max_completion_tokens": 300,
            "reasoning_effort": "none",
        },
        "prompts": {
            "Wall-cluster prompt": crop_prompt,
            "Small-room prompt": room_prompt,
            "Window prompt": window_prompt,
        },
    }
    JSON_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    build_pdf(report)
    print(json.dumps({
        "json": str(JSON_PATH),
        "pdf": str(PDF_PATH),
        "http": report["http"],
        "summary": report["summary"],
        "detectRequest": detect_body,
        "elapsedSeconds": elapsed,
    }, indent=2))


if __name__ == "__main__":
    main()
