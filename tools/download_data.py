# -*- coding: utf-8 -*-
"""Download daily OHLCV history for a list of US stocks from Yahoo Finance
and emit per-ticker JSONP-style .js files + an index manifest for the game.

Usage: py download_data.py
Output: ../data/<TICKER>.js and ../data/index.js
"""
import json
import time
import urllib.request
import os
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "data"))

YEARS_BACK = 15          # keep the most recent N years
API = ("https://query{h}.finance.yahoo.com/v8/finance/chart/{t}"
       "?period1={p1}&period2={p2}&interval=1d")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# ticker -> (english name, chinese name, sector)
TICKERS = {
    "AAPL":  ("Apple Inc.", "蘋果", "科技"),
    "MSFT":  ("Microsoft Corp.", "微軟", "科技"),
    "GOOGL": ("Alphabet Inc. (Google)", "谷歌", "科技"),
    "AMZN":  ("Amazon.com Inc.", "亞馬遜", "科技"),
    "META":  ("Meta Platforms Inc.", "Meta", "科技"),
    "NVDA":  ("NVIDIA Corp.", "輝達", "半導體"),
    "TSLA":  ("Tesla Inc.", "特斯拉", "汽車"),
    "NFLX":  ("Netflix Inc.", "網飛", "科技"),
    "INTC":  ("Intel Corp.", "英特爾", "半導體"),
    "AMD":   ("Advanced Micro Devices", "超微", "半導體"),
    "MU":    ("Micron Technology", "美光", "半導體"),
    "QCOM":  ("QUALCOMM Inc.", "高通", "半導體"),
    "TXN":   ("Texas Instruments", "德州儀器", "半導體"),
    "AVGO":  ("Broadcom Inc.", "博通", "半導體"),
    "ORCL":  ("Oracle Corp.", "甲骨文", "科技"),
    "CRM":   ("Salesforce Inc.", "賽富時", "科技"),
    "ADBE":  ("Adobe Inc.", "奧多比", "科技"),
    "CSCO":  ("Cisco Systems", "思科", "科技"),
    "IBM":   ("IBM Corp.", "IBM", "科技"),
    "HPQ":   ("HP Inc.", "惠普", "科技"),
    "DELL":  ("Dell Technologies", "戴爾", "科技"),
    "KO":    ("Coca-Cola Co.", "可口可樂", "消費"),
    "PEP":   ("PepsiCo Inc.", "百事", "消費"),
    "MCD":   ("McDonald's Corp.", "麥當勞", "消費"),
    "SBUX":  ("Starbucks Corp.", "星巴克", "消費"),
    "NKE":   ("Nike Inc.", "耐吉", "消費"),
    "DIS":   ("Walt Disney Co.", "迪士尼", "娛樂"),
    "PG":    ("Procter & Gamble", "寶僑", "消費"),
    "WMT":   ("Walmart Inc.", "沃爾瑪", "零售"),
    "COST":  ("Costco Wholesale", "好市多", "零售"),
    "TGT":   ("Target Corp.", "塔吉特", "零售"),
    "JPM":   ("JPMorgan Chase", "摩根大通", "金融"),
    "BAC":   ("Bank of America", "美國銀行", "金融"),
    "GS":    ("Goldman Sachs", "高盛", "金融"),
    "V":     ("Visa Inc.", "Visa", "金融"),
    "MA":    ("Mastercard Inc.", "萬事達", "金融"),
    "AXP":   ("American Express", "美國運通", "金融"),
    "JNJ":   ("Johnson & Johnson", "嬌生", "醫療"),
    "PFE":   ("Pfizer Inc.", "輝瑞", "醫療"),
    "MRK":   ("Merck & Co.", "默克", "醫療"),
    "UNH":   ("UnitedHealth Group", "聯合健康", "醫療"),
    "ABBV":  ("AbbVie Inc.", "艾伯維", "醫療"),
    "XOM":   ("Exxon Mobil", "艾克森美孚", "能源"),
    "CVX":   ("Chevron Corp.", "雪佛龍", "能源"),
    "CAT":   ("Caterpillar Inc.", "開拓重工", "工業"),
    "BA":    ("Boeing Co.", "波音", "工業"),
    "GE":    ("GE Aerospace", "奇異", "工業"),
    "F":     ("Ford Motor Co.", "福特", "汽車"),
    "T":     ("AT&T Inc.", "AT&T", "電信"),
    "VZ":    ("Verizon Communications", "威訊", "電信"),
    "LUV":   ("Southwest Airlines", "西南航空", "航空"),
    "DAL":   ("Delta Air Lines", "達美航空", "航空"),
    "AAL":   ("American Airlines", "美國航空", "航空"),
    "CCL":   ("Carnival Corp.", "嘉年華郵輪", "觀光"),
    "RCL":   ("Royal Caribbean", "皇家加勒比", "觀光"),
    "GME":   ("GameStop Corp.", "GameStop", "零售"),
    "AMC":   ("AMC Entertainment", "AMC娛樂", "娛樂"),
    "PLTR":  ("Palantir Technologies", "Palantir", "科技"),
    "SNAP":  ("Snap Inc.", "Snap", "科技"),
    "PINS":  ("Pinterest Inc.", "Pinterest", "科技"),
    "COIN":  ("Coinbase Global", "Coinbase", "加密"),
    "RIOT":  ("Riot Platforms", "Riot", "加密"),
    "MARA":  ("Marathon Digital", "Marathon", "加密"),
    "NOK":   ("Nokia Corp.", "諾基亞", "電信"),
    "BB":    ("BlackBerry Ltd.", "黑莓", "科技"),
    "PYPL":  ("PayPal Holdings", "PayPal", "金融"),
    "UBER":  ("Uber Technologies", "優步", "科技"),
    "ABNB":  ("Airbnb Inc.", "Airbnb", "觀光"),
    "SHOP":  ("Shopify Inc.", "Shopify", "科技"),
    "SPOT":  ("Spotify Technology", "Spotify", "娛樂"),
}


