# -*- coding: utf-8 -*-
"""Parse the Wikipedia "List of S&P 500 companies" page into JSON.

Usage: py -I tools/parse_sp500.py <page.html> <out.json>
"""
import json
import sys
from html.parser import HTMLParser

WANT = ["Symbol", "Security", "GICS Sector", "GICS Sub-Industry",
        "Headquarters Location", "Date first added", "Founded"]


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_table = False      # inside the constituents table
        self.depth = 0             # table nesting depth
        self.in_row = False
        self.in_cell = False
        self.cell_is_header = False
        self.buf = []
        self.row = []
        self.rows = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            if self.in_table:
                self.depth += 1
            elif a.get("id") == "constituents":
                self.in_table = True
                self.depth = 1
        elif self.in_table and tag == "tr":
            self.in_row = True
            self.row = []
        elif self.in_table and self.in_row and tag in ("td", "th"):
            self.in_cell = True
            self.cell_is_header = tag == "th"
            self.buf = []
        elif self.in_table and self.in_cell and tag == "br":
            self.buf.append(" ")

    def handle_endtag(self, tag):
        if not self.in_table:
            return
        if tag == "table":
            self.depth -= 1
            if self.depth == 0:
                self.in_table = False
        elif tag in ("td", "th") and self.in_cell:
            self.in_cell = False
            self.row.append(("".join(self.buf), self.cell_is_header))
        elif tag == "tr" and self.in_row:
            self.in_row = False
            if self.row:
                self.rows.append(self.row)

    def handle_data(self, data):
        if self.in_table and self.in_cell:
            self.buf.append(data)


def clean(s):
    return " ".join(s.replace("\xa0", " ").split())


def main(src, dst):
    p = TableParser()
    with open(src, encoding="utf-8") as f:
        p.feed(f.read())
    header, out = None, []
    for row in p.rows:
        cells = [clean(c) for c, _ in row]
        if header is None:
            if cells and cells[0] == "Symbol":
                header = cells
            continue
        if len(cells) != len(header):
            print("skip row with %d cells: %s" % (len(cells), cells[:3]), file=sys.stderr)
            continue
        rec = dict(zip(header, cells))
        out.append({k: rec.get(k, "") for k in WANT})
    if header is None or not out:
        sys.exit("constituents table not found")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    print("rows:", len(out))
    print("header:", header)
    sectors = sorted({r["GICS Sector"] for r in out})
    print("sectors (%d):" % len(sectors))
    for s in sectors:
        print("  %-24s %d" % (s, sum(1 for r in out if r["GICS Sector"] == s)))
    syms = [r["Symbol"] for r in out]
    print("unique symbols:", len(set(syms)), "dups:", [s for s in set(syms) if syms.count(s) > 1])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
