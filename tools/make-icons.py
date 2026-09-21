#!/usr/bin/env python3
"""Draws the extension icons.

One look, four sizes: a near-black rounded tile with a white bolt. Rendered at
8x and downsampled, so the small sizes stay clean. Run from the extension root:

    python3 tools/make-icons.py
"""

from PIL import Image, ImageDraw

ACCENT = (235, 59, 48, 255)
TOP = (38, 38, 42, 255)
BOTTOM = (18, 18, 20, 255)
WHITE = (255, 255, 255, 255)
SUPERSAMPLE = 8
SIZES = (16, 32, 48, 128)

# Bolt outline in unit coordinates, clockwise from the top.
BOLT = [
    (0.60, 0.07),
    (0.26, 0.55),
    (0.46, 0.55),
    (0.40, 0.94),
    (0.74, 0.45),
    (0.54, 0.45),
]


def rounded_tile(size):
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGBA", (size, size), TOP)
    draw = ImageDraw.Draw(gradient)
    for y in range(size):
        blend = y / max(1, size - 1)
        row = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * blend) for i in range(4))
        draw.line([(0, y), (size, y)], fill=row)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=round(size * 0.235), fill=255
    )
    tile.paste(gradient, (0, 0), mask)
    return tile


def draw_bolt(size):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    points = [(x * size, y * size) for x, y in BOLT]
    draw.polygon(points, fill=WHITE)

    # The accent bar only exists where there is room for it to read as a slash
    # instead of a smudge.
    if size >= 48:
        width = round(size * 0.075)
        draw.line(
            [(size * 0.22, size * 0.80), (size * 0.78, size * 0.20)],
            fill=ACCENT,
            width=width,
        )
    return layer


def render(target):
    big = target * SUPERSAMPLE
    icon = rounded_tile(big)
    icon = Image.alpha_composite(icon, draw_bolt(big))
    return icon.resize((target, target), Image.LANCZOS)


def main():
    for size in SIZES:
        icon = render(size)
        path = f"icons/icon{size}.png"
        icon.save(path)
        print(f"{path}  {icon.size[0]}x{icon.size[1]}  {len(icon.tobytes())} bytes raw")


if __name__ == "__main__":
    main()