def fetch(ticker: str):
    now = int(time.time())
    p1 = now - int(365.25 * YEARS_BACK) * 86400
    last_err = None
    for host in ("1", "2"):
        url = API.format(h=host, t=ticker, p1=p1, p2=now)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last_err = e
    raise last_err


def parse(raw):
    res = raw["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, t in enumerate(ts):
        o, h, l, c, v = (q["open"][i], q["high"][i], q["low"][i],
                         q["close"][i], q["volume"][i])
        if None in (o, h, l, c):
            continue
        rows.append((datetime.fromtimestamp(t).strftime("%Y-%m-%d"),
                     round(o, 2), round(h, 2), round(l, 2),
                     round(c, 2), int(v)))
    return rows


def main():
    os.makedirs(OUT, exist_ok=True)
    cutoff = datetime.now() - timedelta(days=365 * YEARS_BACK)
    index = []
    fail = []
    for i, (tk, (en, zh, sector)) in enumerate(TICKERS.items(), 1):
        ok, rows = False, None
        for attempt in range(3):
            try:
                rows = parse(fetch(tk))
                ok = True
                break
            except Exception as e:
                print(f"  retry {tk} ({e})", file=sys.stderr)
                time.sleep(2 + attempt * 2)
        if not ok:
            fail.append(tk)
            continue
        rows = [r for r in rows if datetime.strptime(r[0], "%Y-%m-%d") >= cutoff]
        if len(rows) < 1000:
            print(f"  skip {tk}: only {len(rows)} bars", file=sys.stderr)
            fail.append(tk)
            continue
        payload = {
            "t": tk, "n": en, "z": zh, "s": sector,
            "d": [r[0] for r in rows],
            "o": [r[1] for r in rows],
            "h": [r[2] for r in rows],
            "l": [r[3] for r in rows],
            "c": [r[4] for r in rows],
            "v": [r[5] for r in rows],
        }
        with open(os.path.join(OUT, tk + ".js"), "w", encoding="utf-8") as f:
            f.write('window.STOCKS=window.STOCKS||{};window.STOCKS["%s"]=%s;'
                    % (tk, json.dumps(payload, separators=(",", ":"))))
        index.append({"t": tk, "n": en, "z": zh, "s": sector,
                      "bars": len(rows), "from": rows[0][0], "to": rows[-1][0]})
        print(f"[{i}/{len(TICKERS)}] {tk}: {len(rows)} bars "
              f"{rows[0][0]} -> {rows[-1][0]}")
        time.sleep(0.4)
    with open(os.path.join(OUT, "index.js"), "w", encoding="utf-8") as f:
        f.write("window.STOCK_INDEX=%s;" % json.dumps(
            index, separators=(",", ":"), ensure_ascii=False))
    print(f"\nDone. {len(index)} ok, failed: {fail or 'none'}")


if __name__ == "__main__":
    main()
