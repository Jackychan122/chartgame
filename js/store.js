/* ===== 儲存層:瀏覽器 localStorage(指標偏好、戰績) =====
 * 戰績沿用第一版的鍵 cg_track_v1,舊紀錄缺少的欄位一律視為「沒有資料」。
 *
 * 實際存放處可以抽換(use()):遊戲用瀏覽器的 localStorage,測試則換成記憶體,
 * 絕對不能讓測試碰到使用者真正的戰績和偏好。
 */
(function () {
  "use strict";
  var CG = (window.CG = window.CG || {});
  var KEY_PREFS = "cg_prefs_v1", KEY_TRACK = "cg_track_v1", KEY_SETTINGS = "cg_settings_v1";

  /* 隱私模式或被瀏覽器封鎖時,連讀取 localStorage 都會拋出例外 → 退成「不保存」,遊戲照樣能玩 */
  var storage = null;
  try {
    window.localStorage.getItem(KEY_PREFS);
    storage = window.localStorage;
  } catch (e) {
    storage = null;
  }

  /** 換掉存放處(測試用)。傳入只要有 getItem / setItem / removeItem 就可以。 */
  function use(next) { storage = next || null; }

  function readJSON(key, fallback) {
    try {
      var v = storage ? JSON.parse(storage.getItem(key)) : null;
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    if (!storage) return false;
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  /* ---------- 指標開關偏好 ---------- */
  function prefs(defaults) {
    var saved = readJSON(KEY_PREFS, {}), out = {};
    Object.keys(defaults).forEach(function (k) { out[k] = (k in saved) ? !!saved[k] : defaults[k]; });
    return out;
  }
  /* 以下寫入函式都回傳是否真的寫成功(存放處不可用時回傳 false) */
  function savePref(key, on) {
    var saved = readJSON(KEY_PREFS, {});
    saved[key] = on;
    return writeJSON(KEY_PREFS, saved);
  }

  /* ---------- 其他設定 ---------- */
  function settings() { return readJSON(KEY_SETTINGS, {}); }
  function saveSetting(key, value) {
    var s = settings();
    s[key] = value;
    return writeJSON(KEY_SETTINGS, s);
  }

  /* ---------- 戰績 ---------- */
  function track() {
    var v = readJSON(KEY_TRACK, []);
    return Array.isArray(v) ? v.filter(function (r) { return r && typeof r.r === "number" && typeof r.b === "number"; }) : [];
  }
  function addRecord(rec) {
    var arr = track();
    arr.push(rec);
    return writeJSON(KEY_TRACK, arr);
  }
  function clearTrack() {
    try { if (storage) storage.removeItem(KEY_TRACK); } catch (e) { }
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
    use: use,
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
