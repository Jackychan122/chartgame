/* ===== 儲存層:瀏覽器 localStorage(指標偏好、戰績) =====
 * 戰績沿用第一版的鍵 cg_track_v1,舊紀錄缺少的欄位一律視為「沒有資料」。
 */
(function () {
  "use strict";
  var CG = (window.CG = window.CG || {});
  var KEY_PREFS = "cg_prefs_v1", KEY_TRACK = "cg_track_v1", KEY_SETTINGS = "cg_settings_v1";

  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  /* ---------- 指標開關偏好 ---------- */
  function prefs(defaults) {
    var saved = readJSON(KEY_PREFS, {}), out = {};
    Object.keys(defaults).forEach(function (k) { out[k] = (k in saved) ? !!saved[k] : defaults[k]; });
    return out;
  }
  function savePref(key, on) {
    var saved = readJSON(KEY_PREFS, {});
    saved[key] = on;
    writeJSON(KEY_PREFS, saved);
  }

  /* ---------- 其他設定 ---------- */
  function settings() { return readJSON(KEY_SETTINGS, {}); }
  function saveSetting(key, value) {
    var s = settings();
    s[key] = value;
    writeJSON(KEY_SETTINGS, s);
  }

  /* ---------- 戰績 ---------- */
  function track() {
    var v = readJSON(KEY_TRACK, []);
    return Array.isArray(v) ? v.filter(function (r) { return r && typeof r.r === "number" && typeof r.b === "number"; }) : [];
  }
  function addRecord(rec) {
    var arr = track();
    arr.push(rec);
    writeJSON(KEY_TRACK, arr);
  }
  function clearTrack() {
    try { localStorage.removeItem(KEY_TRACK); } catch (e) { }
  }
  /** 匯入:只接受看起來像戰績的紀錄,並以時間+股票+期間去重。回傳新增筆數。 */
  function importTrack(jsonText) {
    var incoming = JSON.parse(jsonText);
    var list = Array.isArray(incoming) ? incoming : incoming && incoming.records;
    if (!Array.isArray(list)) throw new Error("檔案內容不是戰績紀錄");
    var have = {}, arr = track(), added = 0;
    function keyOf(r) { return [r.ts, r.t, r.p, r.k].join("|"); }
    arr.forEach(function (r) { have[keyOf(r)] = true; });
    list.forEach(function (r) {
      if (!r || typeof r.r !== "number" || typeof r.b !== "number" || typeof r.t !== "string" || !r.p) return;
      var k = keyOf(r);
      if (have[k]) return;
      have[k] = true;
      arr.push(r);
      added++;
    });
    arr.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    writeJSON(KEY_TRACK, arr);
    return added;
  }
  function exportText() {
    return JSON.stringify({ app: "chartgame", exported: new Date().toISOString(), records: track() }, null, 1);
  }

  CG.Store = {
    prefs: prefs,
    savePref: savePref,
    settings: settings,
    saveSetting: saveSetting,
    track: track,
    addRecord: addRecord,
    clearTrack: clearTrack,
    importTrack: importTrack,
    exportText: exportText,
  };
})();
