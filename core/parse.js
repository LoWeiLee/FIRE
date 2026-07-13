/* ============================================================
   core/parse.js — 共用的表格文字解析
   原本 journal.js 有一份引號感知的 splitLine，deviation.js 卻用
   l.split(/\t|,/)，導致從 Excel 貼上 NVDA,"1,800,000",20 這種含千分位
   引號欄位的資料會被逗號切爛。這裡抽成共用，兩處行為一致。
   ============================================================ */

/* 引號感知的欄位切分：欄位可含逗號（以 "..." 包住），"" 為跳脫的引號。
   分隔符：逗號或 Tab。 */
export function splitLine(l) {
  const out = [];
  let cur = '';
  let q = false;
  const s = String(l == null ? '' : l);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

/* 把一段多行文字切成欄位陣列（空白列自動略過）。 */
export function splitTable(text) {
  return String(text || '').trim().split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(splitLine);
}

/* 數值解析：去掉千分位逗號、空白、百分比與貨幣符號。無法解析回 null。 */
export function parseNum(v) {
  if (v == null || v === '') return null;
  const x = parseFloat(String(v).replace(/[,\s%$＄]/g, '').replace(/NT/i, ''));
  return Number.isFinite(x) ? x : null;
}

/* CSV 輸出用的欄位跳脫 */
export function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
