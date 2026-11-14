/* 技術指標計算 — 全部為因果(causal)指標,只使用當根之前的資料 */
(function () {
  "use strict";

  function sma(src, n) {
    var out = new Array(src.length).fill(null);
    var sum = 0;
    for (var i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= n) sum -= src[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(src, n) {
    var out = new Array(src.length).fill(null);
    if (src.length < n) return out;
    var k = 2 / (n + 1), prev = 0;
    for (var j = 0; j < n; j++) prev += src[j];
    prev /= n;
    out[n - 1] = prev;
    for (var i = n; i < src.length; i++) {
      prev = src[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /* 在「前段為 null」的陣列上做 EMA(例如 MACD 的 DIF) */
  function emaPadded(src, n) {
    var start = -1;
    for (var i = 0; i < src.length; i++) {
      if (src[i] != null) { start = i; break; }
    }
    if (start < 0) return new Array(src.length).fill(null);
    var tail = src.slice(start);
    var e = ema(tail, n);
    var out = new Array(src.length).fill(null);
    for (var j = 0; j < e.length; j++) out[start + j] = e[j];
    return out;
  }

  function bollinger(src, n, mult) {
    var mid = sma(src, n);
    var upper = new Array(src.length).fill(null);
    var lower = new Array(src.length).fill(null);
    for (var i = n - 1; i < src.length; i++) {
      var m = mid[i], sq = 0;
      for (var j = i - n + 1; j <= i; j++) {
        var d = src[j] - m;
        sq += d * d;
      }
      var sd = Math.sqrt(sq / n);
      upper[i] = m + mult * sd;
      lower[i] = m - mult * sd;
    }
    return { mid: mid, upper: upper, lower: lower };
  }

  function macd(src, fast, slow, signalN) {
    var ef = ema(src, fast), es = ema(src, slow);
    var dif = new Array(src.length).fill(null);
    for (var i = 0; i < src.length; i++) {
      if (ef[i] != null && es[i] != null) dif[i] = ef[i] - es[i];
    }
    var dea = emaPadded(dif, signalN);
    var hist = new Array(src.length).fill(null);
    for (var k = 0; k < src.length; k++) {
      if (dif[k] != null && dea[k] != null) hist[k] = dif[k] - dea[k];
    }
    return { dif: dif, dea: dea, hist: hist };
  }

  function rsi(src, n) {
    var out = new Array(src.length).fill(null);
    if (src.length <= n) return out;
    var gain = 0, loss = 0;
    for (var i = 1; i <= n; i++) {
      var d = src[i] - src[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (var j = n + 1; j < src.length; j++) {
      var d2 = src[j] - src[j - 1];
      var g = d2 > 0 ? d2 : 0, l = d2 < 0 ? -d2 : 0;
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[j] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  window.Ind = {
    sma: sma,
    ema: ema,
    bollinger: bollinger,
    macd: macd,
    rsi: rsi,
  };
})();
