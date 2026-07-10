/* ============================================================
   modules/deviation/deviation.js — 模組2：組合偏離視覺化
   - 可編輯表格逐欄輸入（代號/現值/目標%/分類），實際%自動換算、邊改邊算
   - 資料即時存入共享持股資料（holdings），與分批建倉共用
   - 現金以代號「現金 / CASH / $」當一列，納入組合總值
   - 輸出：分類層級 treemap（squarified，依設定分類法上色）、
           實際 vs 目標偏離橫條（>5 個百分點高亮）、觸發點燈號列
   - 純診斷，不產出任何買賣建議
   ============================================================ */
import { getHoldings, setHoldings } from '../../core/store.js';
import { getSettings, activeLayers, isExempt } from '../../core/settings.js';

export const id = 'deviation';
export const title = '組合偏離';

const LAYER_COLORS = ['#e0b25a', '#6e9bc0', '#7fbf9a', '#c98b6b', '#9a86c4', '#d4a13c', '#5f9ea0', '#bf7f8a'];
const CASH_COLOR = '#5a626c';

const DEMO_ROWS = [
  { ticker: 'NVDA', value: 1800000, target: 20, layer: '半導體 / 算力' },
  { ticker: 'AVGO', value: 900000, target: 10, layer: '半導體 / 算力' },
  { ticker: 'ASML', value: 800000, target: 8, layer: '設備 / 製造' },
  { ticker: 'TSM', value: 1200000, target: 12, layer: '設備 / 製造' },
  { ticker: 'MSFT', value: 1000000, target: 12, layer: '雲端 / 基礎建設' },
  { ticker: 'AMZN', value: 700000, target: 8, layer: '雲端 / 基礎建設' },
  { ticker: 'GOOGL', value: 900000, target: 10, layer: '模型 / 平台' },
  { ticker: 'PLTR', value: 600000, target: 6, layer: '應用 / 軟體' },
  { ticker: 'VRT', value: 500000, target: 6, layer: '終端 / 週邊' },
  { ticker: '現金', value: 1100000, target: 8, layer: '現金' },
];

let state = { rows: [] };

export function unmount() {}

