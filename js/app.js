/* ===== 介面層:畫面更新、事件、遊戲流程 ===== */
(function () {
  "use strict";
  var CG = window.CG, D = CG.Data, G = CG.Game, S = CG.Store, IND = CG.IND;
  var LC = window.LightweightCharts;
  var $ = function (id) { return document.getElementById(id); };
  var SPEEDS = [1, 5, 20];
  var TIE_EPS = 5e-5;
  var SECTOR_ZH = {
    "Communication Services": "通訊服務",
    "Consumer Discretionary": "非必需消費",
    "Consumer Staples": "必需消費",
    "Energy": "能源",
    "Financials": "金融",
    "Health Care": "醫療保健",
    "Industrials": "工業",
    "Information Technology": "資訊科技",
    "Materials": "原物料",
    "Real Estate": "不動產",
    "Utilities": "公用事業",
  };

  var state = {
    game: null, meta: null, calc: null, view: null,
    speed: 1, auto: null,
    active: new Set(),           // 開啟中的圖表工具
    periodKey: "6m",
    practice: false,             // 練習局(重玩同一張圖):不計入戰績
    challenge: null,             // 由連結帶入的挑戰 {t, p, d}
    loading: false, hover: -1,
    lastEquity: G.INITIAL, fresh: true,
    resChart: null, trackFilter: "all",
    newArmed: 0, clearArmed: 0,   // 「換一檔」「清除紀錄」兩段式確認的計時器
  };
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------- 格式化 ---------- */
  function fmtMoney(x, dp) {
    dp = dp == null ? 2 : dp;
    return "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtSignedMoney(x) { return (x > 0 ? "+" : x < 0 ? "-" : "") + fmtMoney(x); }
  function fmtSigned(x, dp, suffix) {       // x 已是欲顯示的數值(例如百分比數字)
    return (x > 0 ? "+" : x < 0 ? "-" : "") + Math.abs(x).toFixed(dp == null ? 2 : dp) + (suffix || "");
  }
  function fmtVol(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  }
  function cls(v) { return v > 1e-9 ? "pos" : v < -1e-9 ? "neg" : "flat"; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function round4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }
  function setText(el, text, colorCls) {
    el.textContent = text;
    el.className = (el.getAttribute("data-base") || "") + (colorCls ? " " + colorCls : "");
  }
  function announce(msg) { $("live").textContent = msg; }
  function periodLabel(p) { return p.label + " · " + (p.weekly ? "週K" : "日K"); }
  function stockLabel(meta) { return (meta.z ? meta.z + " " : "") + meta.s; }

  /* ---------- 對話框 ---------- */
  var canTransitionDisplayMemo;
  function canTransitionDisplay() {
    if (canTransitionDisplayMemo !== undefined) return canTransitionDisplayMemo;
    if (!window.CSS || !CSS.supports("transition-behavior", "allow-discrete")) return (canTransitionDisplayMemo = false);
    var probe = document.createElement("div");
    // 故意用簡寫:不認得 allow-discrete 的瀏覽器會整句丟掉,display: none 立即生效
    probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
    document.body.appendChild(probe);
    getComputedStyle(probe).display;
    probe.style.display = "none";
    canTransitionDisplayMemo = getComputedStyle(probe).display === "block";
    probe.remove();
    return canTransitionDisplayMemo;
  }
  function supportsTopLayerExit() {
    return !!(window.CSS && CSS.supports("overlay", "auto")) && canTransitionDisplay();
  }
  function openDialog(d) { if (!d.open) d.showModal(); }

  /** 關閉對話框並播放離場動畫;不支援 display 過渡的瀏覽器改用 data-closing。 */
  function closeDialog(d) {
    if (!d || !d.open) return Promise.resolve();
    if (supportsTopLayerExit()) { d.close(); return Promise.resolve(); }
    d.setAttribute("data-closing", "");
    var animations = d.getAnimations({ subtree: true });
    var done = animations.length
      ? Promise.race([Promise.allSettled(animations.map(function (a) { return a.finished; })), new Promise(function (r) { setTimeout(r, 600); })])
      : Promise.resolve();
    return done.then(function () {
      if (!d.hasAttribute("data-closing")) return;   // 期間又被打開了
      d.removeAttribute("data-closing");
      d.close();
    });
  }

  /* ---------- 開始畫面 ---------- */
  function buildPeriodGrid() {
    var html = G.ORDER.map(function (k) {
      var p = G.PERIODS[k];
      return '<button type="button" class="period-opt" data-k="' + k + '" aria-pressed="false">' +
        '<span class="p-name">' + p.label + '</span><span class="p-sub">' + (p.weekly ? "週K" : "日K") + "</span></button>";
    }).join("");
    html += '<button type="button" class="period-opt" data-k="random" aria-pressed="false"><span class="p-name">隨機</span><span class="p-sub">任意期間</span></button>';
    $("periodGrid").innerHTML = html;
    setPeriod(state.periodKey);
  }
  function setPeriod(key) {
    state.periodKey = key;
    Array.prototype.forEach.call($("periodGrid").children, function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-k") === key));
    });
    S.saveSetting("period", key);
  }
  function renderUniverseMeta() {
    var list = D.index();
    if (!list.length) { $("universeMeta").textContent = ""; return; }
    var sp = list.filter(function (s) { return s.sp; }).length;
    var first = list.reduce(function (m, s) { return s.f < m ? s.f : m; }, list[0].f).slice(0, 4);
    var last = list.reduce(function (m, s) { return s.l > m ? s.l : m; }, list[0].l);
    $("universeMeta").textContent = list.length + " 檔美股(" + sp + " 檔為 S&P 500 成分股)· " + first + "–" + last.slice(0, 4) + " 年日K · 資料截至 " + last;
  }

  /** 網址 ?t=股票&p=期間&d=挑戰區間第一天 的挑戰連結 */
  function readChallenge() {
    var q = new URLSearchParams(location.search), t = q.get("t"), p = q.get("p"), d = q.get("d");
    if (!t && !p && !d) return null;
    if (!t || !p || !d || !G.PERIODS[p] || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !D.meta(t)) return { invalid: true };
    return { t: t, p: p, d: d };
  }
  function shareUrl() {
    var g = state.game, base = location.href.split(/[?#]/)[0];
    return base + "?t=" + encodeURIComponent(state.meta.t) + "&p=" + g.period.key + "&d=" + g.bars[g.firstFuture].t;
  }
  function cleanUrl() {
    try { history.replaceState(null, "", location.pathname); } catch (e) { }
  }

  /* ---------- 開局 ---------- */
  function loadGame(meta, period, date) {
    return D.load(meta.t).then(function (raw) {
      var daily = D.dailyBars(raw), bars, cuts;
      if (period.weekly) {
        var wk = D.weeklyBars(daily, raw.x);
        bars = wk.bars; cuts = wk.cuts;
      } else {
        bars = daily; cuts = raw.x || [];
      }
      var need = G.total(period), lead = period.ctx + period.hist, start = null;
      if (date) {
        var idx = -1;
        for (var i = 0; i < bars.length; i++) if (bars[i].t === date) { idx = i; break; }
        start = idx - lead;
        if (idx < 0 || !D.windowIsValid(bars.length, cuts, start, need)) throw fail("link");
      } else {
        start = D.pickWindow(bars.length, cuts, need);   // 只會落在單一連續區段內
        if (start === null) throw fail("history");
      }
      return { bars: bars, start: start };
    }, function () { throw fail("network"); });
  }
  function fail(code) { var e = new Error(code); e.code = code; return e; }

  /**
   * opts.period: 期間鍵(不給或 "random" 就隨機)
   * opts.ticker / opts.date: 指定股票與挑戰區間第一天(挑戰連結、重玩同一張圖)
   * opts.practice: 練習局,不計入戰績
   */
  function startGame(opts) {
    opts = opts || {};
    if (state.loading) return;
    var period = G.PERIODS[opts.period] || G.PERIODS[G.ORDER[Math.floor(Math.random() * G.ORDER.length)]];
    var fixed = !!opts.ticker, meta = fixed ? D.meta(opts.ticker) : null, attempt = 0;
    if (fixed && !meta) { failStart(fail("link")); return; }

    state.loading = true;
    $("btnStart").disabled = true;
    $("startStatus").textContent = "";

    function tryOnce(m) {
      return loadGame(m, period, opts.date).catch(function (err) {
        // 隨機選到的股票若歷史不足(資料更新後可能發生),換一檔再試
        if (!fixed && err.code === "history" && attempt++ < 8) return pickAndLoad();
        throw err;
      }).then(function (r) { return { bars: r.bars, start: r.start, meta: m }; });
    }
    function pickAndLoad() {
      if (fixed) return tryOnce(meta);                  // 挑戰連結 / 重玩:沿用指定的股票
      var pool = D.eligible(period, G.total(period));
      if (!pool.length) return Promise.reject(fail("pool"));
      return tryOnce(pool[Math.floor(Math.random() * pool.length)]);
    }

    pickAndLoad().then(function (out) {
      beginGame(out.bars, out.start, period, out.meta, !!opts.practice);
    }, failStart);
  }
  function failStart(err) {
    state.loading = false;
    $("btnStart").disabled = false;
    var msgs = {
      link: "這個挑戰連結對不上目前的資料(股票歷史可能已更新),請改用隨機開局。",
      pool: "這個期間目前沒有歷史夠長的股票,請換一個期間。",
      history: "選到的股票歷史長度不足,請再試一次。",
      network: "股票資料載入失敗,請檢查網路連線後再試一次。",
    };
    if (err.code === "link" && state.challenge) {        // 連結失效:直接退回隨機模式,使用者按一下就能開始
      state.challenge = null;
      $("challengeBox").hidden = true;
      $("btnStart").textContent = "開始挑戰";
      msgs.link = "這個挑戰連結對不上目前的資料(股票歷史可能已更新),已改為隨機開局。";
    }
    $("startStatus").textContent = msgs[err.code] || "發生錯誤,請再試一次。";
    openDialog($("startDialog"));
  }

  function beginGame(bars, start, period, meta, practice) {
    stopAuto();
    disarmNew();
    var g = state.game = G.create(bars, period, start);
    state.meta = meta;
    state.practice = practice;
    state.calc = window.Ind.compute(g.bars);
    state.hover = -1;
    state.lastEquity = G.INITIAL;
    state.fresh = true;

    state.view.setGame(g, state.calc, state.active);
    closeDialog($("resultDialog"));
    closeDialog($("startDialog"));
    $("playControls").hidden = false;
    $("endControls").hidden = true;
    $("btnNew").hidden = false;
    $("practiceTag").hidden = !practice;
    $("modeTag").textContent = periodLabel(period);
    $("modeTag").className = "badge";
    $("challengeBox").hidden = true;
    state.challenge = null;
    cleanUrl();

    state.loading = false;
    $("btnStart").disabled = false;
    $("startStatus").textContent = "";
    state.view.refresh();
    sync();
    renderTrips();
    renderLegend();
    if (window.scrollTo) window.scrollTo(0, 0);      // 窄螢幕是直向排版:開局時回到圖表
    announce("新的一局開始:" + periodLabel(period));
  }

  /* ---------- 操作 ---------- */
  function doBuy() {
    var g = state.game;
    if (!g || !G.canBuy(g)) return;
    disarmNew();
    var filled = G.order(g, "buy");
    afterAction(filled ? "買進" : null);
  }
  function doSell() {
    var g = state.game;
    if (!g || !G.canSell(g)) return;
    disarmNew();
    var filled = G.order(g, "sell");
    afterAction(filled ? "賣出" : null);
  }
  function doStep(n) {
    var g = state.game;
    if (!g || g.ended) return;
    if (n > 1) disarmNew();
    G.step(g, n);
    afterAction(null);
  }
  function afterAction(filled) {
    var g = state.game, trips = G.trips(g);
    state.view.refresh();
    sync();
    renderTrips();
    renderLegend();
    if (filled === "買進") {
      announce("已買進,成交價 " + fmtMoney(g.cost));
    } else if (filled === "賣出" && trips.length) {
      var t = trips[trips.length - 1];
      announce("已賣出,成交價 " + fmtMoney(t.sell.price) + ",這個回合 " + fmtSigned(t.ret * 100, 2, "%"));
    }
    if (g.ended) onEnd();
  }
  function onEnd() {
    var g = state.game;
    stopAuto();
    if (!state.practice) S.addRecord(buildRecord(g));
    state.view.reveal();
    state.hover = -1;
    $("playControls").hidden = true;
    $("endControls").hidden = false;
    $("btnNew").hidden = true;
    sync();
    renderTrips();
    renderLegend();
    showResult();
  }
  function goHome() {
    stopAuto();
    disarmNew();
    state.game = null;
    state.meta = null;
    state.hover = -1;
    state.view.clear();
    $("playControls").hidden = true;
    $("endControls").hidden = true;
    $("btnNew").hidden = true;
    $("practiceTag").hidden = true;
    $("modeTag").textContent = "ChartGame";
    $("modeTag").className = "badge badge-muted";
    $("legend").innerHTML = "";
    $("tripList").innerHTML = "";
    $("pMv").textContent = "—"; $("pUnreal").textContent = "—"; $("pUnreal").className = ""; $("pReal").textContent = "—";
    $("posLine").hidden = true;
    $("hudStock").textContent = "???";
    $("hudStock").classList.add("hud-mystery");
    $("hudEquity").textContent = fmtMoney(G.INITIAL);
    ["hudRet", "hudBh", "hudDelta", "hudProg"].forEach(function (id) { setText($(id), $(id).id === "hudProg" ? "0 / 0" : "0.00%", "flat"); });
    $("hudDeltaLabel").textContent = "差距";
    $("progressFill").style.width = "0%";
    closeDialog($("resultDialog"));
    openDialog($("startDialog"));
  }

  /* 「換一檔」:第一次點只提示,3 秒內再點才真的放棄這一局 */
  function disarmNew() {
    clearTimeout(state.newArmed);
    state.newArmed = 0;
    $("btnNewLabel").textContent = "換一檔";
    $("btnNew").setAttribute("aria-label", "換一檔");
    $("btnNew").classList.remove("btn-danger", "armed");
  }
  function onNewClick() {
    var g = state.game;
    if (!g || g.ended || state.loading) return;
    if (!state.newArmed) {
      $("btnNewLabel").textContent = "確定放棄這一局?";
      $("btnNew").setAttribute("aria-label", "確定放棄這一局?");
      $("btnNew").classList.add("btn-danger", "armed");
      state.newArmed = setTimeout(disarmNew, 3000);
      return;
    }
    disarmNew();
    startGame({ period: g.period.key });
  }

  /* ---------- 自動播放 ---------- */
  function startAuto() {
    var g = state.game;
    if (state.auto || !g || g.ended) return;
    disarmNew();
    $("btnAuto").setAttribute("aria-pressed", "true");
    $("btnAutoIcon").setAttribute("href", "#i-pause");
    $("btnAutoLabel").textContent = "暫停";
    announce("自動播放");
    (function tick() {
      state.auto = setTimeout(function () {
        state.auto = null;
        if (!state.game || state.game.ended) { stopAuto(); return; }
        G.step(state.game, 1);
        afterAction(null);
        if (!state.game.ended) tick();
      }, 150);
    })();
  }
  function stopAuto() {
    clearTimeout(state.auto);
    state.auto = null;
    $("btnAuto").setAttribute("aria-pressed", "false");
    $("btnAutoIcon").setAttribute("href", "#i-play");
    $("btnAutoLabel").textContent = "自動";
  }
  function setSpeed(x) {
    state.speed = x;
    S.saveSetting("speed", x);
    $("stepLabel").textContent = "快轉 " + x + " 根";
    Array.prototype.forEach.call($("speedChips").children, function (b) {
      b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-x")) === x));
    });
  }

  /* ---------- 畫面同步 ---------- */
  function pulse(el, dir) {
    if (!el.animate) return;
    el.getAnimations().forEach(function (a) { a.cancel(); });
    el.animate([{ color: dir > 0 ? "var(--up)" : dir < 0 ? "var(--down)" : "var(--text)" }, { color: "var(--text)" }],
      { duration: 520, easing: "ease-out" });
  }

  function sync() {
    var g = state.game;
    if (!g) return;
    var ended = g.ended;
    var eq = ended ? g.finalEquity : G.equity(g);
    var ret = ended ? g.ret : eq / G.INITIAL - 1;
    var bh = ended ? g.bhFinal : G.bhRet(g);
    var delta = ret - bh, rev = G.revealed(g);

    if (!state.fresh) pulse($("hudEquity"), eq - state.lastEquity);
    state.lastEquity = eq;
    state.fresh = false;
    $("hudEquity").textContent = fmtMoney(eq);
    setText($("hudRet"), fmtSigned(ret * 100, 2, "%"), cls(ret));
    setText($("hudBh"), fmtSigned(bh * 100, 2, "%"), cls(bh));
    var tie = Math.abs(delta) < TIE_EPS;
    $("hudDeltaLabel").textContent = tie ? "差距" : delta > 0 ? "領先" : "落後";
    setText($("hudDelta"), (Math.abs(delta) * 100).toFixed(2) + "pp", tie ? "flat" : cls(delta));
    $("hudProg").textContent = rev + " / " + g.play;
    $("progressFill").style.width = Math.min(100, rev / g.play * 100) + "%";
    $("progressFill").parentElement.classList.toggle("is-done", ended);

    $("hudStock").textContent = ended ? stockLabel(state.meta) : "???";
    $("hudStock").classList.toggle("hud-mystery", !ended);

    var mv = g.shares * g.bars[g.cursor].c, open = null, realized = 0, closed = 0;
    G.trips(g).forEach(function (t) { if (t.open) open = t; else { realized += t.pnl; closed++; } });
    $("pCash").textContent = fmtMoney(g.cash);
    setText($("pMv"), g.shares > 0 ? fmtMoney(mv) : "—", "");
    $("pUnreal").className = open ? cls(open.pnl) : "";
    $("pUnreal").innerHTML = open
      ? fmtSignedMoney(open.pnl) + "<small>" + fmtSigned(open.ret * 100, 2, "%") + "</small>"
      : "—";
    setText($("pReal"), closed ? fmtSignedMoney(realized) : "—", closed ? cls(realized) : "");
    var pos = $("posLine");
    pos.hidden = g.shares === 0;
    pos.textContent = g.shares > 0 ? "持有 " + g.shares.toFixed(4) + " 股 · 成本 " + fmtMoney(g.cost) : "";

    $("btnBuy").disabled = !G.canBuy(g);
    $("btnSell").disabled = !G.canSell(g);
    $("btnStep").disabled = ended;
    $("btnAuto").disabled = ended;
  }

  function renderTrips() {
    var g = state.game, list = $("tripList");
    if (!g || !g.trades.length) { list.innerHTML = ""; return; }
    var when = function (i) { return g.ended ? g.bars[i].t : "第 " + (i - g.firstFuture + 1) + " 根"; };
    list.innerHTML = G.trips(g).reverse().map(function (t) {
      return '<li class="trip">' +
        '<span class="trip-side ' + (t.open ? "h" : "s") + '">' + (t.open ? "持有中" : "已平倉") + "</span>" +
        '<span class="trip-route">買 ' + fmtMoney(t.buy.price) + " → " +
        (t.sell ? "賣 " + fmtMoney(t.sell.price) : "現價 " + fmtMoney(g.bars[g.cursor].c)) +
        "<small>" + when(t.buy.i) + " → " + (t.sell ? when(t.sell.i) : "現在") + "</small></span>" +
        '<span class="trip-pnl ' + cls(t.pnl) + '">' + fmtSignedMoney(t.pnl) +
        "<small>" + fmtSigned(t.ret * 100, 2, "%") + "</small></span></li>";
    }).join("");
  }

  function renderLegend() {
    var g = state.game, el = $("legend");
    if (!g) { el.innerHTML = ""; return; }
    var i = state.hover, max = g.ended ? g.lastIdx : g.cursor;
    if (!(i >= g.ctx && i <= max)) i = g.cursor;
    var b = g.bars[i], prev = i > 0 ? g.bars[i - 1].c : null;
    var chg = prev ? b.c / prev - 1 : 0, rel = i - g.firstFuture + 1;
    var tag = g.ended ? b.t : (rel > 0 ? "第 " + rel + " 根" : "歷史");
    var html = '<span class="lg-tag' + (g.ended ? " done" : "") + '">' + esc(tag) + "</span>" +
      ' 開 <b class="' + cls(chg) + '">' + b.o.toFixed(2) + "</b>" +
      ' 高 <b class="' + cls(chg) + '">' + b.h.toFixed(2) + "</b>" +
      ' 低 <b class="' + cls(chg) + '">' + b.l.toFixed(2) + "</b>" +
      ' 收 <b class="' + cls(chg) + '">' + b.c.toFixed(2) + "</b>" +
      ' <b class="' + cls(chg) + '">' + fmtSigned(chg * 100, 2, "%") + "</b> 量 " + fmtVol(b.v);

    var c = state.calc, on = state.view.groups, ind = [];
    function add(name, arr, color) {
      if (arr[i] != null) ind.push('<b style="color:' + color + '">' + name + " " + arr[i].toFixed(2) + "</b>");
    }
    if (on.ma20) add("MA20", c.ma20, IND.ma20.color);
    if (on.ma50) add("MA50", c.ma50, IND.ma50.color);
    if (on.ma200) add("MA200", c.ma200, IND.ma200.color);
    if (on.rsi && c.rsi[i] != null) ind.push('<b style="color:' + IND.rsi.color + '">RSI ' + c.rsi[i].toFixed(1) + "</b>");
    if (ind.length) html += '<span class="lg-ind">' + ind.join(" · ") + "</span>";

    if (on.perf) {
      var k = i - (g.firstFuture - 1);
      if (k >= 0) {
        html += '<span class="lg-perf"><b style="color:' + CG.COLORS.gold + '">你 ' + fmtMoney(g.eq[k]) +
          " (" + fmtSigned((g.eq[k] / G.INITIAL - 1) * 100, 2, "%") + ')</b> · <b style="color:' + CG.COLORS.blue +
          '">買進持有 ' + fmtMoney(g.bh[k]) + " (" + fmtSigned((g.bh[k] / G.INITIAL - 1) * 100, 2, "%") + ")</b></span>";
      }
    }
    el.innerHTML = html;
  }

  /* ---------- 結算 ---------- */
  function buildRecord(g) {
    var st = G.stats(g), meta = state.meta;
    return {
      v: 2, ts: Date.now(), p: g.period.key,
      t: meta.t, n: meta.n, z: meta.z, sp: meta.sp,
      r: round4(g.ret), b: round4(g.bhFinal), x: round4(st.excess),
      w: g.win ? 1 : 0, e: g.tie ? 1 : 0, k: g.trades.length, rt: st.roundTrips,
      dd: round4(st.maxDrawdown), bd: round4(st.bhMaxDrawdown), tim: round4(st.timeInMarket),
      bt: round4(st.best), wt: round4(st.worst), from: st.from, to: st.to,
    };
  }
  function statCell(label, value, sub, colorCls) {
    return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value ' + (colorCls || "") + '">' + value +
      '</div><div class="stat-sub">' + sub + "</div></div>";
  }
  function showResult() {
    var g = state.game, st = G.stats(g), meta = state.meta;
    var kind = g.tie ? "tie" : g.win ? "win" : "lose";
    $("verdictBox").setAttribute("data-result", kind);
    $("verdictIcon").setAttribute("href", kind === "win" ? "#i-trophy" : kind === "lose" ? "#i-down" : "#i-equals");
    $("resVerdict").textContent = kind === "win" ? "你擊敗了買進持有!" : kind === "lose" ? "買進持有贏了這一局" : "平手,報酬一模一樣";
    $("resSub").textContent = kind === "tie" ? "你和買進持有的報酬相同"
      : (kind === "win" ? "領先 " : "落後 ") + (Math.abs(st.excess) * 100).toFixed(2) + " 個百分點";

    var zhName = meta.z && meta.z !== meta.n ? meta.z : "";      // 中文名與英文名相同(如 AT&T)就只顯示一次
    $("resZh").textContent = zhName || meta.n;
    $("resEn").textContent = zhName ? meta.n : "";
    var chips = '<span class="chip chip-ticker">' + esc(meta.s) + "</span>" +
      (meta.g ? '<span class="chip">' + esc(SECTOR_ZH[meta.g] || meta.g) + "</span>" : "") +
      (meta.sp ? '<span class="chip chip-sp">S&amp;P 500</span>' : "");
    $("resChips").innerHTML = chips;
    $("resPeriod").textContent = "挑戰區間 " + st.from + " ~ " + st.to + " · " + (g.period.weekly ? "週K" : "日K") + " · " + g.play + " 根";

    var traded = st.roundTrips > 0;
    $("resStats").innerHTML =
      statCell("你的報酬", fmtSigned(st.ret * 100, 2, "%"), "期末資產 " + fmtMoney(st.finalEquity), cls(st.ret)) +
      statCell("買進持有報酬", fmtSigned(st.bhRet * 100, 2, "%"), "期末資產 " + fmtMoney(G.INITIAL * (1 + st.bhRet)), cls(st.bhRet)) +
      statCell("勝負差距", fmtSigned(st.excess * 100, 2, " pp"), st.tie ? "平手" : st.win ? "你領先" : "你落後", st.tie ? "flat" : cls(st.excess)) +
      statCell("最大回撤 · 你", fmtSigned(st.maxDrawdown * 100, 1, "%"), "買進持有 " + fmtSigned(st.bhMaxDrawdown * 100, 1, "%"), cls(st.maxDrawdown)) +
      statCell("持股時間", (st.timeInMarket * 100).toFixed(0) + "%", st.roundTrips + " 個買賣回合", "flat") +
      (traded
        ? statCell("最佳 / 最差交易", fmtSigned(st.best * 100, 1, "%") + " / " + fmtSigned(st.worst * 100, 1, "%"), "以每個買賣回合計", "flat")
        : statCell("交易", "0", "整局都沒有進場", "flat"));

    $("shareLink").value = shareUrl();
    // 先開啟對話框再畫圖:對話框沒顯示時寬度是 0,圖表會排不下
    openDialog($("resultDialog"));
    $("resultDialog").focus();        // 焦點放在對話框本身:連按空白鍵快轉時不會誤觸任何按鈕
    requestAnimationFrame(function () {
      renderResultChart(g);
      if (kind === "win") confetti();
    });
    announce($("resVerdict").textContent + "。" + $("resSub").textContent);
  }

  function destroyResultChart() {
    if (state.resChart) { try { state.resChart.remove(); } catch (e) { } state.resChart = null; }
    $("resChart").querySelectorAll(".res-tag").forEach(function (el) { el.remove(); });
  }
  function renderResultChart(g) {
    destroyResultChart();
    var box = $("resChart");
    var tag = document.createElement("span");
    tag.className = "res-tag";
    tag.setAttribute("aria-hidden", "true");
    tag.innerHTML = '<i style="background:' + CG.COLORS.gold + '"></i>你<i style="background:' + CG.COLORS.blue + '"></i>買進持有';
    box.appendChild(tag);
    var fmt = { type: "custom", formatter: function (v) { return "$" + (v / 1000).toFixed(1) + "K"; }, minMove: 0.01 };
    var line = function (color) {
      return state.resChart.addSeries(LC.LineSeries, {
        color: color, lineWidth: 2, priceFormat: fmt,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    };
    state.resChart = LC.createChart(box, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: CG.CHART_BG },
        textColor: CG.COLORS.text, fontSize: 11,
        fontFamily: 'Inter, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif',
      },
      grid: { vertLines: { color: "rgba(255,255,255,0.035)" }, horzLines: { color: "rgba(255,255,255,0.045)" } },
      rightPriceScale: { borderColor: "#1b222d", scaleMargins: { top: 0.14, bottom: 0.14 } },
      timeScale: { visible: true, borderColor: "#1b222d", timeVisible: false, secondsVisible: false, tickMarkFormatter: CG.tickLabel },
      localization: { locale: "zh-TW", timeFormatter: CG.fullDate },
      crosshair: { mode: LC.CrosshairMode.Normal,
        vertLine: { color: "#55607a", style: LC.LineStyle.Dashed, labelBackgroundColor: "#2b3445" },
        horzLine: { color: "#55607a", style: LC.LineStyle.Dashed, labelBackgroundColor: "#2b3445" } },
      handleScroll: false, handleScale: false,
    });
    var base = g.firstFuture - 1, map = function (arr) {
      return arr.map(function (v, k) { return { time: g.bars[base + k].t, value: Math.round(v * 100) / 100 }; });
    };
    var you = line(CG.COLORS.gold), bh = line(CG.COLORS.blue);
    you.createPriceLine({ price: G.INITIAL, color: "#5c6b80", lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false, title: "" });
    bh.setData(map(g.bh));
    you.setData(map(g.eq));
    var fit = function () { if (state.resChart) state.resChart.timeScale().fitContent(); };
    fit();
    requestAnimationFrame(fit);       // 進場動畫期間尺寸才定下來,再對齊一次
  }

  function confetti() {
    if (reduceMotion.matches) return;
    var cv = $("confetti"), ctx = cv.getContext("2d");
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
    var colors = ["#f0b90b", "#2ebd85", "#4c8dff", "#ffd54a", "#ffffff"], parts = [];
    for (var i = 0; i < 90; i++) {
      parts.push({
        x: innerWidth / 2 + (Math.random() - 0.5) * 180, y: innerHeight * 0.32,
        vx: (Math.random() - 0.5) * 15, vy: -Math.random() * 13 - 5,
        w: 5 + Math.random() * 5, h: 3 + Math.random() * 3,
        a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.4,
        c: colors[i % colors.length],
      });
    }
    var t0 = performance.now();
    (function frame(now) {
      var t = (now - t0) / 1900;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      if (t >= 1 || !$("resultDialog").open) return;
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      parts.forEach(function (p) {
        p.vy += 0.32; p.x += p.vx; p.y += p.vy; p.a += p.va;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      requestAnimationFrame(frame);
    })(t0);
  }

  /* ---------- 戰績 ---------- */
  function renderTrack() {
    var all = S.track(), f = state.trackFilter;
    var rows = f === "all" ? all : all.filter(function (r) { return r.p === f; });
    var wins = 0, losses = 0, ties = 0, ex = 0, tim = 0, timN = 0, retSum = 0, bhSum = 0;
    rows.forEach(function (r) {
      if (r.w) wins++; else if (r.e || Math.abs(r.r - r.b) < TIE_EPS) ties++; else losses++;
      ex += r.r - r.b; retSum += r.r; bhSum += r.b;
      if (typeof r.tim === "number") { tim += r.tim; timN++; }
    });
    var n = rows.length;
    var kpi = function (label, value, sub, colorCls) {
      return '<div class="kpi"><div class="kpi-label">' + label + '</div><div class="kpi-value ' + (colorCls || "") + '">' + value +
        '</div><div class="kpi-sub">' + sub + "</div></div>";
    };
    $("trackStats").innerHTML = !n ? '<p class="kpi-sub">還沒有完賽紀錄,先玩一局吧。</p>' :
      kpi("局數", String(n), wins + " 勝 " + ties + " 平 " + losses + " 敗") +
      kpi("勝率", wins + losses ? Math.round(wins / (wins + losses) * 100) + "%" : "—", "平手不計入", wins ? "pos" : "flat") +
      kpi("平均超額報酬", fmtSigned(ex / n * 100, 2, " pp"), "你的報酬 − 買進持有", cls(ex)) +
      kpi("平均報酬", fmtSigned(retSum / n * 100, 2, "%"), "買進持有 " + fmtSigned(bhSum / n * 100, 2, "%"), cls(retSum));

    $("trackFilters").innerHTML = ['<button type="button" class="filter-btn" data-f="all" aria-pressed="' + (f === "all") + '">全部 ' + all.length + "</button>"].concat(
      G.ORDER.map(function (k) {
        var count = all.filter(function (r) { return r.p === k; }).length;
        return '<button type="button" class="filter-btn" data-f="' + k + '" aria-pressed="' + (f === k) + '">' +
          G.PERIODS[k].label + " " + count + "</button>";
      })).join("");

    $("trackBody").innerHTML = !n
      ? '<tr><td colspan="8" class="track-empty">這個範圍還沒有紀錄。</td></tr>'
      : rows.slice().reverse().map(function (r) {
        var d = new Date(r.ts);
        var date = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
        var name = esc((r.z ? r.z + " " : "") + r.t);
        // 平手優先看紀錄旗標;沒有旗標時用報酬判斷,避免同額報酬被標成敗
        var tie = !!r.e || (!r.w && Math.abs(r.r - r.b) < TIE_EPS);
        var result = tie ? '<span style="color:var(--gold)">平</span>' : r.w ? '<span class="pos">勝</span>' : '<span class="neg">敗</span>';
        return "<tr><th scope=\"row\">" + date + "</th><td>" + name + "</td><td>" + esc(periodLabel(G.PERIODS[r.p] || { label: r.p, weekly: false })) +
          "</td><td class=\"" + cls(r.r) + "\">" + fmtSigned(r.r * 100, 2, "%") + "</td>" +
          "<td class=\"" + cls(r.b) + "\">" + fmtSigned(r.b * 100, 2, "%") + "</td>" +
          "<td class=\"" + cls(r.r - r.b) + "\">" + fmtSigned((r.r - r.b) * 100, 2, "pp") + "</td>" +
          "<td>" + (r.k == null ? "—" : r.k) + "</td><td>" + result + "</td></tr>";
      }).join("");
  }
  function trackStatus(msg) { $("trackStatus").textContent = msg; }
  function exportTrack() {
    var rows = S.track();
    if (!rows.length) { trackStatus("還沒有紀錄可以匯出。"); return; }
    var url = URL.createObjectURL(new Blob([S.exportText()], { type: "application/json" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = "chartgame-record-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    trackStatus("已匯出 " + rows.length + " 筆紀錄。");
  }

  /* ---------- 複製挑戰連結 ---------- */
  var copyTimers = new WeakMap();
  async function copyText(button, target) {
    var text = target.value, tip = button.nextElementSibling, ok;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
    clearTimeout(copyTimers.get(button));
    button.removeAttribute("data-copied");
    button.removeAttribute("data-failed");
    $("copyIcon").setAttribute("href", ok ? "#i-check" : "#i-copy");
    tip.textContent = "";
    void button.offsetWidth;                         // 重新觸發樣式變化
    button.setAttribute(ok ? "data-copied" : "data-failed", "");
    requestAnimationFrame(function () { tip.textContent = ok ? "已複製" : "複製失敗,請手動選取"; });
    copyTimers.set(button, setTimeout(function () {
      button.removeAttribute("data-copied");
      button.removeAttribute("data-failed");
      $("copyIcon").setAttribute("href", "#i-copy");
      tip.textContent = "";
    }, 2000));
  }

  /* ---------- 圖表工具清單 ---------- */
  function buildIndList() {
    $("indList").innerHTML = CG.IND_ORDER.map(function (k) {
      var def = IND[k];
      return '<li><label><span class="dot" style="background:' + def.color + '" aria-hidden="true"></span>' +
        '<span class="span-label">' + esc(def.label) + '</span>' +
        '<input type="checkbox" switch data-k="' + k + '"' + (state.active.has(k) ? " checked" : "") + ' aria-label="' + esc(def.label) + '"></label></li>';
    }).join("");
    $("indList").addEventListener("change", function (e) {
      var k = e.target.getAttribute("data-k");
      if (!k || !IND[k]) return;
      if (e.target.checked) state.active.add(k); else state.active.delete(k);
      S.savePref(k, e.target.checked);
      if (state.game) {
        state.view.rebuild(state.active);
        state.view.refresh();
        renderLegend();
      }
    });
  }

  /* ---------- 事件 ---------- */
  function bind() {
    var startDialog = $("startDialog"), resultDialog = $("resultDialog"), trackDialog = $("trackDialog"), helpDialog = $("helpDialog");

    $("periodGrid").addEventListener("click", function (e) {
      var b = e.target.closest("[data-k]");
      if (b) setPeriod(b.getAttribute("data-k"));
    });
    $("btnStart").addEventListener("click", function () {
      var ch = state.challenge;
      if (ch) startGame({ period: ch.p, ticker: ch.t, date: ch.d });
      else startGame({ period: state.periodKey });
    });
    $("challengeBox").addEventListener("click", function (e) {
      if (!e.target.closest("[data-random]")) return;
      state.challenge = null;
      $("challengeBox").hidden = true;
      $("btnStart").textContent = "開始挑戰";
    });

    $("btnBuy").addEventListener("click", doBuy);
    $("btnSell").addEventListener("click", doSell);
    $("btnAuto").addEventListener("click", function () { if (state.auto) stopAuto(); else startAuto(); });
    $("speedChips").addEventListener("click", function (e) {
      var b = e.target.closest("[data-x]");
      if (b) setSpeed(Number(b.getAttribute("data-x")));
    });

    // 快轉:點一下 = speed 根;按住超過 0.4 秒 = 連續播放
    var stepBtn = $("btnStep"), holdTimer = null, repTimer = null, longPress = false;
    function stopRepeat() { clearTimeout(holdTimer); clearInterval(repTimer); holdTimer = repTimer = null; }
    stepBtn.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || stepBtn.disabled) return;
      longPress = false;
      stopRepeat();
      holdTimer = setTimeout(function () {
        longPress = true;
        repTimer = setInterval(function () { doStep(1); }, 70);
      }, 400);
    });
    stepBtn.addEventListener("pointerup", function () {
      stopRepeat();
      if (!longPress && !stepBtn.disabled) doStep(state.speed);
    });
    stepBtn.addEventListener("pointercancel", function () { stopRepeat(); longPress = true; });
    stepBtn.addEventListener("pointerleave", stopRepeat);
    stepBtn.addEventListener("click", function (e) {              // 鍵盤(空白鍵 / Enter)啟動時才沒有 pointer 事件
      if (e.detail === 0) doStep(state.speed);
    });

    $("btnNew").addEventListener("click", onNewClick);
    $("btnAgain").addEventListener("click", function () { startGame({ period: state.game.period.key }); });
    $("btnAgain2").addEventListener("click", function () { startGame({ period: state.game.period.key }); });
    $("btnReplay").addEventListener("click", replay);
    $("btnReplay2").addEventListener("click", replay);
    $("btnShowResult").addEventListener("click", showResult);
    $("btnHome").addEventListener("click", goHome);     // 底部操作列的「回首頁」
    $("btnHome2").addEventListener("click", goHome);    // 結算畫面的「回首頁」(兩顆是不同元素,id 不可重複)

    $("btnHelp").addEventListener("click", function () { openDialog(helpDialog); });
    $("btnHelpClose").addEventListener("click", function () { closeDialog(helpDialog); });
    $("btnViewChart").addEventListener("click", function () { closeDialog(resultDialog); });

    $("btnTrack").addEventListener("click", function () { renderTrack(); openDialog(trackDialog); });
    $("btnTrack2").addEventListener("click", function () { renderTrack(); openDialog(trackDialog); });
    $("btnTrackClose").addEventListener("click", function () { closeDialog(trackDialog); });
    $("trackFilters").addEventListener("click", function (e) {
      var b = e.target.closest("[data-f]");
      if (!b) return;
      state.trackFilter = b.getAttribute("data-f");
      renderTrack();
    });
    $("btnExport").addEventListener("click", exportTrack);
    $("btnImport").addEventListener("click", function () { $("importFile").click(); });
    $("importFile").addEventListener("change", function () {
      var file = this.files[0];
      if (!file) return;
      file.text().then(function (text) { return S.importTrack(text); }).then(function (added) {
        trackStatus("已匯入 " + added + " 筆紀錄" + (added ? "。" : "(其餘都已存在)。"));
        renderTrack();
      }, function () { trackStatus("匯入失敗:檔案不是有效的戰績紀錄。"); });
      this.value = "";
    });
    $("btnTrackClear").addEventListener("click", function () {
      if (!S.track().length) { trackStatus("目前沒有紀錄。"); return; }
      if (!state.clearArmed) {                                   // 兩段式確認,避免手滑
        $("btnClearLabel").textContent = "確定清除?";
        state.clearArmed = setTimeout(function () {
          state.clearArmed = 0;
          $("btnClearLabel").textContent = "清除紀錄";
        }, 3000);
        return;
      }
      clearTimeout(state.clearArmed);
      state.clearArmed = 0;
      $("btnClearLabel").textContent = "清除紀錄";
      S.clearTrack();
      trackStatus("已清除全部戰績。");
      renderTrack();
    });

    // 複製挑戰連結:有 CommandEvent 的瀏覽器走 command 事件,否則走 click 後援(兩條路只註冊一條)
    if ("CommandEvent" in window) {
      document.addEventListener("command", function (e) {
        if (e.command === "--copy" && e.source) copyText(e.source, $("shareLink"));
      }, true);
    } else {
      document.addEventListener("click", function (e) {
        var button = e.target instanceof Element && e.target.closest('button[command^="--copy"]');
        if (button && !e.defaultPrevented) copyText(button, $("shareLink"));
      });
    }

    $("btnSide").addEventListener("click", function () {
      var hidden = document.body.classList.toggle("side-hidden");
      this.setAttribute("aria-pressed", String(!hidden));
      this.setAttribute("aria-label", hidden ? "展開工具箱" : "收合工具箱");
      S.saveSetting("side", hidden ? "hidden" : "shown");
    });

    // 對話框:Esc / 點擊外部
    [resultDialog, trackDialog, helpDialog].forEach(function (d) {
      d.addEventListener("cancel", function (e) { e.preventDefault(); closeDialog(d); });   // 讓 Esc 也播放離場動畫
    });
    startDialog.addEventListener("cancel", function (e) { e.preventDefault(); });           // 開始畫面沒有東西可回去
    if (!("closedBy" in HTMLDialogElement.prototype)) {
      // 不支援 closedby 的瀏覽器:自己補上「點擊對話框外部即關閉」
      document.querySelectorAll('dialog[closedby="any"]').forEach(function (d) {
        var pressedOutside = false;
        var outside = function (e) {
          var r = d.getBoundingClientRect();
          return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        d.addEventListener("pointerdown", function (e) { pressedOutside = outside(e); });
        d.addEventListener("pointerup", function (e) { if (pressedOutside && outside(e)) closeDialog(d); });
      });
    }

    document.addEventListener("keydown", function (e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector("dialog[open]")) return;         // 有彈出畫面時,快速鍵一律停用
      var k = e.key, g = state.game;
      if (!g) return;
      var t = e.target;
      var onControl = t instanceof Element && t.closest("button, input, textarea, select, a, [contenteditable]");
      if ((k === " " || k === "Enter") && onControl) return;       // 讓按鈕自己處理,避免一次快轉兩根
      var low = k.toLowerCase();
      if (low === "b") { if (!e.repeat) doBuy(); }
      else if (low === "s") { if (!e.repeat) doSell(); }
      else if (low === "t" || k === " " || k === "ArrowRight") { e.preventDefault(); doStep(state.speed); }
      else if (low === "a") { if (!e.repeat) { if (state.auto) stopAuto(); else startAuto(); } }
      else if (k === "1" || k === "2" || k === "3") { setSpeed(SPEEDS[Number(k) - 1]); }
    });
  }

  function replay() {
    var g = state.game;
    if (!g) return;
    startGame({ ticker: state.meta.t, period: g.period.key, date: g.bars[g.firstFuture].t, practice: true });
  }

  /* ---------- 啟動 ---------- */
  function init() {
    var prefs = S.prefs(CG.IND_DEFAULTS), settings = S.settings();
    state.active = new Set(Object.keys(IND).filter(function (k) { return prefs[k]; }));
    state.view = new CG.ChartView($("chart"));
    state.view.onHover = function (idx) { state.hover = idx; renderLegend(); };

    buildIndList();
    buildPeriodGrid();
    renderUniverseMeta();
    bind();
    setSpeed(SPEEDS.indexOf(settings.speed) >= 0 ? settings.speed : 1);
    if (settings.side === "hidden" && innerWidth >= 960) $("btnSide").click();

    var ch = readChallenge();
    if (ch && ch.invalid) {
      $("challengeBox").hidden = false;
      $("challengeBox").innerHTML = "這個挑戰連結無效,已改為隨機開局。";
    } else if (ch) {
      state.challenge = ch;
      setPeriod(ch.p);
      $("challengeBox").hidden = false;
      $("challengeBox").innerHTML = "有人分享了一項挑戰給你,股票同樣保密,玩到最後才揭曉。" +
        '<strong>' + esc(periodLabel(G.PERIODS[ch.p])) + '</strong>' +
        '<button type="button" class="btn btn-ghost" data-random>改為隨機開局</button>';
      $("btnStart").textContent = "接受挑戰";
    }
    openDialog($("startDialog"));
  }

  window.__cg = state;            // 方便在主控台檢查狀態
  init();
})();
