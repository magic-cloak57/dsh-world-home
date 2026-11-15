import sys

from PIL import Image

src, out = sys.argv[1], sys.argv[2]
quality = int(sys.argv[3]) if len(sys.argv) > 3 else 50
maxw = int(sys.argv[4]) if len(sys.argv) > 4 else 320

im = Image.open(src)
w, h = im.size
scale = min(1.0, maxw / max(1, w))
frames, durs, acc = [], [], 0
loop = im.info.get("loop", 0)
try:
    while True:
        acc += int(im.info.get("duration", 100))
        if acc >= 66:
            frames.append(im.convert("RGBA").resize((max(1, int(w * scale)), max(1, int(h * scale)))))
            durs.append(min(acc, 200))
            acc = 0
        im.seek(im.tell() + 1)
except EOFError:
    pass

if not frames:
    raise SystemExit(2)
frames[0].save(out, "WEBP", save_all=True, append_images=frames[1:], duration=durs, loop=loop, quality=quality, method=4)