/* ---------- 工具 ---------- */
function fmt(n) { return (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US'); }
function fmt1(n) { return (n == null || !isFinite(n)) ? '—' : n.toFixed(1); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function isCash(t) { return /^(現金|cash|\$|cash\$|現金\$)$/i.test(String(t).trim()); }
function n(v) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }

/* ---------- 計算 ---------- */
function analyze(rows) {
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  const items = rows.map(r => {
    const actual = total > 0 ? (r.value || 0) / total * 100 : 0;
    return {
      ticker: r.ticker, value: r.value || 0, layer: r.layer || '未分類',
      actual, target: r.target || 0, dev: actual - (r.target || 0),
      cash: isCash(r.ticker),
    };
  });
  const cash = items.filter(i => i.cash).reduce((s, i) => s + i.actual, 0);
  const byLayer = {};
  items.forEach(i => { byLayer[i.layer] = (byLayer[i.layer] || 0) + i.actual; });
  return { total, items, cashPct: cash, byLayer };
}

/* 取出可用的持股列（有代號者），供分析與儲存 */
function cleanRows() {
  return state.rows
    .filter(r => String(r.ticker || '').trim())
    .map(r => ({ ticker: String(r.ticker).trim(), value: n(r.value), target: n(r.target), layer: String(r.layer || '未分類').trim() || '未分類' }));
}

/* ---------- squarified treemap ---------- */
function worstRatio(row, side) {
  const sum = row.reduce((s, c) => s + c.area, 0);
  const mx = Math.max(...row.map(c => c.area)), mn = Math.min(...row.map(c => c.area));
  return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
}
function squarify(children, rect, out) {
  if (!children.length) return;
  if (children.length === 1) { out.push({ ...children[0], ...rect }); return; }
  const { x, y, w, h } = rect;
  const side = Math.min(w, h);
  let row = [children[0]]; let i = 1;
  while (i < children.length) {
    const next = row.concat(children[i]);
    if (worstRatio(row, side) >= worstRatio(next, side)) { row = next; i++; } else break;
  }
  const rowArea = row.reduce((s, c) => s + c.area, 0);
  if (w >= h) {
    const rw = rowArea / h; let cy = y;
    row.forEach(c => { const ch = c.area / rw; out.push({ ...c, x, y: cy, w: rw, h: ch }); cy += ch; });
    squarify(children.slice(row.length), { x: x + rw, y, w: w - rw, h }, out);
  } else {
    const rh = rowArea / w; let cx = x;
    row.forEach(c => { const cw = c.area / rh; out.push({ ...c, x: cx, y, w: cw, h: rh }); cx += cw; });
    squarify(children.slice(row.length), { x, y: y + rh, w, h: h - rh }, out);
  }
}
function buildTreemap(items, W, H) {
  const data = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const total = data.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return [];
  const scaled = data.map(i => ({ ...i, area: i.value / total * (W * H) }));
  const out = [];
  squarify(scaled, { x: 0, y: 0, w: W, h: H }, out);
  return out;
}

/* ---------- 色彩對應 ---------- */
function layerColorMap(items) {
  const layers = []; const seen = new Set();
  activeLayers().forEach(l => { if (!seen.has(l)) { seen.add(l); layers.push(l); } });
  items.forEach(i => { if (!i.cash && !seen.has(i.layer)) { seen.add(i.layer); layers.push(i.layer); } });
  const map = {};
  let ci = 0;
  layers.forEach(l => { map[l] = LAYER_COLORS[ci % LAYER_COLORS.length]; ci++; });
  return map;
}

/* ---------- 渲染診斷輸出 ---------- */
function renderOutput(view, rows) {
  const box = view.querySelector('#dv-out');
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="placeholder" style="margin:20px 0"><div class="tag">尚無資料</div><h2>在左側表格輸入持股</h2><p>每列填一檔：代號、現值、目標佔比、分類層級。實際佔比會自動算。也可按「載入示範資料」看效果。</p></div>`;
    return;
  }
  const a = analyze(rows);
  const s = getSettings();
  const colors = layerColorMap(a.items);

  const W = 1000, H = 520;
  const tiles = buildTreemap(a.items, W, H);
  const tileSVG = tiles.map(t => {
    const col = t.cash ? CASH_COLOR : (colors[t.layer] || '#888');
    const big = t.w > 70 && t.h > 34;
    const label = big ? `
      <text x="${t.x + 8}" y="${t.y + 20}" fill="#0f1115" font-family="IBM Plex Sans" font-size="15" font-weight="700">${esc(t.ticker)}</text>
      <text x="${t.x + 8}" y="${t.y + 38}" fill="rgba(15,17,21,0.72)" font-family="IBM Plex Mono" font-size="12">${fmt1(t.actual)}%</text>` : '';
    return `<g><rect x="${t.x + 1}" y="${t.y + 1}" width="${Math.max(0, t.w - 2)}" height="${Math.max(0, t.h - 2)}" rx="3" fill="${col}"><title>${esc(t.ticker)} · ${t.layer} · ${fmt(t.value)} · ${fmt1(t.actual)}%</title></rect>${label}</g>`;
  }).join('');
  const usedLayers = [...new Set(a.items.map(i => i.cash ? '現金' : i.layer))];
  const legend = usedLayers.map(l => {
    const col = l === '現金' ? CASH_COLOR : (colors[l] || '#888');
    return `<span class="leg-i"><i style="background:${col}"></i>${esc(l)}</span>`;
  }).join('');

  const maxDev = Math.max(5, ...a.items.map(i => Math.abs(i.dev)));
  const devRows = a.items.slice().sort((x, y) => y.actual - x.actual).map(i => {
    const hot = Math.abs(i.dev) > 5;
    const frac = Math.min(1, Math.abs(i.dev) / maxDev);
    const half = frac * 50;
    const bar = i.dev >= 0
      ? `<div class="dv-fill over${hot ? ' hot' : ''}" style="left:50%;width:${half}%"></div>`
      : `<div class="dv-fill under${hot ? ' hot' : ''}" style="left:${50 - half}%;width:${half}%"></div>`;
    return `<tr class="${hot ? 'dv-hotrow' : ''}">
      <td class="dv-tk">${esc(i.ticker)}${i.cash ? ' <span class="tr-muted">(現金)</span>' : ''}</td>
      <td class="num">${fmt1(i.actual)}%</td>
      <td class="num">${fmt1(i.target)}%</td>
      <td class="dv-track-cell"><div class="dv-track"><div class="dv-center"></div>${bar}</div></td>
      <td class="num dv-dev ${hot ? 'hot' : ''}">${i.dev >= 0 ? '+' : ''}${fmt1(i.dev)}</td>
    </tr>`;
  }).join('');

  const lamps = [];
  a.items.filter(i => !i.cash).forEach(i => {
    if (i.actual >= s.concentration.single) {
      if (isExempt(i.ticker)) {
        lamps.push(`<div class="lampcard exempt"><div class="lc-k">${esc(i.ticker)}</div><div class="lc-v">${fmt1(i.actual)}%</div><div class="lc-x"><span class="badge">豁免</span> 超過集中度觸發點但在豁免清單</div></div>`);
      } else {
        const strong = i.actual >= s.concentration.strong;
        lamps.push(`<div class="lampcard ${strong ? 'bad' : 'warn'}"><div class="lc-k">${esc(i.ticker)}</div><div class="lc-v">${fmt1(i.actual)}%</div><div class="lc-x">${strong ? `超過強檢視觸發點 ${s.concentration.strong}%` : `超過集中度觸發點 ${s.concentration.single}%`}，建議走三層判讀</div></div>`);
      }
    }
  });
  {
    const cp = a.cashPct;
    if (cp < s.cash.low) lamps.push(`<div class="lampcard warn"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">低於舒適區間下緣 ${s.cash.low}%</div></div>`);
    else if (cp > s.cash.high) lamps.push(`<div class="lampcard warn"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">高於舒適區間上緣 ${s.cash.high}%</div></div>`);
    else lamps.push(`<div class="lampcard ok"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">落在舒適區間 ${s.cash.low}–${s.cash.high}%</div></div>`);
  }
  Object.entries(a.byLayer).forEach(([layer, pct]) => {
    if (layer === '現金' || isCash(layer)) return;
    if (pct > s.categoryCap) lamps.push(`<div class="lampcard warn"><div class="lc-k">${esc(layer)}</div><div class="lc-v">${fmt1(pct)}%</div><div class="lc-x">分類合計超過上限 ${s.categoryCap}%</div></div>`);
  });

  box.innerHTML = `
    <div class="zone">
      <div class="q">觸發點燈號</div>
      <div class="lampgrid">${lamps.join('')}</div>
      <div class="chartnote">門檻來自設定頁：集中度 ${s.concentration.single}% / ${s.concentration.strong}%，現金舒適區間 ${s.cash.low}–${s.cash.high}%，分類上限 ${s.categoryCap}%。此處僅做診斷呈現，不含任何買賣建議。</div>
    </div>

    <div class="zone">
      <div class="q">分類層級 treemap</div>
      <div class="panel">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">${tileSVG}</svg>
        <div class="tr-legend">${legend}</div>
      </div>
    </div>

    <div class="zone">
      <div class="q">實際 vs 目標偏離（偏離 &gt; 5 個百分點高亮）</div>
      <div class="tr-tablewrap">
        <table class="tr-table dv-table">
          <thead><tr><th>標的</th><th>實際</th><th>目標</th><th style="text-align:center">偏離（← 不足　超出 →）</th><th>偏離值</th></tr></thead>
          <tbody>${devRows}</tbody>
        </table>
      </div>
      <div class="chartnote">組合總值 ${fmt(a.total)}（含現金）。偏離值＝實際佔比 − 目標佔比（百分點）。</div>
    </div>`;
}

/* ---------- 渲染可編輯表格（結構變動時重建） ---------- */
function renderTable(view) {
  const tbody = view.querySelector('#dv-tbody');
  if (!tbody) return;
  tbody.innerHTML = state.rows.map((r, i) => `
    <tr data-i="${i}">
      <td><input type="text" data-f="ticker" value="${esc(r.ticker || '')}" placeholder="代號" style="text-transform:uppercase"></td>
      <td><input type="number" data-f="value" value="${r.value === '' || r.value == null ? '' : r.value}" min="0" step="1000" placeholder="現值"></td>
      <td><input type="number" data-f="target" value="${r.target === '' || r.target == null ? '' : r.target}" min="0" max="100" step="0.5" placeholder="%"></td>
      <td><input type="text" data-f="layer" value="${esc(r.layer || '')}" list="dv-layers" placeholder="分類層級"></td>
      <td class="num"><span data-actual="${i}">—</span></td>
      <td><button class="dv-del" data-del="${i}" title="刪除此列">×</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('input[data-f]').forEach(inp => inp.addEventListener('input', () => {
    const tr = inp.closest('tr'); const i = +tr.dataset.i; const f = inp.dataset.f;
    state.rows[i][f] = inp.type === 'number' ? (inp.value === '' ? '' : n(inp.value)) : inp.value;
    syncDerived(view);
  }));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    state.rows.splice(+b.dataset.del, 1);
    if (!state.rows.length) state.rows.push(blankRow());
    renderTable(view); syncDerived(view);
  }));
  syncDerived(view);
}

/* ---------- 即時更新（不重建輸入框，保留游標） ---------- */
function syncDerived(view) {
  const total = state.rows.reduce((s, r) => s + n(r.value), 0);
  state.rows.forEach((r, i) => {
    const cell = view.querySelector(`[data-actual="${i}"]`);
    if (cell) cell.textContent = total > 0 ? (n(r.value) / total * 100).toFixed(1) + '%' : '—';
  });
  const targetSum = state.rows.reduce((s, r) => s + n(r.target), 0);
  const tEl = view.querySelector('#dv-total'); if (tEl) tEl.textContent = fmt(total);
  const sEl = view.querySelector('#dv-tsum');
  if (sEl) {
    sEl.textContent = fmt1(targetSum) + '%';
    sEl.className = 'dv-sum' + (Math.abs(targetSum - 100) > 0.5 ? ' off' : '');
  }
  const hold = cleanRows();
  setHoldings(hold);
  renderOutput(view, hold);
}

function blankRow() { return { ticker: '', value: '', target: '', layer: '' }; }

/* ---------- 整批貼上解析（Excel / Sheets / CSV，Tab 或逗號分隔） ---------- */
function parsePaste(text) {
  const lines = String(text || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  lines.forEach(l => {
    const c = l.split(/\t|,/).map(x => x.trim());
    if (c.length < 2) return;
    const ticker = c[0];
    const value = parseFloat(String(c[1]).replace(/[,\s]/g, ''));
    if (!ticker || isNaN(value)) return; // 表頭列（現值非數字）自動跳過
    const target = c[2] !== undefined && c[2] !== '' ? (parseFloat(String(c[2]).replace(/[%\s]/g, '')) || 0) : '';
    out.push({ ticker, value, target, layer: c[3] || '' });
  });
  return out;
}

function applyPaste(view, mode) {
  const ta = view.querySelector('#dv-paste');
  const incoming = parsePaste(ta.value);
  if (!incoming.length) { flash(view, '沒有可解析的持股列（欄位順序：代號、現值、目標%、分類）'); return; }
  if (mode === 'replace') {
    state.rows = incoming;
  } else {
    // 合併：同代號覆蓋（大小寫不敏感），新代號附加
    incoming.forEach(inc => {
      const idx = state.rows.findIndex(r => String(r.ticker).trim().toUpperCase() === inc.ticker.toUpperCase() && String(r.ticker).trim() !== '');
      if (idx >= 0) {
        state.rows[idx].value = inc.value;
        if (inc.target !== '') state.rows[idx].target = inc.target;
        if (inc.layer) state.rows[idx].layer = inc.layer;
      } else {
        state.rows.push({ ...inc });
      }
    });
    // 清掉純空白列
    state.rows = state.rows.filter(r => String(r.ticker || '').trim() || r.value || r.target || r.layer);
    if (!state.rows.length) state.rows.push(blankRow());
  }
  ta.value = '';
  renderTable(view);
  flash(view, `已${mode === 'replace' ? '取代為' : '併入'} ${incoming.length} 檔 ✓`);
}

export function mount(view) {
  const existing = getHoldings();
  state = { rows: existing.length ? existing.map(r => ({ ticker: r.ticker, value: r.value, target: r.target, layer: r.layer })) : [blankRow(), blankRow(), blankRow()] };

  const layerOpts = activeLayers().concat(['現金']).map(l => `<option value="${esc(l)}">`).join('');

  view.innerHTML = `
    <header><div class="brand">
      <h1>組合偏離視覺化</h1>
      <p>在表格裡逐欄填入持股，工具即時把組合的實際長相攤開：分類層級 treemap、每檔實際 vs 目標的偏離、以及對照你設定門檻的觸發點燈號。邊改邊算，只做診斷呈現、不告訴你該買該賣。資料只存在你的瀏覽器，並與分批建倉計算器共用。</p>
    </div></header>

    <datalist id="dv-layers">${layerOpts}</datalist>

    <div class="grid">
      <div class="controls">
        <div class="panel">
          <div class="seclabel">持股輸入</div>
          <div class="sub" style="margin-bottom:12px">每列一檔：代號、現值、目標佔比 %、分類層級（可從建議清單選或自行輸入）。實際佔比自動算。現金請用代號「現金」或 CASH 當一列。</div>
          <div class="tr-tablewrap">
            <table class="dv-edit">
              <thead><tr><th>代號</th><th>現值</th><th>目標%</th><th>分類層級</th><th>實際%</th><th></th></tr></thead>
              <tbody id="dv-tbody"></tbody>
              <tfoot><tr>
                <td class="dv-foot">合計</td>
                <td class="num dv-foot"><span id="dv-total">—</span></td>
                <td class="num dv-foot"><span id="dv-tsum" class="dv-sum">—</span></td>
                <td colspan="3" class="dv-foot" style="color:var(--txt3);font-weight:400">目標佔比合計（含現金）建議接近 100%</td>
              </tr></tfoot>
            </table>
          </div>
          <div class="savebar" style="margin-top:14px">
            <button class="btn-ghost" id="dv-add" type="button">＋ 新增持股</button>
            <button class="btn-ghost" id="dv-addcash" type="button">＋ 新增現金列</button>
            <button class="btn-ghost" id="dv-demo" type="button">載入示範資料</button>
            <button class="btn-ghost" id="dv-clear" type="button">清空</button>
            <span class="savemsg" id="dv-msg"></span>
          </div>
        </div>

        <details class="adv" style="margin-top:18px">
          <summary>整批貼上（Excel / Sheets / CSV）</summary>
          <div class="advbody">
            <div class="sub" style="margin:14px 0 10px">從試算表直接複製整個範圍貼進來即可。欄位順序：代號、現值、目標%（選填）、分類層級（選填）。Tab 或逗號分隔，表頭列會自動跳過。現金請用代號「現金」或 CASH。</div>
            <textarea id="dv-paste" rows="6" placeholder="NVDA&#9;1800000&#9;20&#9;半導體 / 算力&#10;TSM&#9;1200000&#9;12&#9;設備 / 製造&#10;現金&#9;1100000&#9;8&#9;現金"></textarea>
            <div class="savebar" style="margin-top:12px">
              <button class="btn-primary" id="dv-paste-merge" type="button">併入現有（同代號覆蓋）</button>
              <button class="btn-ghost" id="dv-paste-replace" type="button">取代全部</button>
            </div>
          </div>
        </details>
      </div>

      <div class="results" id="dv-out"></div>
    </div>`;

  const q = id => view.querySelector('#' + id);
  q('dv-add').addEventListener('click', () => { state.rows.push(blankRow()); renderTable(view); flash(view, '已新增一列'); });
  q('dv-addcash').addEventListener('click', () => {
    if (!state.rows.some(r => isCash(r.ticker))) state.rows.push({ ticker: '現金', value: '', target: '', layer: '現金' });
    else flash(view, '已有現金列');
    renderTable(view);
  });
  q('dv-demo').addEventListener('click', () => { state.rows = DEMO_ROWS.map(r => ({ ...r })); renderTable(view); flash(view, '已載入示範資料'); });
  q('dv-paste-merge').addEventListener('click', () => applyPaste(view, 'merge'));
  q('dv-paste-replace').addEventListener('click', () => applyPaste(view, 'replace'));
  q('dv-clear').addEventListener('click', () => {
    if (confirm('清空所有持股輸入並從共享資料移除？')) { state.rows = [blankRow(), blankRow(), blankRow()]; renderTable(view); flash(view, '已清空'); }
  });

  renderTable(view);
}

function flash(view, msg) {
  const m = view.querySelector('#dv-msg');
  if (m) { m.textContent = msg; setTimeout(() => { if (m) m.textContent = ''; }, 2500); }
}
