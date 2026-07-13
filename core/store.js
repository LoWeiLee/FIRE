/* ============================================================
   core/store.js — localStorage 封裝
   - 所有資料只進瀏覽器 localStorage，零落地
   - 統一前綴命名空間，避免與其他站台衝突
   - 提供全站 JSON 匯出 / 匯入 / 一鍵清除
   - 「持股資料」為跨模組共享狀態（建倉計算器與偏離視覺化共用）
   ============================================================ */

const PREFIX = 'itb:'; // investment-toolbox

export function get(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('localStorage 寫入失敗', e);
    return false;
  }
}

export function remove(key) {
  localStorage.removeItem(PREFIX + key);
}

export function keys() {
  return Object.keys(localStorage)
    .filter(k => k.startsWith(PREFIX))
    .map(k => k.slice(PREFIX.length));
}

/* ---------- 全站匯出 / 匯入 / 清除 ---------- */
/* 不進備份檔的內部暫存 key（復原快照只在本次工作階段有意義） */
const TRANSIENT_KEYS = ['lastDeleted'];

export function exportAll() {
  const out = {};
  keys().filter(k => !TRANSIENT_KEYS.includes(k)).forEach(k => { out[k] = get(k); });
  return {
    _meta: { app: 'investment-toolbox', version: 1, exportedAt: new Date().toISOString() },
    data: out,
  };
}

export function downloadBackup() {
  const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `投資工具箱備份_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  set('lastBackupAt', new Date().toISOString()); // 供備份提醒判斷
}

export function importAll(payload, { merge = false } = {}) {
  // 接受 exportAll() 的格式，或直接的 {key:value} 物件
  const data = (payload && payload.data && typeof payload.data === 'object') ? payload.data : payload;
  if (!data || typeof data !== 'object') throw new Error('檔案格式不正確');
  if (!merge) clearAll();
  Object.entries(data).forEach(([k, v]) => set(k, v));
}

export function importFromFile(file, opts) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { importAll(JSON.parse(reader.result), opts); resolve(); }
      catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function clearAll() {
  keys().forEach(remove);
}

/* ---------- 跨模組共享：持股資料 ---------- */
/* 一份持股資料，建倉計算器讀其組合總值、偏離視覺化讀其各檔配置。
   結構（陣列）：[{ ticker, value, target, layer }, ...]
   value=現值、target=目標佔比(%)、layer=分類層級    */
export const HOLDINGS_KEY = 'holdings';
export function getHoldings() { return get(HOLDINGS_KEY, []); }
export function setHoldings(list) {
  set(HOLDINGS_KEY, Array.isArray(list) ? list : []);
  set('holdingsMeta', { updatedAt: new Date().toISOString() });
}
/* 持股資料最後更新時間（ISO 字串，無資料回 null） */
export function holdingsUpdatedAt() {
  const m = get('holdingsMeta', null);
  return m && m.updatedAt ? m.updatedAt : null;
}
/* 持股快照距今幾天（無持股或無時間戳回 null） */
export function holdingsAgeDays() {
  const at = holdingsUpdatedAt();
  if (!at || !getHoldings().length) return null;
  const ms = Date.now() - new Date(at).getTime();
  if (!isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 86400000);
}
/* 持股快照是否已過期（門檻由設定頁 staleDays 決定，呼叫端傳入） */
export function holdingsStale(staleDays) {
  const d = holdingsAgeDays();
  if (d == null) return null;
  const th = Number(staleDays);
  if (!Number.isFinite(th) || th <= 0) return null;
  return d >= th ? { days: d, threshold: th } : null;
}
export function portfolioTotal() {
  return getHoldings().reduce((s, h) => s + (Number(h.value) || 0), 0);
}

/* ---------- 破壞性操作的安全網：單槽快照 + 復原 ---------- */
/* 覆蓋式單槽。執行清除前呼叫 snapshot(['holdings','journal'])，
   之後 restoreLast() 即可把當時的值原封寫回。預設 30 秒後視為過期。 */
const UNDO_KEY = 'lastDeleted';
export const UNDO_TTL_MS = 30000;

export function snapshot(keyList, label = '') {
  const data = {};
  (keyList || []).forEach(k => { data[k] = get(k, null); });
  set(UNDO_KEY, { at: Date.now(), label, data });
}

/* 目前是否有可復原的快照（過期回 null） */
export function pendingUndo() {
  const u = get(UNDO_KEY, null);
  if (!u || !u.data || typeof u.at !== 'number') return null;
  if (Date.now() - u.at > UNDO_TTL_MS) return null;
  return u;
}

/* 復原最近一次快照。成功回 true。 */
export function restoreLast() {
  const u = pendingUndo();
  if (!u) return false;
  Object.entries(u.data).forEach(([k, v]) => {
    if (v == null) remove(k); else set(k, v);
  });
  remove(UNDO_KEY);
  return true;
}

export function clearUndo() { remove(UNDO_KEY); }

/* 全站清除 + 保留復原快照（clearAll 會連 UNDO_KEY 一起掃掉，故先取後放） */
export function clearAllWithUndo(label = '全站清除') {
  const data = {};
  keys().filter(k => !TRANSIENT_KEYS.includes(k)).forEach(k => { data[k] = get(k, null); });
  clearAll();
  set(UNDO_KEY, { at: Date.now(), label, data });
}

/* ---------- 備份提醒 ---------- */
/* 是否有「值得備份」的實質資料（排除自動存的 FIRE 輸入預設值與純 meta） */
export function hasUserData() {
  const arr = k => { const v = get(k, []); return Array.isArray(v) && v.length > 0; };
  const settings = get('settings', null);
  return arr('holdings') || arr('tranchePlans') || arr('journal') || arr('fireScenarios')
    || (settings && typeof settings === 'object' && Object.keys(settings).length > 0);
}
export function lastBackupAt() { return get('lastBackupAt', null); }
/* 回傳提醒狀態：null=不需提醒；否則 {never, days} */
export function backupReminder() {
  if (!hasUserData()) return null;
  const snooze = get('backupSnoozeUntil', null);
  if (snooze && Date.now() < new Date(snooze).getTime()) return null;
  const last = lastBackupAt();
  if (!last) return { never: true, days: null };
  const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
  return days >= 30 ? { never: false, days } : null;
}
export function snoozeBackup(daysAhead = 7) {
  set('backupSnoozeUntil', new Date(Date.now() + daysAhead * 86400000).toISOString());
}
