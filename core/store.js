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
export function setHoldings(list) { set(HOLDINGS_KEY, Array.isArray(list) ? list : []); }
export function portfolioTotal() {
  return getHoldings().reduce((s, h) => s + (Number(h.value) || 0), 0);
}
