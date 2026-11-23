/* ===== 圖表層:封裝 Lightweight Charts =====
 * 負責K線、指標疊圖、下方的指標窗格、資產對比窗格,以及圖上的買賣連線。
 * 不認識 DOM 面板,也不決定遊戲規則。
 */
(function () {
  "use strict";
  var CG = (window.CG = window.CG || {});
  var LC = window.LightweightCharts;
  var RIGHT_OFFSET = 6;        // 最新一根右邊預留的空白K棒數
  var SPACING_MIN = 3.2, SPACING_MAX = 12;

  var COLOR = {
    up: "#2ebd85", down: "#f6465d", gold: "#f0b90b", blue: "#4c8dff", orange: "#ff9f43",
    purple: "#c084fc", cyan: "#22d3ee", grey: "#8a94a8", text: "#8a94a8", bg: "#0b0f16",
  };

  /* 指標定義:overlay = 畫在K線上;pane = 自己一個窗格 */
  var IND = {
    ma20:  { label: "MA20 均線", color: COLOR.gold, overlay: true },
    ma50:  { label: "MA50 均線", color: COLOR.purple, overlay: true },
    ma200: { label: "MA200 均線", color: COLOR.grey, overlay: true },
    bb:    { label: "布林通道 (20, 2σ)", color: COLOR.cyan, overlay: true },
    perf:  { label: "資產對比:你 vs 買進持有", color: COLOR.gold, pane: true },
    vol:   { label: "成交量", color: "#5b6678", pane: true },
    macd:  { label: "MACD (12, 26, 9)", color: COLOR.blue, pane: true },
    rsi:   { label: "RSI (14)", color: COLOR.purple, pane: true },
  };
  var IND_ORDER = ["ma20", "ma50", "ma200", "bb", "perf", "vol", "macd", "rsi"];  // 側欄順序
  var PANE_ORDER = ["perf", "vol", "macd", "rsi"];                                 // 窗格由上至下
  var PANE_H = { perf: 96, vol: 56, macd: 76, rsi: 76 };
  var DEFAULT_ON = { ma20: true, ma50: true, ma200: false, bb: false, perf: true, vol: true, macd: true, rsi: false };

  /* ---------- 日期軸 ---------- */
  function ymd(time) {
    if (typeof time === "string") { var p = time.split("-"); return [Number(p[0]), Number(p[1]), Number(p[2])]; }
    return [time.year, time.month, time.day];
  }
  /** 刻度:年份 / 幾月 / 幾月幾日 */
  function tickLabel(time, type) {
    var d = ymd(time);
    if (type === LC.TickMarkType.Year) return d[0] + "年";
    if (type === LC.TickMarkType.Month) return d[1] + "月";
    return d[1] + "/" + d[2];
  }
  function fullDate(time) {
    var d = ymd(time);
    return d[0] + "-" + (d[1] < 10 ? "0" : "") + d[1] + "-" + (d[2] < 10 ? "0" : "") + d[2];
  }

  /* ---------- 買賣連線(系列自訂圖形) ---------- */
  function TradeLines() {
    this.segs = [];
    this.ctx = 0;
    this.att = null;
    this._views = [new TradeLinesView(this)];
  }
  TradeLines.prototype.attached = function (param) { this.att = param; };
  TradeLines.prototype.detached = function () { this.att = null; };
  TradeLines.prototype.updateAllViews = function () { };
  TradeLines.prototype.paneViews = function () { return this._views; };
  /** segs: [{ i1, p1, i2, p2, ret, open, label }],i = K棒在遊戲切片中的索引 */
  TradeLines.prototype.set = function (segs, ctx) {
    this.segs = segs;
    this.ctx = ctx;
    if (this.att) this.att.requestUpdate();
  };

  function TradeLinesView(src) { this._src = src; this._renderer = new TradeLinesRenderer(src); }
  TradeLinesView.prototype.zOrder = function () { return "top"; };
  TradeLinesView.prototype.renderer = function () { return this._renderer; };

  function TradeLinesRenderer(src) { this._src = src; }
  TradeLinesRenderer.prototype.draw = function (target) {
    var att = this._src.att, segs = this._src.segs, ctx = this._src.ctx;
    if (!att || !segs.length) return;
    var scale = att.chart.timeScale(), series = att.series;
    target.useMediaCoordinateSpace(function (scope) {
      var g = scope.context, width = scope.mediaSize.width;
      g.save();
      g.lineCap = "round";
      g.font = '600 11px "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      for (var k = 0; k < segs.length; k++) {
        var s = segs[k];
        var x1 = scale.logicalToCoordinate(s.i1 - ctx), y1 = series.priceToCoordinate(s.p1);
        var x2 = scale.logicalToCoordinate(s.i2 - ctx), y2 = series.priceToCoordinate(s.p2);
        if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
        var col = s.ret >= 0 ? COLOR.up : COLOR.down;
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.setLineDash(s.open ? [5, 4] : []);         // 未平倉的部位用虛線連到最新收盤價
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.setLineDash([]);
        var w = Math.abs(x2 - x1);
        if (s.label && w >= 58) {                     // 太短的線不放標籤,避免疊字
          var tw = g.measureText(s.label).width + 10;
          var tx = Math.min(Math.max((x1 + x2) / 2, tw / 2 + 4), width - tw / 2 - 4);
          var ty = (y1 + y2) / 2 + (s.ret >= 0 ? 13 : -13);
          g.fillStyle = "rgba(11, 15, 22, 0.88)";
          g.fillRect(tx - tw / 2, ty - 8, tw, 16);
          g.fillStyle = col;
          g.fillText(s.label, tx, ty + 0.5);
        }
      }
      g.restore();
    });
  };

  /* ---------- 圖表檢視 ---------- */
  function ChartView(container) {
    this.container = container;
    this.onHover = null;
    this.game = null;
    this.calc = null;
    this.groups = {};          // 指標鍵 -> 圖層陣列
    this.tags = [];            // 窗格左上角的小標籤
    this.fit = true;           // 自動縮放中(使用者自己縮放後就停手)
    this.fresh = true;         // 這一局還沒畫過
    this.userSized = false;    // 使用者拖過窗格分隔線
    this.tagFrame = 0;

    this.chart = LC.createChart(container, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: COLOR.bg },
        textColor: COLOR.text,
        fontSize: 11,
        fontFamily: 'Inter, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif',
        panes: {
          separatorColor: "#151b25",
          separatorHoverColor: "rgba(240, 185, 11, 0.5)",
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.035)" },
        horzLines: { color: "rgba(255, 255, 255, 0.045)" },
      },
      crosshair: {
        mode: LC.CrosshairMode.Normal,
        vertLine: { color: "#55607a", width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: "#2b3445" },
        horzLine: { color: "#55607a", width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: "#2b3445" },
      },
      rightPriceScale: { borderColor: "#1b222d", scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { visible: false, borderColor: "#1b222d", rightOffset: RIGHT_OFFSET, barSpacing: 7, minBarSpacing: 1, tickMarkFormatter: tickLabel },
      localization: { locale: "zh-TW", timeFormatter: fullDate },
    });

    this.candle = this.chart.addSeries(LC.CandlestickSeries, {
      upColor: COLOR.up, downColor: COLOR.down,
      borderUpColor: COLOR.up, borderDownColor: COLOR.down,
      wickUpColor: COLOR.up, wickDownColor: COLOR.down,
      priceLineVisible: true, priceLineWidth: 1, priceLineStyle: LC.LineStyle.Dotted,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    this.markers = LC.createSeriesMarkers(this.candle, []);
    this.lines = new TradeLines();
    this.candle.attachPrimitive(this.lines);

    this.watermark = LC.createTextWatermark(this.chart.panes()[0], {
      horzAlign: "center", vertAlign: "center",
      lines: [{ text: "神秘股票", color: "rgba(255, 255, 255, 0.04)", fontSize: 72, fontStyle: "bold" }],
    });

    var self = this;
    this.chart.subscribeCrosshairMove(function (param) {
      if (!self.onHover || !self.game) return;
      var idx = -1;
      if (param.logical !== null && param.logical !== undefined) idx = Math.round(param.logical) + self.game.ctx;
      self.onHover(idx);
    });
    // 滾輪 / 雙指縮放之後,不再自動調整K棒寬度
    container.addEventListener("wheel", function () { self.fit = false; }, { passive: true });
    container.addEventListener("touchstart", function (e) { if (e.touches.length > 1) self.fit = false; }, { passive: true });
    // 拖曳窗格分隔線之後,尊重使用者排好的高度
    container.addEventListener("pointerdown", function (e) {
      var t = e.target;
      if (t instanceof HTMLElement && t.tagName !== "CANVAS" && t.getBoundingClientRect().height <= 10) self.userSized = true;
    });
    // 圖表容器大小改變:重算窗格高度與標籤位置
    this.roBox = new ResizeObserver(function () {
      if (!self.userSized) self.applyPaneHeights();
      self.scheduleTags();
    });
    this.roBox.observe(container);
    this.roPanes = new ResizeObserver(function () { self.scheduleTags(); });
  }

  ChartView.prototype.destroy = function () {
    [this.roBox, this.roPanes].forEach(function (ro) { if (ro) ro.disconnect(); });
    this.tags.forEach(function (t) { t.el.remove(); });
    this.tags = [];
    try { this.chart.remove(); } catch (e) { }
    this.chart = null;
  };

  /* ---------- 窗格與圖層 ---------- */
  function lineOpts(color, extra) {
    return Object.assign({ color: color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, extra || {});
  }

  ChartView.prototype.createOverlay = function (key) {
    var mk = (color, opts) => this.chart.addSeries(LC.LineSeries, lineOpts(color, opts));
    if (key === "bb") {
      return [mk(COLOR.cyan), mk("#5c6b80", { lineStyle: LC.LineStyle.Dashed }), mk(COLOR.cyan)];
    }
    return [mk(IND[key].color, { lineWidth: key === "ma200" ? 1 : 2 })];
  };

  ChartView.prototype.createPaneGroup = function (key, paneIdx) {
    var add = (def, opts) => this.chart.addSeries(def, opts, paneIdx);
    var noPrice = { priceLineVisible: false, lastValueVisible: false };
    if (key === "perf") {
      var fmt = { type: "custom", formatter: function (v) { return "$" + (v / 1000).toFixed(1) + "K"; }, minMove: 0.01 };
      var you = add(LC.LineSeries, lineOpts(COLOR.gold, { lineWidth: 2, priceFormat: fmt }));
      you.priceScale().applyOptions({ scaleMargins: { top: 0.16, bottom: 0.16 }, borderColor: "#1b222d" });
      you.createPriceLine({ price: CG.Game.INITIAL, color: "#5c6b80", lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false, title: "" });
      // 不顯示最新值標籤:兩條線經常同一價位,會和刻度標籤疊成兩層(數值改看左上角圖例)
      var bh = add(LC.LineSeries, lineOpts(COLOR.blue, { lineWidth: 2, priceFormat: fmt }));
      var tag = document.createElement("div");
      tag.className = "pane-tag";
      tag.setAttribute("aria-hidden", "true");
      tag.innerHTML = '<i style="background:' + COLOR.gold + '"></i>你<i style="background:' + COLOR.blue + '"></i>買進持有';
      this.container.appendChild(tag);
      this.tags.push({ el: tag, key: key, pane: null });
      return [you, bh];
    }
    if (key === "vol") {
      return [add(LC.HistogramSeries, Object.assign({ priceFormat: { type: "volume" } }, noPrice))];
    }
    if (key === "macd") {
      return [
        add(LC.HistogramSeries, Object.assign({ priceFormat: { type: "price", precision: 2, minMove: 0.01 } }, noPrice)),
        add(LC.LineSeries, lineOpts(COLOR.blue, { lineWidth: 2 })),
        add(LC.LineSeries, lineOpts(COLOR.orange, { lineWidth: 2 })),
      ];
    }
    if (key === "rsi") {
      var r = add(LC.LineSeries, lineOpts(COLOR.purple, { lineWidth: 2 }));
      [70, 30].forEach(function (lv) {
        r.createPriceLine({ price: lv, color: "#5c6b80", lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false, title: "" });
      });
      r.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.12 }, borderColor: "#1b222d" });
      return [r];
    }
    return [];
  };

  /**
   * 依固定順序重建所有下方面板。每次切換都整批重建,窗格編號才不會跟實際窗格錯位
   * (舊版把關掉的指標再打開時,會被畫進別的指標的窗格)。
   * active: Set of indicator keys
   */
  ChartView.prototype.rebuild = function (active) {
    var ch = this.chart, self = this;
    Object.keys(this.groups).forEach(function (k) {
      (self.groups[k] || []).forEach(function (s) { try { ch.removeSeries(s); } catch (e) { } });
    });
    this.groups = {};
    this.tags.forEach(function (t) { t.el.remove(); });
    this.tags = [];

    var paneIdx = 1;
    PANE_ORDER.forEach(function (key) {
      if (active.has(key)) self.groups[key] = self.createPaneGroup(key, paneIdx++);
    });
    ["ma20", "ma50", "ma200", "bb"].forEach(function (key) {
      if (active.has(key)) self.groups[key] = self.createOverlay(key);
    });

    var panes = ch.panes();
    PANE_ORDER.forEach(function (key, i) {
      if (key === "perf" && self.groups[key] && self.tags.length) self.tags[0].pane = panes[i + 1];
    });
    this.userSized = false;
    this.applyPaneHeights();

    this.roPanes.disconnect();
    for (var k = 1; k < panes.length; k++) {
      var el = panes[k].getHTMLElement();
      if (el) this.roPanes.observe(el);
    }
    this.scheduleTags();
  };

  /**
   * 下方窗格用固定高度,主圖吃掉剩餘的高度;圖表太矮時等比縮小下方窗格,主圖至少保留四成。
   * 直接設定每個窗格的伸縮比重(與高度成正比),不依賴當下已排版的高度。
   */
  ChartView.prototype.applyPaneHeights = function () {
    var panes = this.chart.panes(), keys = PANE_ORDER.filter(function (k) { return this.groups[k]; }, this);
    if (panes.length < 2 || !keys.length) return;
    var total = Math.max(160, this.container.clientHeight - (panes.length - 1));
    var want = keys.reduce(function (sum, key) { return sum + PANE_H[key]; }, 0);
    var mainMin = total * 0.42;
    var scale = total - want >= mainMin ? 1 : (total - mainMin) / want;
    panes[0].setStretchFactor(Math.max(mainMin, total - want * scale));
    keys.forEach(function (key, i) { panes[i + 1].setStretchFactor(PANE_H[key] * scale); });
  };

  ChartView.prototype.scheduleTags = function () {
    var self = this;
    if (this.tagFrame) return;
    this.tagFrame = requestAnimationFrame(function () { self.tagFrame = 0; self.placeTags(); });
  };

  ChartView.prototype.placeTags = function () {
    var base = this.container.getBoundingClientRect();
    this.tags.forEach(function (t) {
      var el = t.pane && t.pane.getHTMLElement();
      if (!el) return;
      t.el.style.top = Math.round(el.getBoundingClientRect().top - base.top + 5) + "px";
    });
  };

  /** 綁定一局遊戲(active: 要顯示的指標鍵) */
  ChartView.prototype.setGame = function (game, calc, active) {
    this.game = game;
    this.calc = calc;
    this.fit = true;
    this.fresh = true;
    this.chart.timeScale().applyOptions({ visible: false });
    if (this.watermark) this.watermark.applyOptions({ visible: true });
    this.rebuild(active);
  };

  /** 回到首頁:清空圖上的資料,只留一張空圖。 */
  ChartView.prototype.clear = function () {
    this.game = null;
    this.calc = null;
    this.candle.setData([]);
    this.markers.setMarkers([]);
    this.lines.set([], 0);
    this.rebuild(new Set());
  };

  /* ---------- 資料點 ---------- */
  function linePoints(arr, bars, from, to) {
    var a = [];
    for (var i = from; i <= to; i++) {
      if (arr[i] != null) a.push({ time: bars[i].t, value: Math.round(arr[i] * 10000) / 10000 });
    }
    return a;
  }

  ChartView.prototype.refresh = function () {
    var g = this.game, c = this.calc, S = this.groups, bars = g.bars;
    if (!g) return;
    var from = g.ctx, to = g.ended ? g.lastIdx : g.cursor, i, a;
    var scale = this.chart.timeScale();

    // 更新前先判斷畫面是否還貼著最新一根;使用者若已往左捲離右端,就不要把畫面拉回來
    var range = scale.getVisibleLogicalRange();
    var atEnd = this.fresh || !range || range.to >= to - g.ctx - 3;
    this.fresh = false;

    a = [];
    for (i = from; i <= to; i++) a.push({ time: bars[i].t, open: bars[i].o, high: bars[i].h, low: bars[i].l, close: bars[i].c });
    this.candle.setData(a);

    if (S.ma20) S.ma20[0].setData(linePoints(c.ma20, bars, from, to));
    if (S.ma50) S.ma50[0].setData(linePoints(c.ma50, bars, from, to));
    if (S.ma200) S.ma200[0].setData(linePoints(c.ma200, bars, from, to));
    if (S.bb) {
      S.bb[0].setData(linePoints(c.bbU, bars, from, to));
      S.bb[1].setData(linePoints(c.bbM, bars, from, to));
      S.bb[2].setData(linePoints(c.bbL, bars, from, to));
    }
    if (S.vol) {
      a = [];
      for (i = from; i <= to; i++) {
        a.push({ time: bars[i].t, value: bars[i].v, color: bars[i].c >= bars[i].o ? "rgba(46, 189, 133, 0.45)" : "rgba(246, 70, 93, 0.45)" });
      }
      S.vol[0].setData(a);
    }
    if (S.macd) {
      a = [];
      for (i = from; i <= to; i++) {
        if (c.macdH[i] == null) continue;
        a.push({ time: bars[i].t, value: c.macdH[i], color: c.macdH[i] >= 0 ? "rgba(46, 189, 133, 0.5)" : "rgba(246, 70, 93, 0.5)" });
      }
      S.macd[0].setData(a);
      S.macd[1].setData(linePoints(c.macdD, bars, from, to));
      S.macd[2].setData(linePoints(c.macdS, bars, from, to));
    }
    if (S.rsi) S.rsi[0].setData(linePoints(c.rsi, bars, from, to));
    if (S.perf) {
      var start = g.firstFuture - 1, you = [], bh = [];
      for (i = 0; i < g.eq.length; i++) {
        you.push({ time: bars[start + i].t, value: Math.round(g.eq[i] * 100) / 100 });
        bh.push({ time: bars[start + i].t, value: Math.round(g.bh[i] * 100) / 100 });
      }
      S.perf[0].setData(you);
      S.perf[1].setData(bh);
    }

    // 買賣標記與連線
    a = [];
    g.trades.forEach(function (t) {
      a.push({
        time: bars[t.i].t,
        position: t.side === "buy" ? "belowBar" : "aboveBar",
        color: t.side === "buy" ? COLOR.up : COLOR.down,
        shape: t.side === "buy" ? "arrowUp" : "arrowDown",
        text: t.forced ? "結算" : (t.side === "buy" ? "買" : "賣"),
      });
    });
    this.markers.setMarkers(a);
    this.lines.set(CG.Game.trips(g).map(function (t) {
      return {
        i1: t.buy.i, p1: t.buy.price,
        i2: t.sell ? t.sell.i : g.cursor, p2: t.sell ? t.sell.price : bars[g.cursor].c,
        ret: t.ret, open: t.open, label: (t.ret >= 0 ? "+" : "") + (t.ret * 100).toFixed(1) + "%",
      };
    }), g.ctx);

    if (!g.ended) {
      // 自動縮放:讓「歷史 + 已揭開的K棒」盡量塞滿寬度,短局從頭到尾都不用捲動
      if (this.fit) {
        var plot = this.container.clientWidth - this.candle.priceScale().width();
        var shown = g.hist + (to - g.firstFuture + 1) + RIGHT_OFFSET + 1.7;   // 多留一點,最左邊的K棒才不會被切一半
        scale.applyOptions({ barSpacing: Math.min(SPACING_MAX, Math.max(SPACING_MIN, plot / shown)) });
      }
      if (atEnd) scale.scrollToPosition(RIGHT_OFFSET, false);
    }
    this.scheduleTags();
  };

  /** 局結束:顯示日期軸、收起水印、整張圖塞進畫面 */
  ChartView.prototype.reveal = function () {
    this.chart.timeScale().applyOptions({ visible: true });
    if (this.watermark) this.watermark.applyOptions({ visible: false });
    this.refresh();
    this.chart.timeScale().fitContent();
    this.scheduleTags();
  };

  CG.ChartView = ChartView;
  CG.IND = IND;
  CG.IND_ORDER = IND_ORDER;
  CG.PANE_ORDER = PANE_ORDER;
  CG.IND_DEFAULTS = DEFAULT_ON;
  CG.COLORS = COLOR;
  CG.CHART_BG = COLOR.bg;
  CG.tickLabel = tickLabel;
  CG.fullDate = fullDate;
})();
