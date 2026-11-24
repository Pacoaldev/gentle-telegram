#!/usr/bin/env python3
"""Build preview.png: a sanitized mock of the Telegram Bridge card.

Why a mock: a real `herdr-app shot` of the open mod carries the session name,
its cwd and whatever the machine's feed holds, and the hub screenshot must not
carry any of that. Values here match Herdr's Graphite theme and the sizes,
paddings, and radii in mods/gentle-telegram/ui.js; no bot, session or path is real.

Run: python tools/preview-mock.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

S = 2                      # render at 2x, so the PNG is 960 wide
W = 480                    # the panel's width in CSS px
P = {
    "background": "#16181d",
    "surface": "#1c1f26",
    "raised": "#232730",
    "line": "#2c313c",
    "lineStrong": "#3b4252",
    "text": "#e6e9ef",
    "muted": "#9aa3b2",
    "faint": "#6c7484",
    "accent": "#6ea8fe",
    "ok": "#79c98f",
    "warn": "#df8e75",
    "err": "#f07178",
    "info": "#7eb6f7",
}
R = {"card": 10, "chip": 6, "row": 8}

FONT_DIRS = [
    "C:/Windows/Fonts",
    "/System/Library/Fonts",
    "/Library/Fonts",
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/truetype/liberation",
    os.path.expanduser("~/.local/share/fonts"),
]
FONT_FILES = {
    "reg": ["segoeui.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Helvetica.ttc", "Arial.ttf"],
    "semi": ["segoeuib.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "Helvetica.ttc", "Arial Bold.ttf"],
}


def font_path(kind):
    for directory in FONT_DIRS:
        for name in FONT_FILES[kind]:
            candidate = os.path.join(directory, name)
            if os.path.exists(candidate):
                return candidate
    return None


def load(kind, size):
    path = font_path(kind)
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

HEADER = {
    "polling": ("polling", "ok"),
    "idle": ("idle", "muted"),
    "error": ("error", "err"),
    "checking": ("checking", "info"),
}
QUESTION = {
    "chip": ("open question", "warn"),
    "meta": "demo-app · ~/projects/demo-app",
    "text": "Run the full test suite before creating the release tag?",
    "options": ["1. Yes, run tests", "2. Skip for now", "3. Cancel"],
}
LOG = [
    ("blocker", "demo-app · Run the full test suite before creating the release tag?"),
    ("answered", "1. Yes, run tests — answered through session inbox"),
    ("order", "Telegram -> demo-app: check git status after tests"),
    ("notice", "Token is good: @demo_bridge_bot"),
    ("blocker", "herdr-docs · Update RECIPE.md with new shortcut?"),
    ("answered", "1. Yes — answered through session inbox"),
    ("order", "Telegram -> herdr-docs: run herdr-app check"),
]
KIND = {"blocker": "warn", "answered": "ok", "order": "info", "error": "err", "notice": "muted"}


def tw(d, text, font):
    return d.textlength(text, font=font)


def metrics(font):
    ascent, descent = font.getmetrics()
    return ascent + descent


def draw_centered_text(d, box, text, font, fill):
    """Center text vertically inside [x0, y0, x1, y1] using visual ink bounds."""
    x0, y0, x1, y1 = box
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    d.text((cx, cy), text, font=font, fill=fill, anchor="mm")


class Pen:
    def __init__(self, img, d):
        self.img, self.d = img, d

    def chip(self, x, y, text, color, bg=None):
        h = 20 * S
        w = tw(self.d, text, F_CHIP) + 14 * S
        self.d.rounded_rectangle([x, y, x + w, y + h], R["chip"] * S, fill=bg or P["raised"], outline=P["line"], width=1 * S)
        draw_centered_text(self.d, [x, y, x + w, y + h], text, F_CHIP, P[color])
        return w, h

    def button(self, x, y, label, primary=False, disabled=False):
        h = 26 * S
        w = tw(self.d, label, F_BTN) + 20 * S
        edge = P["accent"] if primary else P["lineStrong"]
        fill = P["accent"] if primary else P["raised"]
        fg = P["background"] if primary else P["text"]
        self.d.rounded_rectangle([x, y, x + w, y + h], R["chip"] * S, fill=fill, outline=edge, width=1 * S)
        draw_centered_text(self.d, [x, y, x + w, y + h], label, F_BTN, fg)
        if disabled:
            box = self.img.crop((int(x), int(y), int(x + w), int(y + h)))
            self.img.paste(Image.blend(box, Image.new("RGB", box.size, P["raised"]), 0.55), (int(x), int(y)))
        return w, h


def build(img, d):
    pen = Pen(img, d)
    x0, y = 14 * S, 12 * S

    # Header row 1: title left, chips + close button right
    close_sz = 22 * S
    chips = [HEADER["polling"][0], "12 seen", "8 answered", "4 orders"]
    colors = [HEADER["polling"][1], "muted", "ok", "info"]
    widths = [tw(d, c, F_CHIP) + 14 * S for c in chips]
    total_right = sum(widths) + 6 * S * len(chips) + close_sz
    cx = W * S - 14 * S - total_right
    d.text((x0, y + 10 * S), "Telegram Bridge", font=F_TITLE, fill=P["text"], anchor="lm")
    for c, col, w in zip(chips, colors, widths):
        pen.chip(cx, y, c, col)
        cx += w + 6 * S
    draw_centered_text(d, [cx, y, cx + close_sz, y + 20 * S], "×", F_TITLE, P["muted"])
    y += 28 * S

    # Header row 2: action buttons
    bx = x0
    for label in ["Stop polling", "Check token", "Forget the learned chat"]:
        w, _ = pen.button(bx, y, label)
        bx += w + 6 * S
    y += 26 * S + 10 * S

    # Open question card
    bw = W * S - 28 * S
    pad = 12 * S
    line_h = metrics(F_BODY)
    qh = 10 * S + 20 * S + 8 * S + line_h + 10 * S + 26 * S + 10 * S
    d.rounded_rectangle([x0, y, x0 + bw, y + qh], R["card"] * S, fill=P["surface"], outline=P["warn"], width=1 * S)
    qy = y + 10 * S
    w, h = pen.chip(x0 + pad, qy, *QUESTION["chip"], bg=P["raised"])
    d.text((x0 + pad + w + 8 * S, qy + h / 2), QUESTION["meta"], font=F_META, fill=P["muted"], anchor="lm")
    qy += h + 8 * S
    d.text((x0 + pad, qy + line_h / 2), QUESTION["text"], font=F_BODY, fill=P["text"], anchor="lm")
    qy += line_h + 10 * S
    ox = x0 + pad
    for label in QUESTION["options"]:
        w, _ = pen.button(ox, qy, label)
        ox += w + 6 * S
    y += qh + 12 * S

    # Log rows
    for index, (kind, text) in enumerate(LOG):
        row_h = 20 * S
        cy = y + row_h / 2
        d.text((x0, cy), "14:%02d:%02d" % (10 + index * 2, (index * 17) % 60), font=F_META, fill=P["faint"], anchor="lm")
        w, _ = pen.chip(x0 + 56 * S + 8 * S, y, kind, KIND[kind])
        tx = x0 + 56 * S + 8 * S + w + 8 * S
        room = x0 + bw - tx
        line = text
        while tw(d, line, F_LOG) > room and len(line) > 8:
            line = line[:-2]
        if line != text:
            line = line[:-1] + "…"
        d.text((tx, cy), line, font=F_LOG, fill=P["muted"], anchor="lm")
        y += row_h + 4 * S

    # Composer
    y += 8 * S
    d.line([0, y, W * S, y], fill=P["line"], width=1 * S)
    y += 10 * S
    box_h = 30 * S
    send_w = tw(d, "Send", F_BTN) + 20 * S
    d.rounded_rectangle(
        [x0, y, x0 + bw - send_w - 8 * S, y + box_h],
        R["row"] * S,
        fill=P["raised"],
        outline=P["lineStrong"],
        width=1 * S,
    )
    d.text((x0 + 10 * S, y + box_h / 2), "Order for the shown Gentle Shell…", font=F_BODY, fill=P["faint"], anchor="lm")
    pen.button(x0 + bw - send_w, y + 2 * S, "Send", primary=True)
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
