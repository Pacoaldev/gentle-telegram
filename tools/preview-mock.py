#!/usr/bin/env python3
"""Build preview.png: a sanitized mock of the Telegram Bridge card.

Why a mock: a real `herdr-app shot` of the open mod carries the session name,
its cwd and whatever the machine's feed holds, and the hub screenshot must not
carry any of that. Values here come from mods/gentle-telegram/tokens.js (hex
fallbacks) and ui.js (sizes, paddings, radii); no bot, session or path is real.

Run: python tools/preview-mock.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

S = 2                      # render at 2x, so the PNG is 960 wide
W = 480                    # the panel's width in CSS px
P = {
    "background": "#0b0a0c", "surface": "#171318", "raised": "#201a21",
    "line": "#2a2229", "lineStrong": "#563040", "text": "#f4eff2",
    "muted": "#a78e9b", "faint": "#76616b", "accent": "#f095c8",
    "ok": "#79c98f", "warn": "#e0c27a", "err": "#ff718f", "info": "#a9c7ee",
}
R = {"card": 10, "chip": 6, "row": 8}
# The app draws with its own UI font; any sans-serif with the same metrics is close
# enough, so the script runs on the machine that has one instead of one OS's folder.
FONT_DIRS = ["C:/Windows/Fonts", "/System/Library/Fonts", "/Library/Fonts",
             "/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/truetype/liberation",
             os.path.expanduser("~/.local/share/fonts")]
FONT_FILES = {"reg": ["segoeui.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf",
                      "Helvetica.ttc", "Arial.ttf"],
              "semi": ["segoeuib.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf",
                       "Helvetica.ttc", "Arial Bold.ttf"]}


def font_path(kind, size):
    for directory in FONT_DIRS:
        for name in FONT_FILES[kind]:
            candidate = os.path.join(directory, name)
            if os.path.exists(candidate):
                return candidate
    return None


def load(kind, size):
    path = font_path(kind, size)
    if path:
        try:
            return ImageFont.truetype(path, size * S)
        except OSError:
            pass
    return ImageFont.load_default(size * S)


F_TITLE = load("semi", 14)
F_CHIP = load("reg", 11)
F_BTN = load("reg", 12)
F_BODY = load("reg", 13)
F_META = load("reg", 11)
F_LOG = load("reg", 12)

HEADER = {"polling": ("polling", "ok"), "idle": ("idle", "muted"),
          "error": ("error", "err"), "checking": ("checking", "info")}
QUESTION = {
    "chip": ("open question", "warn"),
    "meta": "herdr-docs \u00b7 ~/code/herdr-docs",
    "text": "\u00bfReescribo el RECIPE antes del release?",
    "options": ["1. SI", "2. NO"],
}
LOG = [
    ("blocker", "demo-app \u00b7 Corro los tests con --shuffle antes del commit? \u00b7 2 options"),
    ("answered", "1. SI \u2014 the session answered through its own inbox"),
    ("order", "Telegram \u2192 demo-app: corre tambi\u00e9n el lint"),
    ("notice", "check: bot @demo_bridge_bot (id 123456789)"),
    ("blocker", "Sent the open question of herdr-docs \u00b7 2 options"),
    ("answered", "2. NO \u2014 the question was closed in the session"),
    ("error", "Telegram refused getUpdates: 429 Too Many Requests (retry after 3)"),
]
KIND = {"blocker": "warn", "answered": "ok", "order": "info",
        "error": "err", "notice": "muted"}


def tw(d, text, font):
    return d.textlength(text, font=font)


def th(font):
    box = font.getbbox("Ag")
    return box[3] - box[1]


class Pen:
    def __init__(self, img, d):
        self.img, self.d, self.y = img, d, 0

    def chip(self, x, y, text, color):
        h = th(F_CHIP) + 4 * S
        w = tw(self.d, text, F_CHIP) + 12 * S
        self.d.rounded_rectangle([x, y, x + w, y + h], R["chip"] * S, fill=P["raised"])
        self.d.text((x + 6 * S, y + 2 * S), text, font=F_CHIP, fill=P[color])
        return w, h

    def button(self, x, y, label, primary=False, disabled=False):
        h = th(F_BTN) + 8 * S
        w = tw(self.d, label, F_BTN) + 20 * S
        edge = P["accent"] if primary else P["lineStrong"]
        self.d.rounded_rectangle([x, y, x + w, y + h], R["chip"] * S,
                                 fill=P["accent"] if primary else P["raised"],
                                 outline=edge, width=1 * S)
        self.d.text((x + 10 * S, y + 4 * S), label, font=F_BTN,
                    fill=P["background"] if primary else P["text"])
        if disabled:
            box = self.img.crop((int(x), int(y), int(x + w), int(y + h)))
            self.img.paste(Image.blend(box, Image.new("RGB", box.size, P["raised"]), 0.55), (int(x), int(y)))
        return w, h


def build(img, d):
    pen = Pen(img, d)
    x0, y = 14 * S, 12 * S

    # header, row 1: title left, chips right (title has flex_1 in the view)
    chips = [HEADER["polling"][0], "24 seen", "9 answered", "5 orders"]
    colors = [HEADER["polling"][1], "muted", "ok", "info"]
    widths = [tw(d, c, F_CHIP) + 12 * S for c in chips]
    cx = W * S - 14 * S - sum(widths) - 6 * S * (len(chips) - 1)
    d.text((x0, y + 1 * S), "Telegram Bridge", font=F_TITLE, fill=P["text"])
    for c, col, w in zip(chips, colors, widths):
        pen.chip(cx, y, c, col)
        cx += w + 6 * S
    y += max(th(F_TITLE) + 2 * S, th(F_CHIP) + 4 * S) + 6 * S

    # header, row 2: the three buttons
    for label, primary, disabled in [("Stop polling", False, False),
                                     ("Check token", False, False),
                                     ("Forget the learned chat", False, False)]:
        w, _ = pen.button(x0, y, label, primary, disabled)
        x0 += w + 6 * S
    y += th(F_BTN) + 8 * S + 8 * S

    # body: the open question, then the log
    x0 = 14 * S
    bw = W * S - 28 * S
    pad = 10 * S
    qh = 8 * S + (th(F_CHIP) + 4 * S) + 6 * S + th(F_BODY) + 6 * S + (th(F_BTN) + 8 * S) + 8 * S
    d.rounded_rectangle([x0, y, x0 + bw, y + qh], R["card"] * S, fill=P["raised"],
                        outline=P["warn"], width=1 * S)
    qy = y + 8 * S
    w, h = pen.chip(x0 + pad, qy, *QUESTION["chip"])
    d.text((x0 + pad + w + 6 * S, qy + 2 * S), QUESTION["meta"], font=F_META, fill=P["muted"])
    qy += h + 6 * S
    d.text((x0 + pad, qy), QUESTION["text"], font=F_BODY, fill=P["text"])
    qy += th(F_BODY) + 6 * S
    bx = x0 + pad
    for label in QUESTION["options"]:
        w, _ = pen.button(bx, qy, label)
        bx += w + 6 * S
    y += qh + 10 * S

    # log: time (60px), kind chip, one truncated line
    for index, (kind, text) in enumerate(LOG):
        d.text((x0, y + 2 * S), "10:%02d:%02d" % (12 + index, (index * 17) % 60),
               font=F_META, fill=P["faint"])
        w, h = pen.chip(x0 + 60 * S + 8 * S, y, kind, KIND[kind])
        tx = x0 + 60 * S + 8 * S + w + 8 * S
        room = x0 + bw - tx
        line = text
        while tw(d, line, F_LOG) > room and len(line) > 8:
            line = line[:-2]
        if line != text:
            line = line[:-1] + "\u2026"
        d.text((tx, y + 1 * S), line, font=F_LOG, fill=P["muted"])
        y += max(h, th(F_LOG) + 3 * S) + 2 * S

    # composer: top border, input box, Send
    y += 10 * S
    d.line([0, y, W * S, y], fill=P["line"], width=1 * S)
    y += 10 * S
    box_h = th(F_BODY) + 12 * S
    send_w = tw(d, "Send", F_BTN) + 20 * S
    d.rounded_rectangle([x0, y, x0 + bw - send_w - 8 * S, y + box_h], R["row"] * S,
                        fill=P["raised"], outline=P["lineStrong"], width=1 * S)
    d.text((x0 + 8 * S, y + 6 * S), "Order for the shown Gentle Shell\u2026",
           font=F_BODY, fill=P["faint"])
    pen.button(x0 + bw - send_w, y, "Send", primary=True)
    y += box_h + 10 * S
    return int(y)


def main():
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    h = build(Image.new("RGB", (W * S, 1)), probe)
    img = Image.new("RGB", (W * S, h), P["background"])
    build(img, ImageDraw.Draw(img))
    img.save("preview.png")
    print("preview.png", img.size)


if __name__ == "__main__":
    main()
