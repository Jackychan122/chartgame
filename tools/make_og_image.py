# -*- coding: utf-8 -*-
"""Render og-image.png (1200x630), the preview picture used when the game link is shared.

Usage: python tools/make_og_image.py        (needs Pillow and the Windows fonts below)

This is the only build step that needs a third-party Python package; everything else
(the game, the data build, the tests) runs on the standard library alone.
"""
import os
import random

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "og-image.png"))
W, H = 1200, 630

BG_TOP, BG_BOTTOM = (10, 13, 19), (18, 24, 35)
UP, DOWN, GOLD, BLUE = (46, 189, 133), (246, 70, 93), (240, 185, 11), (76, 141, 255)
TEXT, MUTED = (233, 237, 244), (127, 138, 156)


def font(path, size):
    return ImageFont.truetype(path, size)


def main():
    img = Image.new("RGB", (W, H), BG_TOP)
    px = img.load()
    for y in range(H):                                   # vertical gradient
        t = y / (H - 1)
        row = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        for x in range(W):
            px[x, y] = row
    d = ImageDraw.Draw(img, "RGBA")

    for x in range(0, W, 60):                            # faint chart grid
        d.line([(x, 0), (x, H)], fill=(255, 255, 255, 7))
    for y in range(0, H, 60):
        d.line([(0, y), (W, y)], fill=(255, 255, 255, 7))

    # --- candlesticks on the right: an up-trend with two pull-backs ---
    rnd = random.Random(7)                               # fixed seed: the picture is reproducible
    price, closes = 300.0, []
    steps = [-6, 4, 9, -3, 11, 7, -9, -5, 6, 10, 14, -4, 8, 18, -7, 5, 12, 22, -6, 9, 16, 26, -8, 11, 19, 24]
    for s in steps:
        noise = rnd.uniform(-5, 5)
        o, c = price, price + s + noise
        hi, lo = max(o, c) + rnd.uniform(2, 12), min(o, c) - rnd.uniform(2, 12)
        closes.append((o, hi, lo, c))
        price = c
    x0, dx, bw = 700, 17, 10
    lo_all = min(b[2] for b in closes)
    hi_all = max(b[1] for b in closes)
    def y(v):
        return int(470 - (v - lo_all) / (hi_all - lo_all) * 350)
    for i, (o, hi, lo, c) in enumerate(closes):
        col = UP if c >= o else DOWN
        x = x0 + i * dx
        d.line([(x, y(hi)), (x, y(lo))], fill=col, width=2)
        top, bot = sorted((y(o), y(c)))
        d.rectangle([x - bw // 2, top, x + bw // 2, max(bot, top + 3)], fill=col)

    # equity curves: "buy & hold" (blue) follows the closes; "you" (gold) is a little more volatile
    # and ends on top - it is an illustration, not a real game
    bh = [10000 * b[3] / closes[0][0] for b in closes]
    you = [10000 * (v / 10000) ** 1.18 for v in bh]
    lo_e, hi_e = 9850, max(bh + you) * 1.03
    def ye(v):
        return int(566 - (v - lo_e) / (hi_e - lo_e) * 72)
    pts = lambda arr: [(x0 + i * dx, ye(v)) for i, v in enumerate(arr)]
    d.line(pts(bh), fill=BLUE, width=4)
    d.line(pts(you), fill=GOLD, width=4)

    # --- text on the left ---
    cjk = "C:/Windows/Fonts/msjhbd.ttc"
    d.rounded_rectangle([72, 92, 136, 156], radius=16, fill=(29, 38, 53), outline=(255, 255, 255, 22), width=1)
    for cx, col, top, bot in ((90, UP, 112, 140), (104, DOWN, 102, 130), (118, GOLD, 120, 146)):
        d.line([(cx, top - 6), (cx, bot + 6)], fill=col, width=3)
        d.rectangle([cx - 4, top, cx + 4, bot], fill=col)
    d.text((160, 96), "K線操盤挑戰", font=font(cjk, 40), fill=MUTED)

    d.text((72, 190), "你能打敗", font=font(cjk, 84), fill=TEXT)
    d.text((72, 300), "「買進持有」嗎?", font=font(cjk, 84), fill=GOLD)
    d.text((76, 430), "隨機抽一檔真實美股", font=font(cjk, 30), fill=(180, 189, 204))
    d.text((76, 478), "名稱與日期全部隱藏", font=font(cjk, 30), fill=(180, 189, 204))

    d.line([(700, 600), (732, 600)], fill=GOLD, width=4)
    d.text((742, 582), "你", font=font(cjk, 24), fill=(180, 189, 204))
    d.line([(800, 600), (832, 600)], fill=BLUE, width=4)
    d.text((842, 582), "買進持有", font=font(cjk, 24), fill=(180, 189, 204))
    d.text((72, 568), "本金 $10,000 · 200 檔美股 · 20 年日K", font=font(cjk, 24), fill=MUTED)

    img.save(OUT, optimize=True)
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
