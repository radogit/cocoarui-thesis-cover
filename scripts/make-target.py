#!/usr/bin/env python3
"""Turn a book-cover photo/scan into an 8th Wall planar image target.

Usage:  python3 scripts/make-target.py path/to/cover.jpg [--name book-cover]

Writes into src/targets/:
  <name>-cover.jpg     the full cover after border trimming (reference: layers should match it)
  <name>.jpg           480x640 grayscale crop that 8th Wall tracks
  <name>.json          target config, with the full cover size stored in "metadata"

8th Wall planar targets must be 3:4 portrait. Most covers are narrower (about 2:3),
so the crop is the largest centered 3:4 area of the cover. The portal still fills the
whole cover: metadata.coverWidth / coverHeight give the cover size in crop-height units,
which the app uses to size the portal frame.

Use a flat, straight-on image of the cover. A dark/black border around the cover (e.g. from an
export or a scan) is trimmed automatically; pass --no-trim to keep the image as is.
The input file is never modified.
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageOps

TARGET_W, TARGET_H = 480, 640
ASPECT = TARGET_W / TARGET_H  # 0.75

parser = argparse.ArgumentParser()
parser.add_argument('cover')
parser.add_argument('--name', default='book-cover')
parser.add_argument('--no-trim', action='store_true', help='do not trim a dark border')
parser.add_argument('--trim-threshold', type=int, default=24,
                    help='pixels darker than this (0-255 luminance) count as border')
args = parser.parse_args()

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(root, 'src', 'targets')
os.makedirs(out_dir, exist_ok=True)

img = ImageOps.exif_transpose(Image.open(args.cover)).convert('RGB')
src_w, src_h = img.size
if not args.no_trim:
    # Bounding box of everything that is not near-black.
    mask = img.convert('L').point(lambda v: 255 if v > args.trim_threshold else 0)
    bbox = mask.getbbox()
    if bbox and bbox != (0, 0, src_w, src_h):
        img = img.crop(bbox)
        print(f'trimmed border: {src_w}x{src_h}px -> {img.size[0]}x{img.size[1]}px (box {bbox})')
W, H = img.size
if W > H:
    print('warning: image is landscape; expected a portrait book cover', file=sys.stderr)

# Largest centered 3:4 crop.
if W / H < ASPECT:   # cover narrower than 3:4 -> full width, trim top/bottom
    cw, ch = W, round(W / ASPECT)
else:                # cover wider than 3:4 -> full height, trim sides
    cw, ch = round(H * ASPECT), H
left, top = (W - cw) // 2, (H - ch) // 2
crop = img.crop((left, top, left + cw, top + ch))

crop.convert('L').resize((TARGET_W, TARGET_H), Image.LANCZOS).save(
    os.path.join(out_dir, f'{args.name}.jpg'), quality=92)
img.save(os.path.join(out_dir, f'{args.name}-cover.jpg'), quality=92)

k = TARGET_H / ch  # original px -> 480x640 crop space
config = {
    'imagePath': f'targets/{args.name}.jpg',
    'metadata': {
        # Full cover size in units of the tracked crop's height (the crop is centered on the cover).
        'coverWidth': round(W / ch, 4),
        'coverHeight': round(H / ch, 4),
    },
    'name': args.name,
    'type': 'PLANAR',
    'properties': {
        'left': round(left * k),
        'top': round(top * k),
        'width': TARGET_W,
        'height': TARGET_H,
        'originalWidth': round(W * k),
        'originalHeight': round(H * k),
        'isRotated': False,
    },
}
with open(os.path.join(out_dir, f'{args.name}.json'), 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')

print(f'cover {W}x{H}px -> crop {cw}x{ch}px at ({left},{top})')
print(f'wrote src/targets/{args.name}.jpg / .json  (cover {config["metadata"]["coverWidth"]} x '
      f'{config["metadata"]["coverHeight"]} crop-heights)')
