/* ===== 遊戲規則(純邏輯,不碰 DOM) =====
 *
 * 一局 = 一段連續的K棒:前面 ctx 根只供指標暖機、接著 hist 根是給玩家看的歷史、
 * 最後 play 根是挑戰區間。買進 / 賣出都在「下一根K棒的開盤價」成交且全額進出;
 * 對手「買進持有」在挑戰區間第一根的開盤價買進、抱到最後一根收盤。
 */
(function () {
  "use strict";
  var CG = (window.CG = window.CG || {});

  var INITIAL = 10000;
  var PERIODS = {
    "3m": { key: "3m", label: "3個月", weekly: false, hist: 60,  play: 63,  ctx: 260 },
    "6m": { key: "6m", label: "6個月", weekly: false, hist: 120, play: 126, ctx: 260 },
    "1y": { key: "1y", label: "1年",   weekly: false, hist: 120, play: 250, ctx: 260 },
    "2y": { key: "2y", label: "2年",   weekly: true,  hist: 100, play: 104, ctx: 215 },
    "5y": { key: "5y", label: "5年",   weekly: true,  hist: 156, play: 260, ctx: 215 },
  };
  var ORDER = ["3m", "6m", "1y", "2y", "5y"];

  function total(period) { return period.ctx + period.hist + period.play; }

  /** bars[start .. start+total-1] must lie inside one uninterrupted segment. */
  function create(bars, period, start) {
    var slice = bars.slice(start, start + total(period));
    var first = period.ctx + period.hist;
    return {
      period: period,
      bars: slice,
      ctx: period.ctx,
      hist: period.hist,
      play: period.play,
      firstFuture: first,                  // 第一根挑戰K棒
      lastIdx: slice.length - 1,
      cursor: first - 1,                   // 畫面上最後一根
      cash: INITIAL, shares: 0, cost: 0,   // cost = 買進價
      trades: [],                          // {i, side, price, shares, forced}
      eq: [INITIAL],                       // 每根收盤時的總資產,index 0 = 出發點
      bh: [INITIAL],                       // 買進持有同期的總資產
      heldTicks: 0,                        // 挑戰區間內「收盤時仍持股」的K棒數
      pending: null,                       // 'buy' | 'sell' | null:等待下一根開盤成交的委託
      ended: false,
    };
  }

  function canBuy(g) { return !g.ended && g.shares === 0 && g.cursor < g.lastIdx; }
  function canSell(g) { return !g.ended && g.shares > 0 && g.cursor < g.lastIdx; }

  /** 總資產(以 cursor 那根的收盤價計) */
  function equity(g) { return g.cash + g.shares * g.bars[g.cursor].c; }
  /** 買進持有截至 cursor 的報酬率 */
  function bhRet(g) {
    if (g.cursor < g.firstFuture) return 0;
    return g.bars[g.cursor].c / g.bars[g.firstFuture].o - 1;
  }
  /** 已經揭開的挑戰K棒數 */
  function revealed(g) { return Math.max(0, g.cursor - g.firstFuture + 1); }

  /** 前進一根;有待成交的委託就在這根的開盤價成交。回傳本根是否成交了買/賣。 */
  function advance(g) {
    if (g.ended) return null;
    var b = g.bars[++g.cursor], filled = null;
    if (g.pending === "buy" && g.shares === 0 && g.cash > 0) {
      g.shares = g.cash / b.o;
      g.cost = b.o;
      g.cash = 0;
      g.trades.push({ i: g.cursor, side: "buy", price: b.o, shares: g.shares });
      filled = "buy";
    } else if (g.pending === "sell" && g.shares > 0) {
      g.cash = g.shares * b.o;
      g.trades.push({ i: g.cursor, side: "sell", price: b.o, shares: g.shares });
      g.shares = 0;
      g.cost = 0;
      filled = "sell";
    }
    g.pending = null;
    g.eq.push(g.cash + g.shares * b.c);
    g.bh.push(INITIAL * b.c / g.bars[g.firstFuture].o);
    if (g.shares > 0) g.heldTicks++;
    if (g.cursor >= g.lastIdx) finish(g);
    return filled;
  }

  function order(g, side) {
    if (side === "buy" ? !canBuy(g) : !canSell(g)) return false;
    g.pending = side;
    advance(g);
    return true;
  }

  /** 快轉 n 根(不出手) */
  function step(g, n) {
    for (var k = 0; k < n && !g.ended; k++) advance(g);
  }

  function finish(g) {
    if (g.ended) return;
    g.ended = true;
    g.pending = null;
    var last = g.bars[g.lastIdx];
    if (g.shares > 0) {                   // 最後一根以收盤價強制清倉
      g.cash = g.shares * last.c;
      g.trades.push({ i: g.lastIdx, side: "sell", price: last.c, shares: g.shares, forced: true });
      g.shares = 0;
      g.cost = 0;
    }
    g.finalEquity = g.cash;
    g.ret = g.finalEquity / INITIAL - 1;
    g.bhFinal = last.c / g.bars[g.firstFuture].o - 1;
    // 差距四捨五入到 0.00 個百分點後相同 → 平手;嚴格領先才算打敗買進持有
    g.tie = Math.abs(g.ret - g.bhFinal) < 5e-5;
    g.win = !g.tie && g.ret > g.bhFinal;
  }

  /** 一買一賣為一個回合;未賣出的部位回傳 open: true(以目前收盤價計未實現損益) */
  function trips(g) {
    var out = [], open = null;
    for (var k = 0; k < g.trades.length; k++) {
      var t = g.trades[k];
      if (t.side === "buy") {
        open = t;
      } else if (open) {
        out.push({ buy: open, sell: t, ret: t.price / open.price - 1, pnl: open.shares * (t.price - open.price), open: false });
        open = null;
      }
    }
    if (open) {
      var c = g.bars[g.cursor].c;
      out.push({ buy: open, sell: null, ret: c / open.price - 1, pnl: open.shares * (c - open.price), open: true });
    }
    return out;
  }

  function maxDrawdown(values) {
    var peak = -Infinity, worst = 0;
    for (var k = 0; k < values.length; k++) {
      if (values[k] > peak) peak = values[k];
      var dd = values[k] / peak - 1;
      if (dd < worst) worst = dd;
    }
    return worst;
  }

  /** 結算統計(局結束後呼叫) */
  function stats(g) {
    var done = trips(g).filter(function (t) { return !t.open; });
    var best = null, worst = null, realized = 0;
    done.forEach(function (t) {
      realized += t.pnl;
      if (best === null || t.ret > best) best = t.ret;
      if (worst === null || t.ret < worst) worst = t.ret;
    });
    return {
      ret: g.ret, bhRet: g.bhFinal, excess: g.ret - g.bhFinal, tie: g.tie, win: g.win,
      maxDrawdown: maxDrawdown(g.eq), bhMaxDrawdown: maxDrawdown(g.bh),
      timeInMarket: g.heldTicks / g.play,
      roundTrips: done.length, trades: g.trades.length, realized: realized,
      best: best, worst: worst,
      finalEquity: g.finalEquity,
      from: g.bars[g.firstFuture].t, to: g.bars[g.lastIdx].t,
    };
  }

  CG.Game = {
    INITIAL: INITIAL,
    PERIODS: PERIODS,
    ORDER: ORDER,
    total: total,
    create: create,
    canBuy: canBuy,
    canSell: canSell,
    equity: equity,
    bhRet: bhRet,
    revealed: revealed,
    advance: advance,
    order: order,
    step: step,
    finish: finish,
    trips: trips,
    maxDrawdown: maxDrawdown,
    stats: stats,
  };
})();
