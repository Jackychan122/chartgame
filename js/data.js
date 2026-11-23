/* ===== 資料層:股票檔案載入、週K 聚合、連續區段、選股 ===== */
(function () {
  "use strict";
  var CG = (window.CG = window.CG || {});
  var DAY_MS = 86400000;
  var cache = {};

  /* ---------- 日期 ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /** epoch day number -> "YYYY-MM-DD" (all in UTC, so the result never depends on the local clock) */
  function dateStr(day) {
    var d = new Date(day * DAY_MS);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }

  /** "YYYY-MM-DD" -> epoch day number */
  function dayNumber(str) {
    return Math.floor(Date.UTC(+str.slice(0, 4), +str.slice(5, 7) - 1, +str.slice(8, 10)) / DAY_MS);
  }

  /** 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday) */
  function weekday(day) { return (day + 4) % 7; }

  /* ---------- 載入 ---------- */
  /** Loads data/<ticker>.js once and resolves with window.STOCKS[ticker]. */
  function load(ticker) {
    if (window.STOCKS && window.STOCKS[ticker]) return Promise.resolve(window.STOCKS[ticker]);
    if (!cache[ticker]) {
      cache[ticker] = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = "data/" + encodeURIComponent(ticker) + ".js";
        s.async = true;
        s.onload = function () {
          if (window.STOCKS && window.STOCKS[ticker]) resolve(window.STOCKS[ticker]);
          else reject(new Error("股票資料格式錯誤:" + ticker));
        };
        s.onerror = function () {
          delete cache[ticker];
          reject(new Error("股票資料載入失敗:" + ticker));
        };
        document.head.appendChild(s);
      });
    }
    return cache[ticker];
  }

  /* ---------- K 棒 ---------- */
  /** Per-ticker file -> daily bars {d: epoch day, t: "YYYY-MM-DD", o, h, l, c, v}. */
  function dailyBars(raw) {
    var out = new Array(raw.d.length);
    for (var i = 0; i < raw.d.length; i++) {
      out[i] = { d: raw.d[i], t: dateStr(raw.d[i]), o: raw.o[i] / 100, h: raw.h[i] / 100,
                 l: raw.l[i] / 100, c: raw.c[i] / 100, v: raw.v[i] * 100 };
    }
    return out;
  }

  /**
   * Daily bars -> Monday-start weekly bars, keeping the daily segment cuts aligned.
   * A final bar that stops on a Monday-Thursday belongs to a week that is still running, so it is dropped.
   * A cut on a week's first day starts a new weekly segment. A cut later in the week leaves the jump
   * inside that weekly bar, so the bar is fenced off on both sides and never becomes part of a game.
   * Returns { bars, cuts } where cuts are the weekly indexes at which a new segment starts.
   */
  function weeklyBars(bars, dailyCuts) {
    var end = bars.length;
    if (end && weekday(bars[end - 1].d) <= 3) end--;
    var out = [], cuts = [], firsts = [], week = null, cut = new Set(dailyCuts || []);
    for (var i = 0; i < end; i++) {
      var b = bars[i], w = Math.floor((b.d + 3) / 7);
      if (w !== week) {
        week = w;
        out.push({ d: b.d, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
        firsts.push(b.d);
      } else {
        var k = out[out.length - 1];
        k.d = b.d; k.t = b.t;
        if (b.h > k.h) k.h = b.h;
        if (b.l < k.l) k.l = b.l;
        k.c = b.c; k.v += b.v;
      }
      if (i > 0 && cut.has(i)) {
        cuts.push(out.length - 1);
        if (b.d !== firsts[firsts.length - 1]) cuts.push(out.length);   // 週中斷層:下一根也重新開始
      }
    }
    return { bars: out, cuts: cuts };
  }

  /** [start, end] index pairs (inclusive) of the segments delimited by `cuts` (segment start indexes). */
  function segmentsOf(n, cuts) {
    var starts = [0].concat((cuts || []).filter(function (c) { return c > 0 && c < n; }));
    var out = [];
    for (var i = 0; i < starts.length; i++) {
      out.push([starts[i], (i + 1 < starts.length ? starts[i + 1] : n) - 1]);
    }
    return out;
  }

  /**
   * Picks the start of a window of `need` bars that lies inside a single segment,
   * uniformly over all such windows. Returns null when the series has none.
   */
  function pickWindow(n, cuts, need, random) {
    var segs = segmentsOf(n, cuts), total = 0, i, count;
    for (i = 0; i < segs.length; i++) {
      count = segs[i][1] - segs[i][0] + 1 - need + 1;
      if (count > 0) total += count;
    }
    if (!total) return null;
    var r = Math.floor((random || Math.random)() * total);
    for (i = 0; i < segs.length; i++) {
      count = segs[i][1] - segs[i][0] + 1 - need + 1;
      if (count > 0) {
        if (r < count) return segs[i][0] + r;
        r -= count;
      }
    }
    return null;
  }

  /** True when bars[start .. start+need-1] lies inside a single segment. */
  function windowIsValid(n, cuts, start, need) {
    if (start < 0 || start + need > n) return false;
    for (var i = 1; i < need; i++) {
      if (cuts.indexOf(start + i) >= 0) return false;
    }
    return true;
  }

  /* ---------- 標的清單 ---------- */
  function index() {
    return (window.STOCK_INDEX && window.STOCK_INDEX.stocks) || [];
  }
  function meta(ticker) {
    var list = index();
    for (var i = 0; i < list.length; i++) if (list[i].t === ticker) return list[i];
    return null;
  }
  /** Tickers whose longest uninterrupted segment is long enough for the period. */
  function eligible(period, need) {
    return index().filter(function (s) { return (period.weekly ? s.w : s.m) >= need; });
  }

  CG.Data = {
    load: load,
    dailyBars: dailyBars,
    weeklyBars: weeklyBars,
    segmentsOf: segmentsOf,
    pickWindow: pickWindow,
    windowIsValid: windowIsValid,
    index: index,
    meta: meta,
    eligible: eligible,
    dateStr: dateStr,
    dayNumber: dayNumber,
    weekday: weekday,
  };
})();
