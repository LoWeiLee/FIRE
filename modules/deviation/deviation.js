/* ============================================================
   modules/deviation/deviation.js — 模組2：組合偏離視覺化
   - 可編輯表格逐欄輸入（代號/現值/目標%/分類），實際%自動換算、邊改邊算
   - 資料即時存入共享持股資料（holdings），與分批建倉共用
   - 現金以代號「現金 / CASH / $」當一列，納入組合總值
   - 輸出：分類層級 treemap（squarified，依設定分類法上色）、
           實際 vs 目標偏離橫條（>5 個百分點高亮）、觸發點燈號列
   - 純診斷，不產出任何買賣建議

   P0-1：「載入示範資料」改為非持久化預覽模式。原本一點就直接把示範資料寫進
        共享 holdings，無確認、無備份、無復原，一鍵毀掉手動輸入的整組持股。
        現在示範模式完全不呼叫 setHoldings，離開後還原原本的資料。
   P1-2：現值欄下方即時顯示口語化金額（＝ 180 萬），避免多打少打一個 0。
   P1-3：整批貼上改用共用的引號感知 splitLine，支援 "1,800,000" 這種欄位。
   P1-6：名詞提示改為觸控可用的 popover。
   P2-2：清空持股可在 30 秒內復原。
   P2-4：持股快照過期時，在診斷結論區直接亮警示燈卡。
   ============================================================ */
import { getHoldings, setHoldings, set, holdingsUpdatedAt, holdingsAgeDays, downloadBackup, snapshot, restoreLast, UNDO_TTL_MS } from '../../core/store.js';
import { getSettings, activeLayers, isExempt } from '../../core/settings.js';
import { showModal, flowCrumb, tipHTML, previewBanner, toast, alertModal, markLiveRegions } from '../../core/ui.js';
import { splitLine, parseNum } from '../../core/parse.js';
import { moneyHintOf } from '../../core/format.js';

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

