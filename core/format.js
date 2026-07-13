/* ============================================================
   core/format.js — 共用數字格式化
   - zhMoney：把裸數字轉成口語化金額（NT$ 用「萬 / 億」，其他幣別用 k / M / B）
     用途：大金額輸入欄位下方的即時提示，避免多打或少打一個 0
   - moneyHintOf：直接產生提示字串（空值或 0 回空字串，不干擾）
   ============================================================ */

/* 口語化金額。cur 預設 NT$。回傳不含幣別符號的數量詞（如「1,000 萬」）。 */
export function zhMoney(v, cur = 'NT$') {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '';
  const neg = n < 0;
  const a = Math.abs(n);
  let s;
  if (cur === 'NT$') {
    if (a >= 1e8) {
      const y = a / 1e8;
      s = (y >= 100 ? Math.round(y).toLocaleString('en-US') : y.toFixed(y >= 10 ? 1 : 2).replace(/\.?0+$/, '')) + ' 億';
    } else if (a >= 1e4) {
      const w = a / 1e4;
      s = (Number.isInteger(w) ? w.toLocaleString('en-US') : w.toFixed(1).replace(/\.0$/, '')) + ' 萬';
    } else {
      s = Math.round(a).toLocaleString('en-US');
    }
  } else {
    if (a >= 1e9) s = (a / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    else if (a >= 1e6) s = (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    else if (a >= 1e3) s = (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    else s = Math.round(a).toLocaleString('en-US');
  }
  return (neg ? '−' : '') + s;
}

/* 金額欄位下方的提示文字。無值或 0 時回空字串。 */
export function moneyHintOf(v, cur = 'NT$') {
  const s = zhMoney(v, cur);
  return s ? `＝ ${s}` : '';
}

/* 把某個 input 綁定到一個提示節點，輸入時即時更新。回傳解綁函式。 */
export function bindMoneyHint(input, hintEl, curFn) {
  if (!input || !hintEl) return () => {};
  const upd = () => {
    const cur = typeof curFn === 'function' ? curFn() : (curFn || 'NT$');
    hintEl.textContent = moneyHintOf(input.value, cur);
  };
  input.addEventListener('input', upd);
  upd();
  return () => input.removeEventListener('input', upd);
}

/* 千分位整數（共用於各模組的表格輸出） */
export function fmtInt(n) {
  return (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US');
}
