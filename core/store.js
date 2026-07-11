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
export function exportAll() {
  const out = {};
  keys().forEach(k => { out[k] = get(k); });
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
export function portfolioTotal() {
  return getHoldings().reduce((s, h) => s + (Number(h.value) || 0), 0);
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