/* demo：示範預覽模式；savedRows：進入示範前的真實輸入（離開時還原） */
let state = { rows: [], demo: false, savedRows: null };

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
    box.innerHTML = `<div class="placeholder" style="margin:20px 0"><div class="tag">尚無資料</div><h2>在左側表格輸入持股</h2><p>每列填一檔：代號、現值、目標佔比、分類層級。實際佔比會自動算。也可按「載入示範資料」看效果（示範資料只用於預覽，不會覆蓋你的持股）。</p></div>`;
    return;
  }
  const a = analyze(rows);
  const s = getSettings();
  const colors = layerColorMap(a.items);

  const W = 1000, H = 520;
  const tiles = buildTreemap(a.items, W, H);
  const tileSVG = tiles.map((t, ti) => {
    const col = t.cash ? CASH_COLOR : (colors[t.layer] || '#888');
    const big = t.w > 70 && t.h > 34;
    const info = `${t.ticker} · ${t.layer} · ${fmt(t.value)} · ${fmt1(t.actual)}%`;
    const label = big ? `
      <text x="${t.x + 8}" y="${t.y + 20}" fill="#0f1115" font-family="IBM Plex Sans" font-size="15" font-weight="700" pointer-events="none">${esc(t.ticker)}</text>
      <text x="${t.x + 8}" y="${t.y + 38}" fill="rgba(15,17,21,0.72)" font-family="IBM Plex Mono" font-size="12" pointer-events="none">${fmt1(t.actual)}%</text>` : '';
    // P1-6：觸控裝置看不到 <title>，改為可點擊 tile（點了把明細寫到下方註腳）
    return `<g><rect x="${t.x + 1}" y="${t.y + 1}" width="${Math.max(0, t.w - 2)}" height="${Math.max(0, t.h - 2)}" rx="3" fill="${col}" style="cursor:pointer" tabindex="0" role="button" aria-label="${esc(info)}" data-tile="${ti}" data-info="${esc(info)}"><title>${esc(info)}</title></rect>${label}</g>`;
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
    // 回到目標所需金額（純算術換算：目標% × 總值 − 現值），非買賣建議
    const gap = i.target / 100 * a.total - i.value;
    let gapCell = '<span class="tr-muted">—</span>';
    if (Math.abs(gap) >= 1 && i.target > 0) {
      gapCell = `<span class="${gap >= 0 ? 'dv-gap-add' : 'dv-gap-cut'}">${gap >= 0 ? '＋' : '−'}${fmt(Math.abs(gap))}</span>`;
      // 示範模式不提供「帶入建倉」：那會把示範數字寫進交接資料，污染真實工作流
      if (gap > 0 && !i.cash && !state.demo) gapCell += ` <button class="jr-mini" data-goto="${esc(i.ticker)}" data-gap="${Math.round(gap)}" type="button" title="把這個金額帶入分批建倉計算器">帶入建倉</button>`;
    }
    return `<tr class="${hot ? 'dv-hotrow' : ''}">
      <td class="dv-tk">${esc(i.ticker)}${i.cash ? ' <span class="tr-muted">(現金)</span>' : ''}</td>
      <td class="num">${fmt1(i.actual)}%</td>
      <td class="num">${fmt1(i.target)}%</td>
      <td class="dv-track-cell"><div class="dv-track"><div class="dv-center"></div>${bar}</div></td>
      <td class="num dv-dev ${hot ? 'hot' : ''}">${i.dev >= 0 ? '+' : ''}${fmt1(i.dev)}</td>
      <td class="num dv-gap">${gapCell}</td>
    </tr>`;
  }).join('');

  const lamps = [];
  const issues = []; // 供頂部診斷結論摘要

  // P2-4：持股快照過期 → 診斷結論區直接亮燈，不再只是圖表註腳
  const ageDays = state.demo ? null : holdingsAgeDays();
  const stale = (ageDays != null && s.staleDays > 0 && ageDays >= s.staleDays) ? { days: ageDays, th: s.staleDays } : null;
  if (stale) {
    lamps.push(`<div class="lampcard bad"><div class="lc-k">現值快照</div><div class="lc-v">${stale.days} 天前</div><div class="lc-x">已超過 ${stale.th} 天未更新，下方所有偏離與燈號可能失真。請重新輸入或整批貼上最新現值。</div></div>`);
    issues.push(`現值快照已 ${stale.days} 天未更新`);
  }

  a.items.filter(i => !i.cash).forEach(i => {
    if (i.actual >= s.concentration.single) {
      if (isExempt(i.ticker)) {
        lamps.push(`<div class="lampcard exempt"><div class="lc-k">${esc(i.ticker)}</div><div class="lc-v">${fmt1(i.actual)}%</div><div class="lc-x"><span class="badge">豁免</span> 超過集中度觸發點但在豁免清單</div></div>`);
      } else {
        const strong = i.actual >= s.concentration.strong;
        lamps.push(`<div class="lampcard ${strong ? 'bad' : 'warn'}"><div class="lc-k">${esc(i.ticker)}</div><div class="lc-v">${fmt1(i.actual)}%</div><div class="lc-x">${strong ? `超過強檢視觸發點 ${s.concentration.strong}%` : `超過集中度觸發點 ${s.concentration.single}%`}，建議走${tipHTML('三層判讀', '體感／故事／時機三層檢核，任一層紅燈都可暫不動。這是提示重新檢視，不是執行授權。')}</div></div>`);
        issues.push(`${esc(i.ticker)} 超過${strong ? '強檢視' : '集中度'}觸發點（${fmt1(i.actual)}%）`);
      }
    }
  });
  {
    const cp = a.cashPct;
    if (cp < s.cash.low) { lamps.push(`<div class="lampcard warn"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">低於舒適區間下緣 ${s.cash.low}%</div></div>`); issues.push(`現金低於舒適下緣（${fmt1(cp)}%）`); }
    else if (cp > s.cash.high) { lamps.push(`<div class="lampcard warn"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">高於舒適區間上緣 ${s.cash.high}%</div></div>`); issues.push(`現金高於舒適上緣（${fmt1(cp)}%）`); }
    else lamps.push(`<div class="lampcard ok"><div class="lc-k">現金</div><div class="lc-v">${fmt1(cp)}%</div><div class="lc-x">落在舒適區間 ${s.cash.low}–${s.cash.high}%</div></div>`);
  }
  Object.entries(a.byLayer).forEach(([layer, pct]) => {
    if (layer === '現金' || isCash(layer)) return;
    if (pct > s.categoryCap) { lamps.push(`<div class="lampcard warn"><div class="lc-k">${esc(layer)}</div><div class="lc-v">${fmt1(pct)}%</div><div class="lc-x">分類合計超過上限 ${s.categoryCap}%</div></div>`); issues.push(`「${esc(layer)}」分類超過上限（${fmt1(pct)}%）`); }
  });

  // 一句話診斷結論
  const worst = a.items.slice().sort((x, y) => Math.abs(y.dev) - Math.abs(x.dev))[0];
  const worstTxt = worst ? `最大偏離：${esc(worst.ticker)} ${worst.dev >= 0 ? '+' : ''}${fmt1(worst.dev)}pp` : '';
  const verdict = issues.length
    ? `<div class="dv-verdict warn"><b>${issues.length} 個觸發點</b>：${issues.join('、')}。${worstTxt}。</div>`
    : `<div class="dv-verdict ok">無觸發點，組合落在你設定的門檻內。${worstTxt}。</div>`;

  // 持股資料最後更新時間（顯示為本地時間）
  const upd = state.demo ? null : holdingsUpdatedAt();
  const updTxt = upd ? `持股資料最後更新：${new Date(upd).toLocaleString('zh-TW', { hour12: false })}。現值是手動輸入的快照，久未更新請重新貼上。` : '';

  const treeOpen = !!box.querySelector('details.adv[open]'); // 重繪前記住折疊狀態

  box.innerHTML = `
    <div class="zone">
      <div class="q">診斷結論</div>
      ${verdict}
    </div>

    <div class="zone">
      <div class="q">觸發點燈號</div>
      <div class="lampgrid">${lamps.join('')}</div>
      <div class="chartnote">門檻來自設定頁：${tipHTML('集中度', '單一標的佔組合比重的警戒線，超過建議重新檢視。')} ${s.concentration.single}% / ${s.concentration.strong}%，現金舒適區間 ${s.cash.low}–${s.cash.high}%，分類上限 ${s.categoryCap}%，快照過期門檻 ${s.staleDays} 天。此處僅做診斷呈現，不含任何買賣建議。</div>
    </div>

    <div class="zone">
      <div class="q">實際 vs 目標偏離（偏離 &gt; 5 個百分點高亮）</div>
      <div class="tr-tablewrap">
        <table class="tr-table dv-table">
          <thead><tr><th>標的</th><th>實際</th><th>目標</th><th style="text-align:center">偏離（← 不足　超出 →）</th><th>偏離值</th><th>回到目標</th></tr></thead>
          <tbody>${devRows}</tbody>
        </table>
      </div>
      <div class="chartnote">組合總值 ${fmt(a.total)}（含現金）。偏離值＝實際佔比 − 目標佔比（百分點）。「回到目標」＝目標% × 總值 − 現值的算術換算（＋需加碼、−為超出），只是換算、不是建議${state.demo ? '。示範模式不提供「帶入建倉」' : '；「帶入建倉」會把金額與代號送進分批建倉計算器'}。${updTxt ? '<br>' + updTxt : ''}</div>
    </div>

    <details class="adv">
      <summary>分類層級 treemap（組合視覺化）</summary>
      <div class="advbody">
        <div style="margin-top:14px">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block" role="img" aria-label="分類層級 treemap：各標的佔組合比重的面積圖，共 ${tiles.length} 檔，總值 ${fmt(a.total)}">${tileSVG}</svg>
          <div class="tr-legend">${legend}</div>
          <div class="tilehint" id="dv-tilehint">點一下方塊看該檔明細。</div>
        </div>
      </div>
    </details>`;

  if (treeOpen) { const d = box.querySelector('details.adv'); if (d) d.open = true; }

  // 帶入建倉（寫入交接資料後切頁）— 示範模式不會產生這些按鈕
  box.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => {
    set('trancheHandoff', { ticker: b.dataset.goto, amount: +b.dataset.gap || 0, portfolioTotal: a.total });
    location.hash = '#/tranche';
  }));

  // P1-6：treemap tile 點擊 / 鍵盤 Enter 顯示明細（觸控裝置看不到 SVG <title>）
  const hint = box.querySelector('#dv-tilehint');
  box.querySelectorAll('[data-tile]').forEach(rect => {
    const show = () => { if (hint) hint.innerHTML = `<b>${esc(rect.dataset.info)}</b>`; };
    rect.addEventListener('click', show);
    rect.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } });
  });
}

