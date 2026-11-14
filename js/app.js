/* ===== K線操盤挑戰 ChartGame — 主程式 ===== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var LC = window.LightweightCharts;
  var INITIAL_CASH = 10000;
  var SPEEDS = [1, 5, 20];

  /* ---------- 期間設定 ---------- */
  var PERIODS = {
    "3m": { key: "3m", label: "3個月", weekly: false, hist: 60, play: 63, ctx: 260 },
    "6m": { key: "6m", label: "6個月", weekly: false, hist: 120, play: 126, ctx: 260 },
    "1y": { key: "1y", label: "1年", weekly: false, hist: 120, play: 250, ctx: 260 },
    "2y": { key: "2y", label: "2年", weekly: true, hist: 100, play: 104, ctx: 215 },
    "5y": { key: "5y", label: "5年", weekly: true, hist: 156, play: 260, ctx: 215 },
  };
  var PERIOD_ORDER = ["3m", "6m", "1y", "2y", "5y"];

  /* ---------- 指標定義 ---------- */
  var PANE_ORDER = ["vol", "macd", "rsi"];
  var PANE_H = { vol: 62, macd: 78, rsi: 78 };
  var IND_DEFS = {
    ma20: { label: "MA20 均線", color: "#f0b90b" },
    ma50: { label: "MA50 均線", color: "#ab47bc" },
    ma200: { label: "MA200 均線", color: "#787b86" },
    bb: { label: "布林通道 (20,2σ)", color: "#26c6da" },
    vol: { label: "成交量", color: "#8b94a7" },
    macd: { label: "MACD (12,26,9)", color: "#2962ff" },
    rsi: { label: "RSI (14)", color: "#ba68c8" },
  };
  var DEFAULT_ON = { ma20: true, ma50: true, ma200: false, bb: false, vol: true, macd: true, rsi: false };

  /* ---------- 全域狀態 ---------- */
  var chart = null, candle = null, markerApi = null, watermark = null;
  var st = {
    periodKey: "6m",
    speed: 1,
    user: loadPrefs(),
    autoTimer: null,
    game: null,       // 目前遊局
    hoverIdx: -1,
  };

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem("cg_prefs_v1") || "{}");
      var out = {};
      Object.keys(IND_DEFS).forEach(function (k) {
        out[k] = (k in p) ? !!p[k] : !!DEFAULT_ON[k];
      });
      return out;
    } catch (e) { return Object.assign({}, DEFAULT_ON); }
  }
  function savePrefs() {
    try { localStorage.setItem("cg_prefs_v1", JSON.stringify(st.user)); } catch (e) { }
  }

  /* ---------- 格式化 ---------- */
  function fmtMoney(x, dp) {
    if (dp == null) dp = 2;
    return "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtPct(x, sign) {
    return (sign === false ? "" : x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
  }
  function fmtVol(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  }
  function cls(v) { return v >= 0 ? "pos" : "neg"; }

  /* ---------- 資料載入 ---------- */
  function loadTicker(tk) {
    if (window.STOCKS && window.STOCKS[tk]) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "data/" + tk + ".js";
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error("載入失敗: " + tk)); };
      document.head.appendChild(s);
    });
  }

  function weekKey(dateStr) {
    var dt = new Date(dateStr + "T00:00:00Z");
    var day = (dt.getUTCDay() + 6) % 7; // 週一 = 0
    dt.setUTCDate(dt.getUTCDate() - day);
    return dt.toISOString().slice(0, 10);
  }

  function toWeekly(raw) {
    var out = [], cur = null, curKey = null;
    for (var i = 0; i < raw.d.length; i++) {
      var k = weekKey(raw.d[i]);
      if (cur && k === curKey) {
        cur.d = raw.d[i];
        cur.h = Math.max(cur.h, raw.h[i]);
        cur.l = Math.min(cur.l, raw.l[i]);
        cur.c = raw.c[i];
        cur.v += raw.v[i];
      } else {
        if (cur) out.push(cur);
        curKey = k;
        cur = { d: raw.d[i], o: raw.o[i], h: raw.h[i], l: raw.l[i], c: raw.c[i], v: raw.v[i] };
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function pickStock(period) {
    var need = period.ctx + period.hist + period.play;
    var dailyNeed = period.weekly ? need * 5 + 12 : need;
    var idx = window.STOCK_INDEX || [];
    var cands = idx.filter(function (s) { return s.bars >= dailyNeed; });
    if (!cands.length) cands = idx.filter(function (s) { return s.bars >= need; });
    if (!cands.length) cands = idx.slice();
    return cands[Math.floor(Math.random() * cands.length)];
  }

  /* ---------- 指標計算(整段切片一次算完,皆為因果指標) ---------- */
  function computeCalc(bars) {
    var closes = bars.map(function (b) { return b.c; });
    var c = window.Ind;
    var bb = c.bollinger(closes, 20, 2);
    var m = c.macd(closes, 12, 26, 9);
    return {
      ma20: c.sma(closes, 20),
      ma50: c.sma(closes, 50),
      ma200: c.sma(closes, 200),
      bbU: bb.upper, bbM: bb.mid, bbL: bb.lower,
      rsi: c.rsi(closes, 14),
      macdD: m.dif, macdS: m.dea, macdH: m.hist,
    };
  }

  /* ---------- 圖表建立(每局重建,乾淨狀態) ---------- */
  function disposeChart() {
    if (chart) { try { chart.remove(); } catch (e) { } }
    chart = null; candle = null; markerApi = null; watermark = null;
  }

  function buildChart() {
    disposeChart();
    chart = LC.createChart($("chart"), {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "#0d1017" },
        textColor: "#8b94a7",
        panes: { separatorColor: "#252c3b", separatorHoverColor: "rgba(240,185,11,.35)", enableResize: true },
      },
      grid: { vertLines: { color: "#151a24" }, horzLines: { color: "#151a24" } },
      crosshair: {
        mode: LC.CrosshairMode.Normal,
        vertLine: { color: "#4a5265", width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: "#2a3145" },
        horzLine: { color: "#4a5265", width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: "#2a3145" },
      },
      rightPriceScale: { borderColor: "#252c3b" },
      timeScale: { visible: false, borderColor: "#252c3b", rightOffset: 8, barSpacing: 8, minBarSpacing: 1.5 },
      localization: { locale: "zh-TW" },
    });
    candle = chart.addSeries(LC.CandlestickSeries, {
      upColor: "#26a69a", downColor: "#ef5350",
      borderUpColor: "#26a69a", borderDownColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
      priceLineVisible: true, priceLineWidth: 1, priceLineStyle: LC.LineStyle.Dotted,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    markerApi = LC.createSeriesMarkers(candle, []);
    try {
      watermark = LC.createTextWatermark(chart.panes()[0], {
        visible: true,
        lines: [{ text: "❓ 神秘股票", color: "rgba(255,255,255,0.05)", fontSize: 54, fontStyle: "bold" }],
      });
    } catch (e) { watermark = null; }

    chart.subscribeCrosshairMove(function (param) {
      if (!st.game) return;
      if (param && param.time && st.game.timeIdx && st.game.timeIdx[param.time] != null) {
        st.hoverIdx = st.game.timeIdx[param.time];
      } else if (param && !param.time) {
        st.hoverIdx = -1; // 滑出圖外 → 回到最新
      }
      renderLegend();
    });
  }

  function paneIndexFor(key) {
    var idx = 1;
    for (var i = 0; i < PANE_ORDER.length; i++) {
      var k = PANE_ORDER[i];
      if (k === key) break;
      if (st.game && st.game.series[k] && st.game.series[k].length) idx++;
    }
    return idx;
  }

  function mkLine(color, opts, paneIdx) {
    return chart.addSeries(LC.LineSeries, Object.assign({
      color: color, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, opts || {}), paneIdx);
  }

  function createGroupSeries(key) {
    var g = st.game, arr = [], p = paneIndexFor(key);
    if (key === "ma20" || key === "ma50" || key === "ma200") {
      arr.push(mkLine(IND_DEFS[key].color, { lineWidth: 2 }, 0));
    } else if (key === "bb") {
      arr.push(mkLine("#26c6da", { lineWidth: 1, lineStyle: LC.LineStyle.Solid }, 0));
      arr.push(mkLine("#546e7a", { lineWidth: 1, lineStyle: LC.LineStyle.Dashed }, 0));
      arr.push(mkLine("#26c6da", { lineWidth: 1, lineStyle: LC.LineStyle.Solid }, 0));
    } else if (key === "vol") {
      var h = chart.addSeries(LC.HistogramSeries, {
        priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false,
      }, p);
      arr.push(h);
    } else if (key === "macd") {
      arr.push(chart.addSeries(LC.HistogramSeries, {
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        priceLineVisible: false, lastValueVisible: false,
      }, p));
      arr.push(mkLine("#2962ff", { lineWidth: 2 }, p));
      arr.push(mkLine("#ff6d00", { lineWidth: 2 }, p));
    } else if (key === "rsi") {
      var r = mkLine("#ba68c8", { lineWidth: 2 }, p);
      r.createPriceLine({ price: 70, color: "#546e7a", lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false, title: "70" });
      r.createPriceLine({ price: 30, color: "#546e7a", lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false, title: "30" });
      arr.push(r);
    }
    g.series[key] = arr;
    applyPaneHeights();
  }

  function removeGroupSeries(key) {
    var g = st.game; if (!g) return;
    (g.series[key] || []).forEach(function (s) { try { chart.removeSeries(s); } catch (e) { } });
    g.series[key] = null;
    applyPaneHeights();
  }

  function applyPaneHeights() {
    if (!chart) return;
    var panes = chart.panes();
    var pi = 1;
    PANE_ORDER.forEach(function (k) {
      if (st.game && st.game.series[k] && st.game.series[k].length) {
        if (panes[pi]) { try { panes[pi].setHeight(PANE_H[k]); } catch (e) { } }
        pi++;
      }
    });
  }

  /* ---------- 資料點產生 ---------- */
  function candlePoints(from, to) {
    var a = [], bars = st.game.bars;
    for (var i = from; i <= to; i++) {
      var b = bars[i];
      a.push({ time: b.d, open: b.o, high: b.h, low: b.l, close: b.c });
    }
    return a;
  }
  function volPoints(from, to) {
    var a = [], bars = st.game.bars;
    for (var i = from; i <= to; i++) {
      var b = bars[i];
      a.push({ time: b.d, value: b.v, color: b.c >= b.o ? "rgba(38,166,154,.5)" : "rgba(239,83,80,.5)" });
    }
    return a;
  }
  function linePoints(arr, from, to) {
    var a = [], bars = st.game.bars;
    for (var i = from; i <= to; i++) {
      var v = arr[i];
      if (v != null) a.push({ time: bars[i].d, value: Math.round(v * 10000) / 10000 });
    }
    return a;
  }
  function macdHistPoints(from, to) {
    var a = [], bars = st.game.bars, h = st.game.calc.macdH;
    for (var i = from; i <= to; i++) {
      var v = h[i];
      if (v == null) continue;
      a.push({ time: bars[i].d, value: v, color: v >= 0 ? "rgba(38,166,154,.55)" : "rgba(239,83,80,.55)" });
    }
    return a;
  }

  function refreshSeries() {
    var g = st.game; if (!g || !chart) return;
    var from = g.ctx, to = g.ended ? g.lastIdx : g.cursor;
    candle.setData(candlePoints(from, to));
    var S = g.series, C = g.calc;
    if (S.ma20) S.ma20[0].setData(linePoints(C.ma20, from, to));
    if (S.ma50) S.ma50[0].setData(linePoints(C.ma50, from, to));
    if (S.ma200) S.ma200[0].setData(linePoints(C.ma200, from, to));
    if (S.bb) {
      S.bb[0].setData(linePoints(C.bbU, from, to));
      S.bb[1].setData(linePoints(C.bbM, from, to));
      S.bb[2].setData(linePoints(C.bbL, from, to));
    }
    if (S.vol) S.vol[0].setData(volPoints(from, to));
    if (S.macd) {
      S.macd[0].setData(macdHistPoints(from, to));
      S.macd[1].setData(linePoints(C.macdD, from, to));
      S.macd[2].setData(linePoints(C.macdS, from, to));
    }
    if (S.rsi) S.rsi[0].setData(linePoints(C.rsi, from, to));
    markerApi.setMarkers(g.markers);
  }

  /* ---------- 建立新遊局 ---------- */
  function newGame(pk) {
    var period = PERIODS[pk] || PERIODS["6m"];
    var meta = pickStock(period);
    if (!meta) { alert("找不到足夠的股票資料!"); return; }
    setBusy(true);
    loadTicker(meta.t).then(function () {
      var raw = window.STOCKS[meta.t];
      var bars = period.weekly ? toWeekly(raw) : raw.d.map(function (d, i) {
        return { d: d, o: raw.o[i], h: raw.h[i], l: raw.l[i], c: raw.c[i], v: raw.v[i] };
      });

      var ctx = period.ctx, hist = period.hist, play = period.play;
      var total = ctx + hist + play;
      if (bars.length < total + 2) {
        ctx = Math.max(0, Math.min(ctx, bars.length - hist - Math.min(play, 60) - 2));
        total = ctx + hist + play;
        if (bars.length < total + 2) play = Math.max(20, bars.length - ctx - hist - 2);
        total = ctx + hist + play;
      }
      var start = Math.max(0, Math.floor(Math.random() * (bars.length - total)));
      var slice = bars.slice(start, start + total);

      var timeIdx = {};
      slice.forEach(function (b, i) { timeIdx[b.d] = i; });

      st.game = {
        meta: meta, period: period,
        bars: slice, ctx: ctx, hist: hist, play: play,
        cursor: ctx + hist - 1,          // 目前最後一根(顯示中)
        firstFuture: ctx + hist,         // 第一根未來K棒
        lastIdx: ctx + hist + play - 1,
        cash: INITIAL_CASH, shares: 0, cost: 0,
        trades: [], markers: [],
        calc: computeCalc(slice),
        series: {}, priceLine: null,
        ended: false, pendingBuy: false, pendingSell: false,
        timeIdx: timeIdx,
      };
      st.hoverIdx = -1;
      stopAuto();

      buildChart();
      // 依使用者偏好建立指標圖層
      Object.keys(IND_DEFS).forEach(function (k) {
        if (st.user[k]) createGroupSeries(k);
      });
      refreshSeries();
      chart.timeScale().applyOptions({ visible: false, barSpacing: 8 });
      chart.timeScale().scrollToPosition(8, false);

      $("startOverlay").classList.add("hidden");
      $("resultOverlay").classList.add("hidden");
      $("endControls").classList.add("hidden");
      $("playControls").classList.remove("hidden");
      $("modeTag").textContent = period.label + " · " + (period.weekly ? "週K" : "日K");
      updateHUD(); renderTrades(false); renderLegend();
      setBusy(false);
    }).catch(function (e) {
      setBusy(false);
      alert(e.message);
    });
  }

  function setBusy(b) {
    ["btnBuy", "btnSell", "btnStep", "btnAuto"].forEach(function (id) { $(id).disabled = b; });
  }

  /* ---------- 遊戲推進 ---------- */
  function advanceOne() {
    var g = st.game;
    if (!g || g.ended) return;
    g.cursor++;
    var b = g.bars[g.cursor];
    if (g.pendingBuy && g.shares === 0 && g.cash > 0) {
      g.shares = g.cash / b.o;
      g.cost = b.o; g.cash = 0;
      addTrade(g.cursor, "buy", b.o, g.shares, false);
      g.priceLine = candle.createPriceLine({
        price: b.o, color: "#26a69a", lineWidth: 1,
        lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: "成本",
      });
    } else if (g.pendingSell && g.shares > 0) {
      g.cash += g.shares * b.o;
      addTrade(g.cursor, "sell", b.o, g.shares, false);
      g.shares = 0; g.cost = 0;
      if (g.priceLine) { try { candle.removePriceLine(g.priceLine); } catch (e) { } g.priceLine = null; }
    }
    g.pendingBuy = g.pendingSell = false;
    if (g.cursor >= g.lastIdx) finishGame();
  }

  function step(n) {
    var g = st.game;
    if (!g || g.ended) return;
    for (var k = 0; k < n && !g.ended; k++) advanceOne();
    afterStep();
  }

  function afterStep() {
    var g = st.game;
    refreshSeries();
    if (!g.ended) chart.timeScale().scrollToPosition(8, false);
    updateHUD(); renderTrades(g.ended); renderLegend();
  }

  function addTrade(i, side, price, shares, forced) {
    var g = st.game;
    g.trades.push({ i: i, side: side, price: price, shares: shares, forced: !!forced });
    g.markers.push({
      time: g.bars[i].d,
      position: side === "buy" ? "belowBar" : "aboveBar",
      color: side === "buy" ? "#26a69a" : "#ef5350",
      shape: side === "buy" ? "arrowUp" : "arrowDown",
      text: forced ? "結算" : (side === "buy" ? "買" : "賣"),
    });
  }

  function tryBuy() {
    var g = st.game;
    if (!g || g.ended || g.shares > 0 || g.cursor >= g.lastIdx) return;
    g.pendingBuy = true;
    advanceOne(); afterStep();
  }

  function trySell() {
    var g = st.game;
    if (!g || g.ended || g.shares === 0 || g.cursor >= g.lastIdx) return;
    g.pendingSell = true;
    advanceOne(); afterStep();
  }

  /* ---------- 結算 ---------- */
  function finishGame() {
    var g = st.game;
    g.ended = true;
    stopAuto();
    var last = g.bars[g.lastIdx];
    if (g.shares > 0) {
      g.cash += g.shares * last.c;
      addTrade(g.lastIdx, "sell", last.c, g.shares, true);
      g.shares = 0; g.cost = 0;
      if (g.priceLine) { try { candle.removePriceLine(g.priceLine); } catch (e) { } g.priceLine = null; }
    }
    g.finalEquity = g.cash;
    g.ret = g.finalEquity / INITIAL_CASH - 1;
    g.bhRet = last.c / g.bars[g.firstFuture].o - 1;
    // 差距四捨五入後為 0.00pp 視為平手;嚴格領先才算打敗買進持有
    g.tie = Math.abs(g.ret - g.bhRet) < 5e-5;
    g.win = !g.tie && g.ret > g.bhRet;

    // 揭曉:顯示日期軸 + 全圖 + 水印消失
    chart.timeScale().applyOptions({ visible: true });
    if (watermark) { try { watermark.applyOptions({ visible: false }); } catch (e) { } }
    refreshSeries();
    chart.timeScale().fitContent();

    saveTrack(g);
    updateHUD(); renderTrades(true); renderLegend();
    $("playControls").classList.add("hidden");
    $("endControls").classList.remove("hidden");
    showResult(g);
  }

  function equityNow() {
    var g = st.game;
    return g.cash + g.shares * g.bars[g.cursor].c;
  }
  function bhNow() {
    var g = st.game;
    if (g.cursor < g.firstFuture) return 0;
    return g.bars[g.cursor].c / g.bars[g.firstFuture].o - 1;
  }

  /* ---------- HUD / 面板 ---------- */
  function updateHUD() {
    var g = st.game; if (!g) return;
    var eq = g.ended ? g.finalEquity : equityNow();
    var ret = eq / INITIAL_CASH - 1;
    var bh = g.ended ? g.bhRet : bhNow();
    var delta = ret - bh;

    $("hudEquity").textContent = fmtMoney(eq);
    var hr = $("hudRet"); hr.textContent = fmtPct(ret); hr.className = cls(ret);
    var hb = $("hudBh"); hb.textContent = fmtPct(bh); hb.className = cls(bh);
    var hd = $("hudDelta");
    hd.textContent = "(" + (delta >= 0 ? "領先 " : "落後 ") + Math.abs(delta * 100).toFixed(2) + "pp)";
    hd.className = cls(delta);

    var revealed = g.cursor - g.firstFuture + 1;
    $("hudProg").textContent = Math.max(0, revealed) + " / " + g.play + " 根";
    $("progressFill").style.width = Math.min(100, Math.max(0, revealed / g.play * 100)) + "%";
    $("hudStock").textContent = g.ended ? (g.meta.z + " " + g.meta.t) : "❓ ???";

    $("pCash").textContent = fmtMoney(g.cash);
    $("pShares").textContent = g.shares > 0
      ? g.shares.toFixed(4) + " 股 @ " + fmtMoney(g.cost)
      : "—";
    var pnl = $("pPnl");
    if (g.shares > 0) {
      var r = g.bars[g.cursor].c / g.cost - 1;
      pnl.textContent = fmtPct(r); pnl.className = cls(r);
    } else { pnl.textContent = g.ended ? fmtPct(g.ret) : "—"; pnl.className = g.ended ? cls(g.ret) : ""; }
    $("pTrades").textContent = g.trades.length;

    $("btnBuy").disabled = g.ended || g.shares > 0;
    $("btnSell").disabled = g.ended || g.shares === 0;
    $("btnStep").disabled = g.ended;
    $("btnAuto").disabled = g.ended;
  }

  function renderTrades(showDates) {
    var g = st.game; if (!g) return;
    var el = $("tradeList");
    if (!g.trades.length) {
      el.innerHTML = '<div class="empty">尚無交易,按 B 買進、S 賣出。</div>';
      return;
    }
    el.innerHTML = g.trades.slice().reverse().map(function (t) {
      var when = showDates ? g.bars[t.i].d
        : "第 " + (t.i - g.firstFuture + 1) + " 根";
      var cls2 = t.side === "buy" ? "side-b" : "side-s";
      var act = t.side === "buy" ? "買進" : (t.forced ? "結算賣出" : "賣出");
      return '<div class="trade-item"><span class="' + cls2 + '">' + act + "</span>" +
        '<span class="t-info">' + when + "</span>" +
        "<span>" + fmtMoney(t.price) + " × " + t.shares.toFixed(2) + "</span></div>";
    }).join("");
  }

  function renderLegend() {
    var g = st.game; if (!g) return;
    var i = (st.hoverIdx >= 0 && st.hoverIdx <= (g.ended ? g.lastIdx : g.cursor)) ? st.hoverIdx : g.cursor;
    var b = g.bars[i];
    var chg = i > 0 ? b.c / g.bars[i - 1].c - 1 : 0;
    var rel = i - g.firstFuture + 1; // 1 = 第一根挑戰K棒
    var when = g.ended ? "✅ " + b.d : (rel > 0 ? "❓ 第 " + rel + " 根" : "❓ 歷史K棒");
    var l1 = '<span class="lg-date">' + when + "</span>　" +
      '開 <b class="' + cls(chg) + '">' + b.o.toFixed(2) + "</b> " +
      '高 <b class="' + cls(chg) + '">' + b.h.toFixed(2) + "</b> " +
      '低 <b class="' + cls(chg) + '">' + b.l.toFixed(2) + "</b> " +
      '收 <b class="' + cls(chg) + '">' + b.c.toFixed(2) + "</b> " +
      '<b class="' + cls(chg) + '">' + fmtPct(chg) + "</b> " +
      "量 " + fmtVol(b.v);
    var parts = [];
    var C = g.calc, S = g.series;
    function add(name, arr, color) {
      if (arr[i] != null) parts.push('<b style="color:' + color + '">' + name + " " + arr[i].toFixed(2) + "</b>");
    }
    if (S.ma20) add("MA20", C.ma20, IND_DEFS.ma20.color);
    if (S.ma50) add("MA50", C.ma50, IND_DEFS.ma50.color);
    if (S.ma200) add("MA200", C.ma200, IND_DEFS.ma200.color);
    if (S.rsi && C.rsi[i] != null) parts.push('<b style="color:' + IND_DEFS.rsi.color + '">RSI ' + C.rsi[i].toFixed(1) + "</b>");
    var l2 = parts.length ? '<br><span class="lg-ind">' + parts.join(" · ") + "</span>" : "";
    $("legend").innerHTML = l1 + l2;
  }

  /* ---------- 戰績 ---------- */
  function loadTrack() {
    try { return JSON.parse(localStorage.getItem("cg_track_v1") || "[]"); } catch (e) { return []; }
  }
  function saveTrack(g) {
    var arr = loadTrack();
    arr.push({
      ts: Date.now(), p: g.period.key, t: g.meta.t, n: g.meta.n, z: g.meta.z,
      r: Math.round(g.ret * 10000) / 10000,
      b: Math.round(g.bhRet * 10000) / 10000,
      w: g.win ? 1 : 0, e: g.tie ? 1 : 0, k: g.trades.length,
      from: g.bars[g.firstFuture].d, to: g.bars[g.lastIdx].d,
    });
    try { localStorage.setItem("cg_track_v1", JSON.stringify(arr)); } catch (e) { }
  }
  function renderTrack() {
    var arr = loadTrack();
    var n = arr.length, wins = 0, sr = 0, sb = 0;
    arr.forEach(function (r) { wins += r.w; sr += r.r; sb += r.b; });
    $("trackStats").innerHTML = n ? [
      box("已玩局數", String(n)), box("打敗B&H", Math.round(wins / n * 100) + "%"),
      box("平均報酬", fmtPct(sr / n)), box("平均B&H", fmtPct(sb / n)),
    ].join("") : '<div class="empty">還沒有完賽紀錄,快開始第一局!</div>';

    $("trackBody").innerHTML = arr.slice().reverse().map(function (r) {
      var d = new Date(r.ts);
      return "<tr><td>" + d.toLocaleDateString("zh-TW") + "</td>" +
        "<td>" + r.z + " " + r.t + "</td>" +
        "<td>" + PERIODS[r.p].label + (PERIODS[r.p].weekly ? "週K" : "日K") + "</td>" +
        '<td class="' + cls(r.r) + '">' + fmtPct(r.r) + "</td>" +
        '<td class="' + cls(r.b) + '">' + fmtPct(r.b) + "</td>" +
        "<td>" + (r.w ? '<span class="pos">勝</span>' : r.e ? '<span class="gold">平</span>' : '<span class="neg">敗</span>') + "</td></tr>";
    }).join("");

    function box(label, val) {
      return '<div class="res-box"><div class="r-label">' + label + '</div><div class="r-val">' + val + "</div></div>";
    }
  }

  /* ---------- 結果畫面 ---------- */
  function showResult(g) {
    var d = g.ret - g.bhRet;
    var v = $("resVerdict");
    if (g.tie) {
      v.innerHTML = '🤝 <span class="gold">平手!</span><small>你與買進持有報酬完全相同</small>';
    } else if (g.win) {
      v.innerHTML = '🎉 <span class="pos">你擊敗了買進持有!</span><small>領先 ' + (d * 100).toFixed(2) + " 個百分點</small>";
    } else {
      v.innerHTML = '😵 <span class="neg">買進持有獲勝…</span><small>落後 ' + Math.abs(d * 100).toFixed(2) + " 個百分點</small>";
    }
    $("resStock").innerHTML =
      "這檔神秘股票是 <b>" + g.meta.z + " " + g.meta.n + "(" + g.meta.t + ")</b> · " + g.meta.s + "類<br>" +
      '<span style="color:var(--muted)">挑戰期間 ' + g.bars[g.firstFuture].d + " ~ " + g.bars[g.lastIdx].d +
      "(" + (g.period.weekly ? "週K" : "日K") + ")</span>";
    function box(label, val, sub, colorCls) {
      return '<div class="res-box"><div class="r-label">' + label + '</div><div class="r-val ' + (colorCls || "") + '">' + val + '</div><div class="r-sub">' + (sub || "") + "</div></div>";
    }
    $("resGrid").innerHTML =
      box("你的報酬", fmtPct(g.ret), fmtMoney(g.finalEquity), cls(g.ret)) +
      box("買進持有報酬", fmtPct(g.bhRet), fmtMoney(INITIAL_CASH * (1 + g.bhRet)), cls(g.bhRet)) +
      box("勝負差距", (d >= 0 ? "+" : "") + (d * 100).toFixed(2) + " pp", g.tie ? "平手" : (d > 0 ? "你領先" : "你落後"), g.tie ? "gold" : cls(d)) +
      box("交易次數", String(g.trades.length), g.trades.length ? "最後一根自動清倉" : "從未進場");
    $("resultOverlay").classList.remove("hidden");
  }

  /* ---------- 自動播放 / 長按快轉 ---------- */
  function startAuto() {
    if (st.autoTimer || !st.game || st.game.ended) return;
    $("btnAuto").classList.add("on");
    $("btnAuto").textContent = "⏸ 停止";
    st.autoTimer = setInterval(function () {
      if (!st.game || st.game.ended) { stopAuto(); return; }
      advanceOne(); afterStep();
    }, 160);
  }
  function stopAuto() {
    if (st.autoTimer) { clearInterval(st.autoTimer); st.autoTimer = null; }
    $("btnAuto").classList.remove("on");
    $("btnAuto").textContent = "▶ 自動";
  }

  /* ---------- 指標面板 ---------- */
  function renderIndList() {
    $("indList").innerHTML = Object.keys(IND_DEFS).map(function (k) {
      var def = IND_DEFS[k];
      return '<label class="ind-row"><input type="checkbox" data-k="' + k + '"' + (st.user[k] ? " checked" : "") + ">" +
        '<span class="ind-dot" style="background:' + def.color + '"></span>' + def.label + "</label>";
    }).join("");
    $("indList").querySelectorAll("input").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var k = cb.getAttribute("data-k");
        st.user[k] = cb.checked;
        savePrefs();
        if (st.game) {
          if (cb.checked) createGroupSeries(k); else removeGroupSeries(k);
          refreshSeries();
        }
      });
    });
  }

  /* ---------- 開始畫面:期間選擇 ---------- */
  function renderPeriodGrid() {
    $("periodGrid").innerHTML = PERIOD_ORDER.map(function (k) {
      var p = PERIODS[k];
      return '<button class="period-opt' + (k === st.periodKey ? " on" : "") + '" data-k="' + k + '">' +
        '<div class="p-name">' + p.label + "</div>" +
        '<div class="p-sub">' + (p.weekly ? "週K" : "日K") + " · " + p.play + "根</div></button>";
    }).join("");
    $("periodGrid").querySelectorAll(".period-opt").forEach(function (b) {
      b.addEventListener("click", function () {
        st.periodKey = b.getAttribute("data-k");
        $("periodGrid").querySelectorAll(".period-opt").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
      });
    });
  }

  /* 回到開始畫面 */
  function showStart() {
    stopAuto();
    $("resultOverlay").classList.add("hidden");
    $("startOverlay").classList.remove("hidden");
  }

  /* 關閉戰績:若從結算畫面開啟,回到結算畫面 */
  function closeTrack() {
    $("trackOverlay").classList.add("hidden");
    if (st.trackFromResult) {
      $("resultOverlay").classList.remove("hidden");
    }
    st.trackFromResult = false;
  }

  /* ---------- 事件繫結 ---------- */
  function bind() {
    $("btnStart").addEventListener("click", function () { newGame(st.periodKey); });
    $("btnBuy").addEventListener("click", tryBuy);
    $("btnSell").addEventListener("click", trySell);
    $("btnAgain").addEventListener("click", function () { newGame(st.game ? st.game.period.key : st.periodKey); });
    $("btnAgain2").addEventListener("click", function () { newGame(st.game ? st.game.period.key : st.periodKey); });
    $("btnViewChart").addEventListener("click", function () { $("resultOverlay").classList.add("hidden"); });
    $("btnShowResult").addEventListener("click", function () { $("resultOverlay").classList.remove("hidden"); });
    $("btnHome").addEventListener("click", showStart);
    $("btnHome2").addEventListener("click", showStart);
    $("btnTrack2").addEventListener("click", function () {
      $("resultOverlay").classList.add("hidden");
      st.trackFromResult = true;
      renderTrack(); $("trackOverlay").classList.remove("hidden");
    });
    $("btnTrack").addEventListener("click", function () { renderTrack(); $("trackOverlay").classList.remove("hidden"); });
    $("btnTrackClose").addEventListener("click", closeTrack);
    $("btnTrackClear").addEventListener("click", function () {
      if (confirm("確定要清除所有戰績紀錄嗎?")) {
        localStorage.removeItem("cg_track_v1"); renderTrack();
      }
    });
    $("btnHelp").addEventListener("click", function () { $("helpOverlay").classList.remove("hidden"); });
    $("btnHelpClose").addEventListener("click", function () { $("helpOverlay").classList.add("hidden"); });
    $("btnSide").addEventListener("click", function () { $("sidebar").classList.toggle("open"); });

    // 速度選擇
    $("speedChips").querySelectorAll(".chip").forEach(function (c) {
      c.addEventListener("click", function () {
        st.speed = Number(c.getAttribute("data-x"));
        $("speedChips").querySelectorAll(".chip").forEach(function (x) { x.classList.remove("on"); });
        c.classList.add("on");
        $("btnStep").innerHTML = "⏩ 快轉 " + st.speed + ' 根<span class="kbd">T</span>';
      });
    });

    // 快轉:單擊 = speed 根;長按 = 連續
    var holdT = null, repT = null, held = false;
    var stepBtn = $("btnStep");
    stepBtn.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || stepBtn.disabled) return;
      held = false;
      holdT = setTimeout(function () {
        held = true;
        repT = setInterval(function () { step(1); }, 65);
      }, 380);
    });
    function releaseStep() {
      clearTimeout(holdT); clearInterval(repT);
      if (!held && !stepBtn.disabled) step(st.speed);
      held = false;
    }
    stepBtn.addEventListener("pointerup", releaseStep);
    stepBtn.addEventListener("pointercancel", releaseStep);
    stepBtn.addEventListener("pointerleave", function () { clearTimeout(holdT); clearInterval(repT); held = false; });

    $("btnAuto").addEventListener("click", function () {
      if (st.autoTimer) stopAuto(); else startAuto();
    });

    // 鍵盤
    document.addEventListener("keydown", function (e) {
      var overlayOpen = !$("helpOverlay").classList.contains("hidden") ||
        !$("trackOverlay").classList.contains("hidden") ||
        !$("startOverlay").classList.contains("hidden");
      if (e.key === "Escape") {
        $("helpOverlay").classList.add("hidden");
        var trackOpen = !$("trackOverlay").classList.contains("hidden");
        $("trackOverlay").classList.add("hidden");
        if (trackOpen) closeTrack();
        else if (!$("resultOverlay").classList.contains("hidden")) {
          $("resultOverlay").classList.add("hidden"); // 看線圖
        }
        return;
      }
      if (overlayOpen) return;
      var k = e.key.toLowerCase();
      if (k === "b") { if (!e.repeat) tryBuy(); }
      else if (k === "s") { if (!e.repeat) trySell(); }
      else if (k === "t" || k === " " || k === "arrowright") { e.preventDefault(); step(st.speed); }
      else if (k === "a") { if (!e.repeat) st.autoTimer ? stopAuto() : startAuto(); }
    });
  }

  /* ---------- 啟動 ---------- */
  renderIndList();
  renderPeriodGrid();
  bind();
})();
