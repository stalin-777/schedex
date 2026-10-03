"""Build the custom VS Code glyph from its editable SVG (requires fonttools)."""

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib import SVGPath


ROOT = Path(__file__).resolve().parent.parent
EM_SIZE = 1024
FONT_NAME = "Schedex Calendar Send"

builder = FontBuilder(EM_SIZE, isTTF=False)
builder.setupGlyphOrder([".notdef", "calendar-send"])
builder.setupCharacterMap({0xE001: "calendar-send"})
builder.setupHorizontalMetrics({".notdef": (EM_SIZE, 0), "calendar-send": (EM_SIZE, 16)})
builder.setupHorizontalHeader(ascent=EM_SIZE, descent=0)
builder.setupNameTable({
    "familyName": FONT_NAME,
    "styleName": "Regular",
    "uniqueFontIdentifier": "SchedexCalendarSend-Regular-1",
    "fullName": FONT_NAME,
    "psName": "SchedexCalendarSend-Regular",
    "version": "Version 1.0",
})
builder.setupOS2(sTypoAscender=EM_SIZE, sTypoDescender=0, usWinAscent=EM_SIZE, usWinDescent=0)
builder.setupPost()

empty = T2CharStringPen(EM_SIZE, None)
glyph = T2CharStringPen(EM_SIZE, None)
SVGPath(ROOT / "scripts/assets/schedex-calendar-send.svg").draw(
    TransformPen(glyph, (1, 0, 0, -1, 0, EM_SIZE))
)
builder.setupCFF("SchedexCalendarSend-Regular", {"FullName": FONT_NAME, "FamilyName": FONT_NAME}, {
    ".notdef": empty.getCharString(),
    "calendar-send": glyph.getCharString(),
}, {})
builder.font["head"].created = builder.font["head"].modified = 2082844800
builder.font.recalcTimestamp = False
builder.font.flavor = "woff"
builder.save(ROOT / "media/schedex-calendar-send.woff")
