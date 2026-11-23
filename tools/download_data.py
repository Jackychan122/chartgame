# -*- coding: utf-8 -*-
"""Build the game's stock data: 20 years of daily OHLCV per ticker from Yahoo Finance.

Usage:  py tools/download_data.py [--only AAPL,MSFT] [--years 20]

Output
  data/<TICKER>.js   window.STOCKS["<TICKER>"] = {d, o, h, l, c, v, x}
                      d  days since 1970-01-01 (UTC)
                      o/h/l/c  price in cents (split-adjusted, as delivered by Yahoo)
                      v  volume in hundreds
                      x  bar indexes at which an uninterrupted segment starts
  data/index.js      window.STOCK_INDEX = { generated, years, stocks: [...] }
                      one metadata row per ticker (name, sector, segment sizes)

The per-ticker files only carry numbers; everything human-readable lives in index.js
so that a ticker file is as small as possible.

Segments
  A price series is not one continuous story: spin-offs, special distributions,
  ticker reuse and broken stretches make the price jump for reasons that are not
  market moves. The script therefore cuts every series into segments at
    1. a gap of more than DAILY_GAP_DAYS calendar days,
    2. a single-day move of at least EXTREME_MOVE,
    3. a distribution (dividend record) worth at least BIG_PAYOUT of the share price,
    4. a split day whose price jump matches neither an adjusted nor an unadjusted series,
    5. a run of at least ZERO_RUN bars with no volume at all.
  The game only deals windows that lie inside one segment.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from universe import UNIVERSE, NAMES  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, "..", "data"))
SNAPSHOT = os.path.join(HERE, "sp500_snapshot.json")

YEARS_BACK = 20
DAILY_GAP_DAYS = 20        # rule 1
EXTREME_MOVE = 0.60        # rule 2
BIG_PAYOUT = 0.08          # rule 3
ZERO_RUN = 3               # rule 5
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


# ------------------------------------------------------------------ fetching

def fetch(ticker, years):
    """Return the parsed chart result, trying both API hosts with backoff."""
    now = int(time.time())
    p1 = now - int(365.25 * years) * 86400
    last_err = None
    for attempt in range(6):
        host = "query%d.finance.yahoo.com" % (1 + attempt % 2)
        url = ("https://%s/v8/finance/chart/%s?period1=%d&period2=%d&interval=1d&events=div%%2Csplit"
               % (host, urllib.request.quote(ticker), p1, now + 86400))
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            res = (data.get("chart") or {}).get("result")
            if not res:
                raise RuntimeError("empty result: %s" % (data.get("chart") or {}).get("error"))
            return res[0]
        except urllib.error.HTTPError as e:
            last_err = "HTTP %d" % e.code
            if e.code == 404:
                break
        except Exception as e:  # network / JSON problems are retried too
            last_err = repr(e)[:120]
        time.sleep(3 + attempt * 4)
    raise RuntimeError("download failed (%s)" % last_err)


# ------------------------------------------------------------------ parsing

def parse(result):
    """Raw API result -> list of [ts, o, h, l, c, v] rows with prices in cents.

    Rows with a missing OHLC value are dropped; the usual float noise around
    high/low is repaired by clamping.
    """
    ts = result["timestamp"]
    q = result["indicators"]["quote"][0]
    rows, dropped, repaired = [], 0, 0
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        v = q["volume"][i]
        if None in (o, h, l, c) or min(o, h, l, c) <= 0:
            dropped += 1
            continue
        o, h, l, c = (round(x * 100) for x in (o, h, l, c))
        if h < max(o, c) or l > min(o, c) or h < l:
            repaired += 1
            h = max(h, o, c)
            l = min(l, o, c)
        rows.append([t, o, h, l, c, int(round((v or 0) / 100.0))])
    rows.sort(key=lambda r: r[0])
    dedup = []
    for r in rows:
        if dedup and dedup[-1][0] == r[0]:
            dedup[-1] = r          # keep the last of duplicate timestamps
        else:
            dedup.append(r)
    return dedup, dropped, repaired


def bar_at(rows, ts):
    """Index of the first bar on or after a UTC timestamp, or None."""
    return next((k for k, r in enumerate(rows) if r[0] >= ts), None)


def check_splits(rows, result, name):
    """Yahoo's OHLC series is adjusted for splits: around a split the price must not
    jump by the split ratio. Returns (problem strings, timestamps to cut at)."""
    problems, cuts = [], []
    for s in (result.get("events") or {}).get("splits", {}).values():
        ratio = s["numerator"] / s["denominator"]
        if abs(ratio - 1) < 0.35:
            continue       # e.g. IBM's 1046:1000 spin-off adjustment: nothing to verify
        j = bar_at(rows, s["date"])
        if not j:
            continue
        jump = rows[j][1] / rows[j - 1][4]
        when = datetime.fromtimestamp(s["date"], timezone.utc).date()
        if abs(jump / ratio - 1) < 0.2:
            problems.append("%s: price jumps x%.2f at %s split x%g - series looks UNADJUSTED"
                            % (name, jump, when, ratio))
        elif abs(jump - 1) > 0.2:
            problems.append("%s: price jumps x%.2f at %s split x%g (expected ~1.0) - cut here"
                            % (name, jump, when, ratio))
            cuts.append(s["date"])
    return problems, cuts


def big_payouts(rows, result, name):
    """Distribution records (dividends) worth at least BIG_PAYOUT of the share price are
    spin-offs / special distributions: the price drops by more than a market move."""
    cuts = []
    for d in (result.get("events") or {}).get("dividends", {}).values():
        j = bar_at(rows, d["date"])
        if not j or rows[j - 1][4] <= 0:
            continue
        if d["amount"] / (rows[j - 1][4] / 100.0) >= BIG_PAYOUT:
            cuts.append(d["date"])
    return cuts


def boundaries(rows, days, event_cuts):
    """Bar indexes at which an uninterrupted segment starts (index 0 excluded)."""
    cuts = set()
    for i in range(1, len(rows)):
        if days[i] - days[i - 1] > DAILY_GAP_DAYS or abs(rows[i][4] / rows[i - 1][4] - 1) >= EXTREME_MOVE:
            cuts.add(i)
    i = 0
    while i < len(rows):                      # runs of zero volume
        if rows[i][5] == 0:
            j = i
            while j + 1 < len(rows) and rows[j + 1][5] == 0:
                j += 1
            if j - i + 1 >= ZERO_RUN:
                cuts.add(i)
                if j + 1 < len(rows):
                    cuts.add(j + 1)
            i = j + 1
        else:
            i += 1
    for ts in event_cuts:
        j = bar_at(rows, ts)
        if j:
            cuts.add(j)
    return sorted(cuts)


def segments(cuts, n):
    """[start, end] index pairs (inclusive) of the segments delimited by `cuts`."""
    starts = [0] + [c for c in cuts if 0 < c < n]
    return [(s, e - 1) for s, e in zip(starts, starts[1:] + [n])]


def longest(segs):
    return max((b - a + 1 for a, b in segs), default=0)


# ------------------------------------------------------------------ weekly

def to_weekly(days, o, h, l, c, v, cuts):
    """Monday-start weeks; mirrors js/data.js weeklyBars() so that the weekly segment sizes in
    index.js match what the game computes. A final bar that stops on a Monday-Thursday belongs to
    a week that is still running, so that week is dropped. A cut later in the week leaves the jump
    inside that weekly bar, which is therefore fenced off on both sides.
    Returns (payload, segment starts in weekly bars)."""
    out = {"d": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    if not days:
        return out, []
    last = date(1970, 1, 1) + timedelta(days=days[-1])
    stop = len(days)
    if last.weekday() <= 3:
        stop -= 1
    cur_week, firsts, weekly_cuts = None, [], set()
    for i in range(stop):
        wk = (days[i] + 3) // 7        # 1970-01-01 was a Thursday
        if wk != cur_week:
            cur_week = wk
            firsts.append(days[i])
            out["d"].append(days[i])
            out["o"].append(o[i])
            out["h"].append(h[i])
            out["l"].append(l[i])
            out["c"].append(c[i])
            out["v"].append(v[i])
        else:
            out["d"][-1] = days[i]
            out["h"][-1] = max(out["h"][-1], h[i])
            out["l"][-1] = min(out["l"][-1], l[i])
            out["c"][-1] = c[i]
            out["v"][-1] += v[i]
        if i in cuts and i > 0:
            weekly_cuts.add(len(out["d"]) - 1)
            if days[i] != firsts[-1]:  # the cut falls mid-week: this weekly bar contains the jump
                weekly_cuts.add(len(out["d"]))
    return out, sorted(weekly_cuts)


# ------------------------------------------------------------------ names

def tidy(name):
    """'Home Depot (The)' -> 'The Home Depot'."""
    name = " ".join(name.split())
    if name.endswith(" (The)"):
        name = "The " + name[:-len(" (The)")]
    return name


def write_index(rows):
    with open(os.path.join(OUT, "index.js"), "w", encoding="utf-8") as f:
        f.write("window.STOCK_INDEX=%s;" % json.dumps(
            {"generated": str(date.today()), "stocks": rows},
            separators=(",", ":"), ensure_ascii=False))


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma separated tickers to (re)build")
    ap.add_argument("--years", type=int, default=YEARS_BACK)
    args = ap.parse_args()

    with open(SNAPSHOT, encoding="utf-8") as f:
        snap = {r["Symbol"]: r for r in json.load(f)}
    os.makedirs(OUT, exist_ok=True)

    todo = UNIVERSE
    if args.only:
        wanted = {t.strip().upper() for t in args.only.split(",")}
        todo = [r for r in UNIVERSE if r[0] in wanted]
        if len(todo) != len(wanted):
            sys.exit("unknown ticker in --only: %s" % sorted(wanted - {r[0] for r in todo}))

    built, problems, fails = {}, [], []
    for n, (sym, disp, zh, sector, sub) in enumerate(todo, 1):
        try:
            result = fetch(sym, args.years)
        except Exception as e:
            fails.append(sym)
            print("[%3d/%d] %-6s FAILED: %s" % (n, len(todo), sym, e), flush=True)
            continue
        rows, dropped, repaired = parse(result)
        if len(rows) < 60:
            fails.append(sym)
            print("[%3d/%d] %-6s FAILED: only %d bars" % (n, len(todo), sym, len(rows)), flush=True)
            continue

        gmt = result["meta"].get("gmtoffset") or -18000
        days = [(t + gmt) // 86400 for t, *_ in rows]
        o = [r[1] for r in rows]
        h = [r[2] for r in rows]
        l = [r[3] for r in rows]
        c = [r[4] for r in rows]
        v = [r[5] for r in rows]

        split_problems, split_cuts = check_splits(rows, result, sym)
        problems += split_problems
        cuts = boundaries(rows, days, split_cuts + big_payouts(rows, result, sym))
        seg_d = segments(cuts, len(rows))
        weekly, wcuts = to_weekly(days, o, h, l, c, v, set(cuts))
        seg_w = segments(wcuts, len(weekly["d"]))

        when = lambda i: str(date(1970, 1, 1) + timedelta(days=days[i]))  # noqa: E731
        if len(seg_d) > 1:
            problems.append("%s: %d segments; longest %d daily / %d weekly bars; cuts at %s"
                            % (sym, len(seg_d), longest(seg_d), longest(seg_w),
                               ", ".join(when(i) for i in cuts)))
        if dropped or repaired:
            problems.append("%s: %d dropped rows, %d repaired rows" % (sym, dropped, repaired))

        payload = {"d": days, "o": o, "h": h, "l": l, "c": c, "v": v, "x": cuts}
        with open(os.path.join(OUT, sym + ".js"), "w", encoding="utf-8") as f:
            f.write('window.STOCKS=window.STOCKS||{};window.STOCKS["%s"]=%s;'
                    % (sym, json.dumps(payload, separators=(",", ":"))))

        member = snap.get(disp)
        built[sym] = {
            "t": sym, "s": disp,
            "n": tidy(member["Security"]) if member else NAMES[sym],
            "z": zh,
            "g": sector or member["GICS Sector"],
            "i": sub or member["GICS Sub-Industry"],
            "sp": 1 if member else 0,
            "b": len(days), "m": longest(seg_d), "w": longest(seg_w),
            "f": when(0), "l": when(len(days) - 1),
        }
        print("[%3d/%d] %-6s %5d bars  %s -> %s  longest %d daily / %d weekly bars"
              % (n, len(todo), sym, len(days), built[sym]["f"], built[sym]["l"],
                 built[sym]["m"], built[sym]["w"]), flush=True)
        time.sleep(0.4)

    rows = list(built.values())
    if args.only:
        # a partial rebuild keeps the rows of the tickers that were not rebuilt
        path = os.path.join(OUT, "index.js")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                old = json.loads(f.read()[len("window.STOCK_INDEX="):].rstrip().rstrip(";"))
            order = {t: k for k, t in enumerate(r[0] for r in UNIVERSE)}
            rows = sorted({**{r["t"]: r for r in old.get("stocks", [])}, **built}.values(),
                          key=lambda r: order.get(r["t"], 999))
    if rows:
        write_index(rows)

    print("\nbuilt %d of %d tickers%s" % (len(built), len(todo), ", failed: %s" % fails if fails else ""))
    if problems:
        print("\nnotes:")
        for p in problems:
            print("  " + p)
    if fails:
        sys.exit(1)


if __name__ == "__main__":
    main()
