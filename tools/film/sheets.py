"""Captioned 3x3 contact sheets from a film.mjs run: python3 sheets.py <film dir>"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
frames = json.loads((root / "frames.json").read_text())
out = root / "sheets"
out.mkdir(exist_ok=True)
COLS, ROWS = 3, 3
TW, TH = 640, 360
try:
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
except OSError:
    font = ImageFont.load_default()
per = COLS * ROWS
for k in range(0, len(frames), per):
    sheet = Image.new("RGB", (COLS * TW, ROWS * TH), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    for j, f in enumerate(frames[k : k + per]):
        im = Image.open(root / "frames" / f["file"]).convert("RGB").resize((TW, TH))
        x, y = (j % COLS) * TW, (j // COLS) * TH
        sheet.paste(im, (x, y))
        text = f"#{f['frame']} t={f['t']:.0f}s s={f['s']:.0f}m {f['kmh']:.0f}km/h {f['phase']} | {f.get('road') or ''} {f.get('level') or ''}"
        d.rectangle([x, y, x + TW, y + 20], fill=(0, 0, 0))
        d.text((x + 4, y + 2), text, fill=(255, 230, 80), font=font)
    sheet.save(out / f"sheet_{k // per:03d}.jpg", quality=82)
print(f"{(len(frames) + per - 1) // per} sheets in {out}")