/* ---------- 渲染可編輯表格（結構變動時重建） ---------- */
function renderTable(view) {
  const tbody = view.querySelector('#dv-tbody');
  if (!tbody) return;
  const ro = state.demo ? ' disabled' : '';
  tbody.innerHTML = state.rows.map((r, i) => `
    <tr data-i="${i}">
      <td><input type="text" data-f="ticker" value="${esc(r.ticker || '')}" placeholder="代號" style="text-transform:uppercase" aria-label="第 ${i + 1} 列 代號"${ro}></td>
      <td>
        <input type="number" data-f="value" value="${r.value === '' || r.value == null ? '' : r.value}" min="0" step="1000" placeholder="現值" aria-label="第 ${i + 1} 列 現值"${ro}>
        <span class="dv-mini" data-hint="${i}">${moneyHintOf(r.value)}</span>
      </td>
      <td><input type="number" data-f="target" value="${r.target === '' || r.target == null ? '' : r.target}" min="0" max="100" step="0.5" placeholder="%" aria-label="第 ${i + 1} 列 目標佔比"${ro}></td>
      <td><input type="text" data-f="layer" value="${esc(r.layer || '')}" list="dv-layers" placeholder="分類層級" aria-label="第 ${i + 1} 列 分類層級"${ro}></td>
      <td class="num"><span data-actual="${i}">—</span></td>
      <td><button class="dv-del" data-del="${i}" type="button" title="刪除此列" aria-label="刪除第 ${i + 1} 列"${ro}>×</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('input[data-f]').forEach(inp => inp.addEventListener('input', () => {
    const tr = inp.closest('tr'); const i = +tr.dataset.i; const f = inp.dataset.f;
    state.rows[i][f] = inp.type === 'number' ? (inp.value === '' ? '' : n(inp.value)) : inp.value;
    // P1-2：現值欄下方即時顯示口語化金額
    if (f === 'value') {
      const h = tr.querySelector(`[data-hint="${i}"]`);
      if (h) h.textContent = moneyHintOf(inp.value);
    }
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
  const tHint = view.querySelector('#dv-total-hint'); if (tHint) tHint.textContent = moneyHintOf(total);
  const sEl = view.querySelector('#dv-tsum');
  if (sEl) {
    sEl.textContent = fmt1(targetSum) + '%';
    sEl.className = 'dv-sum' + (Math.abs(targetSum - 100) > 0.5 ? ' off' : '');
  }
  const hold = cleanRows();
  // P0-1 核心：示範模式一律不寫入共享持股，只做畫面預覽
  if (!state.demo) setHoldings(hold);
  renderOutput(view, hold);
}

function blankRow() { return { ticker: '', value: '', target: '', layer: '' }; }

/* ---------- 整批貼上解析（Excel / Sheets / CSV） ----------
   P1-3：改用共用的引號感知 splitLine。原本 l.split(/\t|,/) 會把
   NVDA,"1,800,000",20 的千分位逗號當成欄位分隔，整列靜默丟棄。 */
function parsePaste(text) {
  const lines = String(text || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  lines.forEach(l => {
    const c = splitLine(l);
    if (c.length < 2) return;
    const ticker = c[0];
    const value = parseNum(c[1]);
    if (!ticker || value == null) return; // 表頭列（現值非數字）自動跳過
    const t = parseNum(c[2]);
    const target = (c[2] !== undefined && c[2] !== '' && t != null) ? t : '';
    out.push({ ticker, value, target, layer: c[3] || '' });
  });
  return out;
}

function applyPaste(view, mode) {
  if (state.demo) { flash(view, '示範模式無法貼上，請先離開示範'); return; }
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

/* ---------- P0-1：示範資料預覽模式 ---------- */
function enterDemo(view) {
  if (state.demo) return;
  state.savedRows = state.rows.map(r => ({ ...r }));  // 記住真實輸入
  state.rows = DEMO_ROWS.map(r => ({ ...r }));
  state.demo = true;
  refreshDemoUI(view);
  flash(view, '示範資料檢視中（未寫入你的持股）');
}

function exitDemo(view) {
  if (!state.demo) return;
  state.rows = (state.savedRows && state.savedRows.length) ? state.savedRows : [blankRow(), blankRow(), blankRow()];
  state.savedRows = null;
  state.demo = false;
  refreshDemoUI(view);
  flash(view, '已離開示範，你的持股原封未動 ✓');
}

/* 依 demo 狀態切換橫幅、按鈕標籤、輸入禁用狀態，並重繪表格與結果 */
function refreshDemoUI(view) {
  const slot = view.querySelector('#dv-banner');
  if (slot) {
    slot.innerHTML = '';
    if (state.demo) {
      slot.appendChild(previewBanner(
        '示範資料檢視中。這些數字只用於預覽，不會寫入你的持股，也不會被分批建倉或 FIRE 讀到。離開示範即還原你原本的輸入。',
        () => exitDemo(view)
      ));
    }
  }
  const demoBtn = view.querySelector('#dv-demo');
  if (demoBtn) demoBtn.textContent = state.demo ? '離開示範' : '載入示範資料';
  ['dv-add', 'dv-addcash', 'dv-clear', 'dv-paste-merge', 'dv-paste-replace', 'dv-paste'].forEach(id => {
    const el = view.querySelector('#' + id);
    if (el) el.disabled = state.demo;
  });
  renderTable(view);
}

export function mount(view) {
  const existing = getHoldings();
  state = {
    rows: existing.length ? existing.map(r => ({ ticker: r.ticker, value: r.value, target: r.target, layer: r.layer })) : [blankRow(), blankRow(), blankRow()],
    demo: false,
    savedRows: null,
  };

  const layerOpts = activeLayers().concat(['現金']).map(l => `<option value="${esc(l)}">`).join('');

  view.innerHTML = `
    <header><div class="brand">
      <h1>組合偏離視覺化</h1>
      <p>在表格裡逐欄填入持股，工具即時把組合的實際長相攤開：分類層級 treemap、每檔實際 vs 目標的偏離、以及對照你設定門檻的觸發點燈號。邊改邊算，只做診斷呈現、不告訴你該買該賣。資料只存在你的瀏覽器，並與分批建倉計算器共用。</p>
    </div></header>
    ${flowCrumb('deviation')}

    <div id="dv-banner"></div>

    <datalist id="dv-layers">${layerOpts}</datalist>

    <div class="grid">
      <div class="controls">
        <div class="panel">
          <div class="seclabel">持股輸入</div>
          <div class="sub" style="margin-bottom:12px">每列一檔：代號、現值、目標佔比 %、分類層級（可從建議清單選或自行輸入）。實際佔比自動算。現金請用代號「現金」或 CASH 當一列。</div>
          <div class="tr-tablewrap">
            <table class="dv-edit">
              <thead><tr><th>代號</th><th>現值</th><th>目標%</th><th>分類層級</th><th>實際%</th><th><span class="tr-muted">刪除</span></th></tr></thead>
              <tbody id="dv-tbody"></tbody>
              <tfoot><tr>
                <td class="dv-foot">合計</td>
                <td class="num dv-foot"><span id="dv-total">—</span><span class="dv-mini" id="dv-total-hint"></span></td>
                <td class="num dv-foot"><span id="dv-tsum" class="dv-sum">—</span></td>
                <td colspan="3" class="dv-foot" style="color:var(--txt2);font-weight:400">目標佔比合計（含現金）建議接近 100%</td>
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
            <div class="sub" style="margin:14px 0 10px">從試算表直接複製整個範圍貼進來即可。欄位順序：代號、現值、目標%（選填）、分類層級（選填）。Tab 或逗號分隔，表頭列會自動跳過。含千分位的引號欄位（如 <span class="tr-muted">"1,800,000"</span>）可正確解析。現金請用代號「現金」或 CASH。</div>
            <textarea id="dv-paste" rows="6" aria-label="整批貼上持股資料" placeholder="NVDA&#9;1800000&#9;20&#9;半導體 / 算力&#10;TSM&#9;1200000&#9;12&#9;設備 / 製造&#10;現金&#9;1100000&#9;8&#9;現金"></textarea>
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
  // P0-1：示範資料 = 預覽模式切換，不再直接覆蓋 state.rows 並寫入 holdings
  q('dv-demo').addEventListener('click', () => { state.demo ? exitDemo(view) : enterDemo(view); });
  q('dv-paste-merge').addEventListener('click', () => applyPaste(view, 'merge'));
  q('dv-paste-replace').addEventListener('click', () => applyPaste(view, 'replace'));
  q('dv-clear').addEventListener('click', async () => {
    const choice = await showModal({
      title: '清空持股輸入',
      body: '這會同時清掉「分批建倉」共用的共享持股資料。清空後 30 秒內可以按「復原」救回來。',
      buttons: [
        { label: '先匯出備份再清空', kind: 'primary', value: 'backup' },
        { label: '直接清空', kind: 'danger', value: 'clear' },
        { label: '取消', kind: 'ghost', value: null },
      ],
    });
    if (!choice) return;
    if (choice === 'backup') downloadBackup();
    snapshot(['holdings', 'holdingsMeta'], '清空持股'); // P2-2：先拍快照
    state.rows = [blankRow(), blankRow(), blankRow()];
    renderTable(view);
    flash(view, '已清空');
    toast('已清空持股輸入。', {
      actionLabel: '復原',
      ms: UNDO_TTL_MS,
      onAction: () => {
        if (restoreLast()) {
          const back = getHoldings();
          state.rows = back.length ? back.map(r => ({ ...r })) : [blankRow(), blankRow(), blankRow()];
          renderTable(view);
          toast('已復原持股 ✓', { ms: 3500 });
        } else alertModal('復原時效已過（30 秒），資料無法還原。');
      },
    });
  });

  refreshDemoUI(view);
  markLiveRegions(view);
}

function flash(view, msg) {
  const m = view.querySelector('#dv-msg');
  if (!m) return;
  m.textContent = msg;
  clearTimeout(m._t);
  m._t = setTimeout(() => { m.textContent = ''; }, 3000);
}
