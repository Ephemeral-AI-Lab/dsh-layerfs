#!/usr/bin/env python3
"""Builds the dsh LayerFS tab's agent avatars from the sharky_maid assets.

Usage: python3 dsh/sim/avatars/build.py [path/to/dsh/assets/sharky_maid]

Reads the 512x512 transparent PNGs (one folder per character) and writes,
next to this script:
  <id>.png    one sprite sheet per character: its poses side by side, each
              frame FRAME_W x FRAME_H, all trimmed to one shared box so the
              character does not jump between poses
  heads.png   one square head crop per character, side by side (agent tags)
  avatars.js  window.DSH_AVATARS: frame size, and per character its poses,
              head index and a text colour sampled from its hair
  ellen_joe.gif  her expressions in turn, in generation.json's order and at
              ellen_joe/ellen_joe.gif's pace, trimmed and scaled to a
              PORTRAIT square with a transparent background (that GIF's
              own background is white), for the dsh LayerFS page

Variant 1 has expressions only (no idle, run or laptop), so it is skipped.
ellen_joe is the main agent; her poses are expressions.
"""
import colorsys
import json
import os
import sys
from collections import Counter

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "dsh", "assets", "sharky_maid")
FRAME_W, FRAME_H, HEAD = 72, 96, 64  # 2x the CSS size: 36x48 frames, 32 px heads
VARIANT_POSES = ["idle", "run", "laptop", "read", "cheer", "heart", "sleep", "wave", "serve_tea", "arms_open"]
ELLEN_POSES = ["happy", "thinking", "thumbs_up", "surprised", "crying", "angry", "smug", "sleepy", "shy", "love"]
SKIP = {"1"}
PORTRAIT = 176  # 2x the CSS size: 88 px


def characters():
    out = [("ellen_joe", ELLEN_POSES)]
    numbered = sorted((d for d in os.listdir(SRC) if d.isdigit() and d not in SKIP), key=int)
    for d in numbered:
        if all(os.path.exists(os.path.join(SRC, d, p + ".png")) for p in VARIANT_POSES):
            out.append((d, VARIANT_POSES))
    return out


def union_box(images):
    boxes = [im.getchannel("A").getbbox() for im in images]
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def fit(im, w, h):
    """Scales into w x h keeping the aspect ratio, bottom-centred (feet on the ground)."""
    scale = min(w / im.width, h / im.height)
    small = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    frame = Image.new("RGBA", (w, h))
    frame.alpha_composite(small, ((w - small.width) // 2, h - small.height))
    return frame


def head_crop(im):
    """A square around the head: the top of the content box, centred on the
    opaque columns of its upper part."""
    left, top, right, bottom = im.getchannel("A").getbbox()
    side = int((bottom - top) * 0.6)
    alpha = im.getchannel("A").crop((left, top, right, top + side))
    cols = [x for x in range(alpha.width) if any(alpha.getpixel((x, y)) > 200 for y in range(0, alpha.height, 4))]
    cx = left + (cols[0] + cols[-1]) // 2 if cols else (left + right) // 2
    x0 = max(0, min(im.width - side, cx - side // 2))
    return im.crop((x0, top, x0 + side, top + side)).resize((HEAD, HEAD), Image.LANCZOS)


def hair_colour(im):
    """The most common saturated hue in the top third of the character, as a
    colour dark enough to read as text on a light background."""
    left, top, right, bottom = im.getchannel("A").getbbox()
    region = im.crop((left, top, right, top + (bottom - top) // 3)).convert("RGBA")
    bins, sums = Counter(), {}
    raw = region.tobytes()
    for i in range(0, len(raw), 4):
        r, g, b, a = raw[i:i + 4]
        if a < 200:
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if v < 0.18 or (s < 0.12 and v > 0.85):  # outlines and the white headband
            continue
        key = (round(h * 24) % 24, s >= 0.12)
        bins[key] += 1
        acc = sums.setdefault(key, [0, 0, 0])
        acc[0] += r; acc[1] += g; acc[2] += b
    key, n = bins.most_common(1)[0]
    r, g, b = (c / n / 255 for c in sums[key])
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = min(max(l, 0.34), 0.5)
    s = s if s < 0.12 else max(s, 0.45)
    return "#%02x%02x%02x" % tuple(round(c * 255) for c in colorsys.hls_to_rgb(h, l, s))


def save(im, path):
    """A 256-colour palette with alpha: the flat chibi shading keeps, at a quarter of the size."""
    im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(path, optimize=True)


def gif_frame(im):
    """A palette frame whose index 255 is transparent (alpha under half)."""
    frame = im.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    frame.paste(255, mask=im.getchannel("A").point(lambda a: 255 if a < 128 else 0))
    return frame


def portrait_gif():
    folder = os.path.join(SRC, "ellen_joe")
    with open(os.path.join(folder, "generation.json")) as f:
        order = [e["file"] for e in json.load(f)["expressions"]]
    pace = Image.open(os.path.join(folder, "ellen_joe.gif")).info.get("duration", 750)
    images = [Image.open(os.path.join(folder, name)).convert("RGBA") for name in order]
    durations = [pace] * len(images)
    box = union_box(images)
    frames = [gif_frame(fit(im.crop(box), PORTRAIT, PORTRAIT)) for im in images]
    path = os.path.join(HERE, "ellen_joe.gif")
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=durations, loop=0, disposal=2, transparency=255)
    return len(frames)


def main():
    chars, heads = {}, []
    for cid, poses in characters():
        images = [Image.open(os.path.join(SRC, cid, p + ".png")).convert("RGBA") for p in poses]
        box = union_box(images)
        sheet = Image.new("RGBA", (FRAME_W * len(poses), FRAME_H))
        for i, im in enumerate(images):
            sheet.alpha_composite(fit(im.crop(box), FRAME_W, FRAME_H), (i * FRAME_W, 0))
        save(sheet, os.path.join(HERE, f"{cid}.png"))
        heads.append(head_crop(images[0]))
        chars[cid] = {"sheet": f"avatars/{cid}.png", "poses": poses, "head": len(heads) - 1, "color": hair_colour(images[0])}
    strip = Image.new("RGBA", (HEAD * len(heads), HEAD))
    for i, h in enumerate(heads):
        strip.alpha_composite(h, (i * HEAD, 0))
    save(strip, os.path.join(HERE, "heads.png"))
    data = {"frame": {"w": FRAME_W // 2, "h": FRAME_H // 2}, "head": HEAD // 2, "heads": "avatars/heads.png", "main": "ellen_joe", "chars": chars}
    with open(os.path.join(HERE, "avatars.js"), "w") as f:
        f.write("// Generated by build.py from dsh/assets/sharky_maid. Do not edit.\n")
        f.write("window.DSH_AVATARS = " + json.dumps(data, indent=1) + ";\n")
    print(f"{len(chars)} characters, ellen_joe.gif ({portrait_gif()} frames) -> {HERE}")
    for cid, c in chars.items():
        print(f"  {cid:10} {c['color']}  {len(c['poses'])} poses")


if __name__ == "__main__":
    main()
