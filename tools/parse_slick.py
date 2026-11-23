# -*- coding: utf-8 -*-
"""Parse the slickcharts.com/sp500 weight table into JSON.

Usage: py -I tools/parse_slick.py <page.html> <out.json>
Output rows: {"rank": 1, "t": "AAPL", "n": "Apple Inc", "w": 6.92}
"""
import json
import sys
from html.parser import HTMLParser


class TableParser(HTMLParser):
    """Collects every <table> as {"head": [...], "rows": [[...], ...]}."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self.cur = None
        self.in_row = False
        self.in_cell = False
        self.is_head = False
        self.buf = []
        self.row = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.cur = {"head": [], "rows": []}
            self.tables.append(self.cur)
        elif tag == "tr" and self.cur is not None:
            self.in_row, self.row = True, []
        elif tag in ("td", "th") and self.in_row:
            self.in_cell, self.is_head, self.buf = True, tag == "th", []

    def handle_endtag(self, tag):
        if tag == "table":
            self.cur = None
        elif tag in ("td", "th") and self.in_cell:
            self.in_cell = False
            (self.cur["head"] if self.is_head else self.row).append("".join(self.buf))
        elif tag == "tr" and self.in_row:
            self.in_row = False
            if self.row:
                self.cur["rows"].append(self.row)

    def handle_data(self, data):
        if self.in_cell:
            self.buf.append(data)


def main(src, dst):
    p = TableParser()
    with open(src, encoding="utf-8") as f:
        p.feed(f.read())
    table = next((t for t in p.tables if "Weight" in t["head"] and "Symbol" in t["head"]), None)
    if table is None:
        sys.exit("weight table not found")
    out = []
    for cells in table["rows"]:
        if len(cells) < 4:
            continue
        out.append({
            "rank": int(cells[0]),
            "n": cells[1].strip(),
            "t": cells[2].strip(),
            "w": float(cells[3].rstrip("%")),
        })
    if len(out) < 400 or len({r["t"] for r in out}) != len(out):
        sys.exit("unexpected rows: %d" % len(out))
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    print("rows:", len(out), "| first:", out[0], "| last:", out[-1])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
