/* ============================================================
   modules/journal/journal.js — 模組3：交易日誌統計
   - 單筆表單快速記錄（日期預設今天、買賣切換、評分/完整度按鈕選取）
   - 批次匯入 CSV（進階折疊）→ 解析 → 累加去重存 localStorage
   - 交易明細表：單筆行內編輯、單筆刪除
   - 季/年切換的統計面板：筆數金額、買賣分布、賣出類型分布、決策評分分布
   - 三層判讀完整度（0–3）趨勢、單一標的 30 天內重複交易標記
   - 可匯出 journal 專屬 CSV、可清空
   ============================================================ */
import { get, set } from '../../core/store.js';
import { confirmModal, showModal, flowCrumb } from '../../core/ui.js';

export const id = 'journal';
export const title = '交易日誌';

const JOURNAL_KEY = 'journal';
const DAY = 86400000;

const DEMO = `日期,代號,買/賣,股數,價格,賣出類型,決策評分,三層判讀完整度,決策備註
2025-08-15,NVDA,買,100,110,,✅,3,故事完整、技術面右側訊號
2025-09-10,AVGO,買,50,160,,⚠️,2,
2025-11-20,NVDA,賣,40,140,停利,✅,3,達強檢視觸發點後減碼
2026-01-12,TSM,買,80,190,,✅,2,
2026-02-03,NVDA,買,30,130,,❌,1,追high 沒走完判讀
2026-02-20,NVDA,賣,30,125,停損,⚠️,1,
2026-03-05,MSFT,買,60,420,,✅,3,
2026-05-10,PLTR,買,100,30,,⚠️,0,`;

let uiMode = 'quarter'; // 'quarter' | 'year'
let uiPeriod = '__latest__';
let editIdx = null;        // 明細表行內編輯中的列（存檔陣列索引）
let form = { side: 'buy', score: '', depth: null }; // 快速表單的按鈕型欄位

const SELL_TYPES = ['停利', '停損', '再平衡', '換股', '調整部位'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function unmount() {}

/* ---------- 工具 ---------- */
function fmt(n) { return (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US'); }
function fmt1(n) { return (n == null || !isFinite(n)) ? '—' : n.toFixed(1); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(s) { const v = parseFloat(String(s == null ? '' : s).replace(/[%,\s]/g, '')); return isNaN(v) ? null : v; }

function normSide(s) { s = String(s || '').trim(); if (/買|^b/i.test(s)) return 'buy'; if (/賣|^s/i.test(s)) return 'sell'; return ''; }
function normScore(s) {
  s = String(s || '').trim();
  if (s.includes('✅') || s === '好') return '✅';
  if (s.includes('⚠') || s === '普' || s === '普通') return '⚠️';
  if (s.includes('❌') || s === '差') return '❌';
  return '';
}
function normDate(s) {
  s = String(s || '').trim().replace(/\//g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, y, mo, ms: new Date(y, mo - 1, d).getTime() };
}

/* ---------- 解析 ---------- */
/* 引號感知的欄位切分：備註可含逗號（以 "..." 包住），"" 為跳脫的引號 */
function splitLine(l) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) {
      if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}
function csvField(v) {
  v = String(v == null ? '' : v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let rows = lines.map(splitLine);
  // 偵測表頭：第一列無法解析為日期 → 表頭
  if (rows.length && !normDate(rows[0][0])) rows = rows.slice(1);
  const out = [];
  rows.forEach(c => {
    const dt = normDate(c[0]);
    const side = normSide(c[2]);
    const shares = num(c[3]) || 0;
    const price = num(c[4]) || 0;
    if (!dt || !c[1] || !side) return;
    let depth = num(c[7]);
    if (depth != null) depth = Math.max(0, Math.min(3, Math.round(depth)));
    out.push({
      date: dt.date, ticker: c[1].trim().toUpperCase(), side, shares, price,
      sellType: (c[5] || '').trim(), score: normScore(c[6]), depth,
      note: (c[8] || '').trim(),
    });
  });
  return out;
}

function rowKey(t) { return [t.date, t.ticker, t.side, t.shares, t.price].join('|'); }

function mergeDedup(existing, incoming) {
  const seen = new Set(existing.map(rowKey));
  const merged = existing.slice();
  let added = 0;
  incoming.forEach(t => { const k = rowKey(t); if (!seen.has(k)) { seen.add(k); merged.push(t); added++; } });
  merged.sort((a, b) => a.date.localeCompare(b.date));
  return { merged, added };
}

/* ---------- 期間 ---------- */
function periodOf(t, mode) {
  const m = normDate(t.date);
  if (!m) return { key: '?', label: '?', sort: 0 };
  if (mode === 'year') return { key: `${m.y}`, label: `${m.y} 年`, sort: m.y * 10 };
  const q = Math.floor((m.mo - 1) / 3) + 1;
  return { key: `${m.y}-Q${q}`, label: `${m.y} Q${q}`, sort: m.y * 10 + q };
}
function allPeriods(trades, mode) {
  const map = new Map();
  trades.forEach(t => { const p = periodOf(t, mode); if (!map.has(p.key)) map.set(p.key, p); });
  return [...map.values()].sort((a, b) => a.sort - b.sort);
}

/* ---------- 30 天重複交易 ---------- */
function repeats(trades) {
  const byT = {};
  trades.forEach(t => { (byT[t.ticker] = byT[t.ticker] || []).push(t); });
  const out = [];
  Object.entries(byT).forEach(([tk, arr]) => {
    arr = arr.slice().sort((a, b) => normDate(a.date).ms - normDate(b.date).ms);
    let maxc = 1, win = null;
    for (let i = 0; i < arr.length; i++) {
      let c = 1;
      for (let j = i + 1; j < arr.length; j++) {
        if (normDate(arr[j].date).ms - normDate(arr[i].date).ms <= 30 * DAY) c++; else break;
      }
      if (c > maxc) { maxc = c; win = [arr[i].date, arr[Math.min(i + c - 1, arr.length - 1)].date]; }
    }
    if (maxc >= 2) out.push({ ticker: tk, count: maxc, span: win });
  });
  return out.sort((a, b) => b.count - a.count);
}

/* ---------- 分布橫條 ---------- */
function distBars(entries) {
  // entries: [{label, count, sub?}]
  const max = Math.max(1, ...entries.map(e => e.count));
  return `<div class="jr-dist">` + entries.map(e =>
    `<div class="jr-row">
      <div class="jr-label">${esc(e.label)}</div>
      <div class="jr-track"><div class="jr-fill" style="width:${e.count / max * 100}%"></div></div>
      <div class="jr-val">${e.count}${e.sub ? ` <span class="tr-muted">${esc(e.sub)}</span>` : ''}</div>
    </div>`).join('') + `</div>`;
}

/* ---------- 趨勢圖（跨各期平均完整度 0–3） ---------- */
function trendSVG(trades, mode) {
  const periods = allPeriods(trades, mode);
  const data = periods.map(p => {
    const ts = trades.filter(t => periodOf(t, mode).key === p.key && t.depth != null);
    const avg = ts.length ? ts.reduce((s, t) => s + t.depth, 0) / ts.length : null;
    return { label: p.label, avg, n: ts.length };
  });
  if (!data.some(d => d.avg != null)) return `<div class="chartnote">尚無「三層判讀完整度」資料可繪製趨勢。</div>`;
  const W = 1000, H = 240, padL = 40, padB = 40, padT = 16, padR = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = data.length;
  const bw = plotW / n;
  const Y = v => padT + plotH - (v / 3) * plotH;
  let grid = '';
  for (let g = 0; g <= 3; g++) { const y = Y(g); grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.07)"/><text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#9aa1ab" font-family="IBM Plex Mono" font-size="12">${g}</text>`; }
  const bars = data.map((d, i) => {
    const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
    if (d.avg == null) return `<text x="${x + w / 2}" y="${H - padB + 18}" text-anchor="middle" fill="#9aa1ab" font-family="IBM Plex Sans" font-size="12">${esc(d.label)}</text>`;
    const y = Y(d.avg), h = padT + plotH - y;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#e0b25a"><title>${esc(d.label)}：平均 ${fmt1(d.avg)}（${d.n} 筆）</title></rect>
      <text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" fill="#f2cc7b" font-family="IBM Plex Mono" font-size="12">${fmt1(d.avg)}</text>
      <text x="${x + w / 2}" y="${H - padB + 18}" text-anchor="middle" fill="#9aa1ab" font-family="IBM Plex Sans" font-size="12">${esc(d.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block">${grid}${bars}</svg>
    <div class="chartnote">各期「三層判讀完整度」平均（0–3）。只計入有填完整度的交易。</div>`;
}

/* ---------- 渲染面板 ---------- */
function renderPanel(view) {
  const all = get(JOURNAL_KEY, []);
  const box = view.querySelector('#jr-out');
  if (!all.length) {
    box.innerHTML = `<div class="placeholder" style="margin:20px 0"><div class="tag">尚無交易</div><h2>用左側表單記下第一筆交易</h2><p>填日期、代號、買賣、股數、價格，按「新增這筆」即可。也可以展開「批次匯入」貼 CSV，或載入示範資料看效果。</p></div>`;
    return;
  }
  const periods = allPeriods(all, uiMode);
  // 決定目前期間
  let periodKey = uiPeriod;
  if (periodKey === '__latest__') periodKey = periods.length ? periods[periods.length - 1].key : '__all__';
  const scope = periodKey === '__all__' ? all : all.filter(t => periodOf(t, uiMode).key === periodKey);

  // 期間選擇器
  const opts = [`<option value="__all__"${periodKey === '__all__' ? ' selected' : ''}>全部</option>`]
    .concat(periods.map(p => `<option value="${p.key}"${p.key === periodKey ? ' selected' : ''}>${esc(p.label)}</option>`)).join('');

  // 統計
  const buys = scope.filter(t => t.side === 'buy'), sells = scope.filter(t => t.side === 'sell');
  const amt = ts => ts.reduce((s, t) => s + t.shares * t.price, 0);
  const totalAmt = amt(scope);

  // 賣出類型分布
  const sellTypeMap = {};
  sells.forEach(t => { const k = t.sellType || '未標記'; sellTypeMap[k] = (sellTypeMap[k] || 0) + 1; });
  const sellTypeEntries = Object.entries(sellTypeMap).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);

  // 決策評分分布
  const scoreOrder = ['✅', '⚠️', '❌', '未評'];
  const scoreMap = { '✅': 0, '⚠️': 0, '❌': 0, '未評': 0 };
  scope.forEach(t => { scoreMap[t.score || '未評']++; });
  const scoreEntries = scoreOrder.map(k => ({ label: k, count: scoreMap[k] }));

  // 重複交易（依目前 scope）
  const reps = repeats(scope);

  // 交易明細（帶存檔陣列索引，供單筆編輯/刪除）
  const indexed = all.map((t, i) => ({ t, i }));
  const scopeIdx = periodKey === '__all__' ? indexed : indexed.filter(x => periodOf(x.t, uiMode).key === periodKey);
  const desc = scopeIdx.slice().sort((a, b) => b.t.date.localeCompare(a.t.date) || b.i - a.i);
  const shown = desc.slice(0, 50);
  const detailRows = shown.map(({ t, i }) => {
    if (editIdx === i) {
      return `<tr class="jr-editrow">
        <td><input type="date" id="jr-e-date" value="${esc(t.date)}"></td>
        <td><input type="text" id="jr-e-ticker" value="${esc(t.ticker)}" style="text-transform:uppercase"></td>
        <td><select id="jr-e-side"><option value="buy"${t.side === 'buy' ? ' selected' : ''}>買</option><option value="sell"${t.side === 'sell' ? ' selected' : ''}>賣</option></select></td>
        <td><input type="number" id="jr-e-shares" value="${t.shares}" min="0" step="1"></td>
        <td><input type="number" id="jr-e-price" value="${t.price}" min="0" step="0.01"></td>
        <td class="num tr-muted">—</td>
        <td><input type="text" id="jr-e-selltype" value="${esc(t.sellType || '')}" list="jr-selltypes" placeholder="—"></td>
        <td><select id="jr-e-score"><option value=""${!t.score ? ' selected' : ''}>未評</option><option value="✅"${t.score === '✅' ? ' selected' : ''}>✅</option><option value="⚠️"${t.score === '⚠️' ? ' selected' : ''}>⚠️</option><option value="❌"${t.score === '❌' ? ' selected' : ''}>❌</option></select></td>
        <td><select id="jr-e-depth"><option value=""${t.depth == null ? ' selected' : ''}>—</option>${[0, 1, 2, 3].map(d => `<option value="${d}"${t.depth === d ? ' selected' : ''}>${d}</option>`).join('')}</select></td>
        <td><input type="text" id="jr-e-note" value="${esc(t.note || '')}" placeholder="備註"></td>
        <td class="jr-act"><button class="jr-mini" id="jr-e-save" type="button">儲存</button><button class="jr-mini" id="jr-e-cancel" type="button">取消</button></td>
      </tr>`;
    }
    return `<tr>
      <td class="num">${esc(t.date)}</td>
      <td class="dv-tk">${esc(t.ticker)}</td>
      <td class="${t.side === 'buy' ? 'jr-buy' : 'jr-sell'}">${t.side === 'buy' ? '買' : '賣'}</td>
      <td class="num">${fmt(t.shares)}</td>
      <td class="num">${t.price}</td>
      <td class="num">${fmt(t.shares * t.price)}</td>
      <td>${t.sellType ? esc(t.sellType) : '<span class="tr-muted">—</span>'}</td>
      <td>${t.score || '<span class="tr-muted">—</span>'}</td>
      <td class="num">${t.depth == null ? '<span class="tr-muted">—</span>' : t.depth}</td>
      <td class="jr-note" title="${esc(t.note || '')}">${t.note ? esc(t.note) : '<span class="tr-muted">—</span>'}</td>
      <td class="jr-act"><button class="jr-mini" data-edit="${i}" type="button">編輯</button><button class="jr-mini danger" data-delrow="${i}" type="button">刪除</button></td>
    </tr>`;
  }).join('');

  box.innerHTML = `
    <div class="jr-bar2">
      <div class="seg-mode">
        <button id="jr-mode-q" class="${uiMode === 'quarter' ? 'on' : ''}">季度</button>
        <button id="jr-mode-y" class="${uiMode === 'year' ? 'on' : ''}">年度</button>
      </div>
      <div class="inrow" style="gap:8px;flex:0 0 auto"><span class="suffix">期間</span><select id="jr-period" style="width:auto;min-width:130px">${opts}</select></div>
    </div>

    <div class="zone">
      <div class="q">${periodKey === '__all__' ? '全部期間' : esc(periods.find(p => p.key === periodKey)?.label || periodKey)} · 概況</div>
      <div class="stats">
        <div class="stat"><div class="k">交易筆數</div><div class="v">${scope.length}</div><div class="x">買 ${buys.length} · 賣 ${sells.length}</div></div>
        <div class="stat"><div class="k">總交易金額</div><div class="v">${fmt(totalAmt)}</div><div class="x">買賣合計</div></div>
        <div class="stat"><div class="k">買進金額</div><div class="v">${fmt(amt(buys))}</div><div class="x">${buys.length} 筆</div></div>
        <div class="stat"><div class="k">賣出金額</div><div class="v">${fmt(amt(sells))}</div><div class="x">${sells.length} 筆</div></div>
      </div>
    </div>

    <div class="zone">
      <div class="q">交易明細（${scopeIdx.length} 筆${shown.length < scopeIdx.length ? `，顯示最近 ${shown.length} 筆，切換期間可縮小範圍` : ''}）</div>
      <div class="tr-tablewrap">
        <table class="tr-table jr-detail">
          <thead><tr><th>日期</th><th>代號</th><th>買/賣</th><th>股數</th><th>價格</th><th>金額</th><th>賣出類型</th><th>評分</th><th>完整度</th><th>備註</th><th></th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </div>

    <div class="zone">
      <div class="q">三層判讀完整度趨勢（跨各期，回饋迴路核心）</div>
      <div class="panel">${trendSVG(all, uiMode)}</div>
    </div>

    <div class="zone">
      <div class="q">單一標的 30 天內重複交易</div>
      ${reps.length
        ? `<div class="lampgrid">` + reps.map(r => `<div class="lampcard warn"><div class="lc-k">${esc(r.ticker)}</div><div class="lc-v">${r.count} 次</div><div class="lc-x">30 天窗內${r.span ? `（${r.span[0]} ~ ${r.span[1]}）` : ''}有多次進出</div></div>`).join('') + `</div>`
        : '<div class="chartnote">此期間沒有單一標的在 30 天內重複交易。</div>'}
      <div class="chartnote">依目前選取期間計算。觀察短期內的重複進出，留意是否情緒性交易。</div>
    </div>

    <div class="zone">
      <div class="q">決策評分分布</div>
      ${distBars(scoreEntries)}
    </div>

    <div class="zone">
      <div class="q">賣出類型分布</div>
      ${sells.length ? distBars(sellTypeEntries) : '<div class="chartnote">此期間沒有賣出交易。</div>'}
    </div>

    <div class="zone">
      <div class="q">買賣分布</div>
      ${distBars([
        { label: '買進', count: buys.length, sub: fmt(amt(buys)) },
        { label: '賣出', count: sells.length, sub: fmt(amt(sells)) },
      ])}
    </div>`;

  view.querySelector('#jr-mode-q').addEventListener('click', () => { uiMode = 'quarter'; uiPeriod = '__latest__'; editIdx = null; renderPanel(view); });
  view.querySelector('#jr-mode-y').addEventListener('click', () => { uiMode = 'year'; uiPeriod = '__latest__'; editIdx = null; renderPanel(view); });
  view.querySelector('#jr-period').addEventListener('change', e => { uiPeriod = e.target.value; editIdx = null; renderPanel(view); });

  // 明細表：單筆編輯 / 刪除
  box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { editIdx = +b.dataset.edit; renderPanel(view); }));
  box.querySelectorAll('[data-delrow]').forEach(b => b.addEventListener('click', async () => {
    const i = +b.dataset.delrow;
    const t = all[i];
    if (!t) return;
    if (await confirmModal(`刪除 ${t.date} ${t.ticker} ${t.side === 'buy' ? '買' : '賣'} ${t.shares} 股 這筆紀錄？`, { danger: true, okLabel: '刪除' })) {
      const next = all.slice(); next.splice(i, 1);
      set(JOURNAL_KEY, next);
      editIdx = null;
      renderPanel(view);
      flash(view, '已刪除 1 筆');
    }
  }));
  const eSave = box.querySelector('#jr-e-save');
  if (eSave) {
    eSave.addEventListener('click', () => {
      const g = id => box.querySelector('#' + id);
      const dt = normDate(g('jr-e-date').value);
      const ticker = g('jr-e-ticker').value.trim().toUpperCase();
      const shares = num(g('jr-e-shares').value) || 0;
      const price = num(g('jr-e-price').value) || 0;
      if (!dt || !ticker || shares <= 0 || price <= 0) { flash(view, '日期／代號／股數／價格需填妥'); return; }
      const dvRaw = g('jr-e-depth').value;
      const next = all.slice();
      next[editIdx] = {
        date: dt.date, ticker, side: g('jr-e-side').value, shares, price,
        sellType: g('jr-e-side').value === 'sell' ? g('jr-e-selltype').value.trim() : '',
        score: g('jr-e-score').value, depth: dvRaw === '' ? null : Math.max(0, Math.min(3, +dvRaw)),
        note: g('jr-e-note').value.trim(),
      };
      next.sort((a, b) => a.date.localeCompare(b.date));
      set(JOURNAL_KEY, next);
      editIdx = null;
      renderPanel(view);
      flash(view, '已更新 ✓');
    });
    box.querySelector('#jr-e-cancel').addEventListener('click', () => { editIdx = null; renderPanel(view); });
  }
}

/* ---------- 動作 ---------- */
function doParse(view) {
  const text = view.querySelector('#jr-input').value;
  const incoming = parseCSV(text);
  if (!incoming.length) { flash(view, '沒有可解析的交易列'); return; }
  const { merged, added } = mergeDedup(get(JOURNAL_KEY, []), incoming);
  set(JOURNAL_KEY, merged);
  uiPeriod = '__latest__'; editIdx = null;
  flash(view, `新增 ${added} 筆（去重後），目前共 ${merged.length} 筆 ✓`);
  view.querySelector('#jr-input').value = '';
  renderPanel(view);
}

function exportCSV(view) {
  const all = get(JOURNAL_KEY, []);
  if (!all.length) { flash(view, '目前沒有交易可匯出'); return; }
  const header = '日期,代號,買/賣,股數,價格,賣出類型,決策評分,三層判讀完整度,決策備註';
  const body = all.map(t => [t.date, t.ticker, t.side === 'buy' ? '買' : '賣', t.shares, t.price, csvField(t.sellType || ''), t.score || '', t.depth == null ? '' : t.depth, csvField(t.note || '')].join(',')).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `交易日誌_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function flash(view, msg) {
  const m = view.querySelector('#jr-msg');
  if (!m) return;
  m.textContent = msg;
  clearTimeout(m._t);
  m._t = setTimeout(() => { m.textContent = ''; }, 3000);
}

/* ---------- 單筆快速表單 ---------- */
function wireChoice(view, boxId, onPick) {
  view.querySelectorAll('#' + boxId + ' button').forEach(b => b.addEventListener('click', () => {
    view.querySelectorAll('#' + boxId + ' button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    onPick(b.dataset.v);
  }));
}

function setSide(view, side) {
  form.side = side;
  view.querySelector('#jr-side-buy').classList.toggle('on', side === 'buy');
  view.querySelector('#jr-side-sell').classList.toggle('on', side === 'sell');
  const st = view.querySelector('#jr-f-selltype');
  st.disabled = side !== 'sell';
  if (side !== 'sell') st.value = '';
}

function resetChoice(view, boxId) {
  view.querySelectorAll('#' + boxId + ' button').forEach(x => x.classList.toggle('on', x.dataset.v === ''));
}

function addTrade(view) {
  const q = id => view.querySelector('#' + id);
  const dt = normDate(q('jr-f-date').value);
  const ticker = q('jr-f-ticker').value.trim().toUpperCase();
  const shares = num(q('jr-f-shares').value) || 0;
  const price = num(q('jr-f-price').value) || 0;
  if (!dt) { flash(view, '請填日期'); q('jr-f-date').focus(); return; }
  if (!ticker) { flash(view, '請填代號'); q('jr-f-ticker').focus(); return; }
  if (shares <= 0) { flash(view, '請填股數'); q('jr-f-shares').focus(); return; }
  if (price <= 0) { flash(view, '請填價格'); q('jr-f-price').focus(); return; }
  const t = {
    date: dt.date, ticker, side: form.side, shares, price,
    sellType: form.side === 'sell' ? q('jr-f-selltype').value : '',
    score: form.score, depth: form.depth,
    note: q('jr-f-note').value.trim(),
  };
  const { merged, added } = mergeDedup(get(JOURNAL_KEY, []), [t]);
  if (!added) { flash(view, '這筆與既有紀錄完全相同，未新增'); return; }
  set(JOURNAL_KEY, merged);
  uiPeriod = '__latest__'; editIdx = null;
  // 保留日期與買賣方向，清掉其餘欄位方便連續輸入
  q('jr-f-ticker').value = ''; q('jr-f-shares').value = ''; q('jr-f-price').value = '';
  q('jr-f-selltype').value = ''; q('jr-f-note').value = '';
  form.score = ''; form.depth = null;
  resetChoice(view, 'jr-f-score'); resetChoice(view, 'jr-f-depth');
  renderPanel(view);
  flash(view, `已新增 ${ticker} ${t.side === 'buy' ? '買' : '賣'} ${fmt(shares)} 股 ✓`);
  q('jr-f-ticker').focus();
}

export function mount(view) {
  uiMode = 'quarter'; uiPeriod = '__latest__'; editIdx = null;
  form = { side: 'buy', score: '', depth: null };
  view.innerHTML = `
    <header><div class="brand">
      <h1>交易日誌統計</h1>
      <p>把每筆買賣記下來，工具幫你看回去：買賣分布、賣出類型、決策評分、三層判讀完整度的變化趨勢，以及短期內反覆進出的標的。資料只存在你的瀏覽器、可持續累加，是回看自己決策品質的鏡子。</p>
    </div></header>
    ${flowCrumb('journal')}

    <datalist id="jr-selltypes">${SELL_TYPES.map(t => `<option value="${t}">`).join('')}</datalist>

    <div class="grid">
      <div class="controls">
        <div class="panel">
          <div class="seclabel">新增交易</div>
          <div class="jr-fg">
            <div><label>日期</label><input type="date" id="jr-f-date" value="${todayStr()}"></div>
            <div><label>代號</label><input type="text" id="jr-f-ticker" placeholder="NVDA" style="text-transform:uppercase"></div>
            <div><label>買 / 賣</label><div class="seg-mode jr-side"><button id="jr-side-buy" class="on" type="button">買</button><button id="jr-side-sell" type="button">賣</button></div></div>
            <div><label>股數</label><input type="number" id="jr-f-shares" min="0" step="1" placeholder="0"></div>
            <div><label>價格</label><input type="number" id="jr-f-price" min="0" step="0.01" placeholder="每股成交價"></div>
            <div><label>賣出類型（賣出時）</label><select id="jr-f-selltype" disabled><option value="">未標記</option>${SELL_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
          </div>
          <div class="jr-choicewrap"><label>決策評分</label>
            <div class="jr-choice" id="jr-f-score">
              <button data-v="" class="on" type="button">未評</button><button data-v="✅" type="button">✅ 好</button><button data-v="⚠️" type="button">⚠️ 普</button><button data-v="❌" type="button">❌ 差</button>
            </div>
          </div>
          <div class="jr-choicewrap"><label>三層判讀完整度（體感 / 故事 / 時機，走完幾層）</label>
            <div class="jr-choice" id="jr-f-depth">
              <button data-v="" class="on" type="button">未填</button><button data-v="0" type="button">0</button><button data-v="1" type="button">1</button><button data-v="2" type="button">2</button><button data-v="3" type="button">3</button>
            </div>
          </div>
          <div class="jr-choicewrap"><label>決策備註（選填，一句話記下為什麼）</label>
            <input type="text" id="jr-f-note" placeholder="例：達強檢視觸發點後減碼 / 財報後故事仍完整">
          </div>
          <div class="savebar" style="margin-top:18px">
            <button class="btn-primary" id="jr-add" type="button">新增這筆</button>
            <span class="savemsg" id="jr-msg"></span>
          </div>
        </div>

        <details class="adv" style="margin-top:18px">
          <summary>批次匯入 / 匯出 / 清空</summary>
          <div class="advbody">
            <div class="sub" style="margin:14px 0 10px">批次匯入欄位：日期, 代號, 買/賣, 股數, 價格, 賣出類型(可空), 決策評分 ✅/⚠️/❌ 或 好/普/差(可空), 三層判讀完整度 0–3(可空)。日期 YYYY-MM-DD 或 YYYY/MM/DD。逗號或 Tab 分隔，可含表頭。完全相同的列會自動去重。</div>
            <textarea id="jr-input" rows="9" placeholder="日期,代號,買/賣,股數,價格,賣出類型,決策評分,三層判讀完整度&#10;2026-02-20,NVDA,賣,30,125,停損,⚠️,1"></textarea>
            <div class="savebar" style="margin-top:12px">
              <button class="btn-primary" id="jr-parse" type="button">解析並累加</button>
              <button class="btn-ghost" id="jr-demo" type="button">載入示範資料</button>
              <button class="btn-ghost" id="jr-export" type="button">匯出 CSV</button>
              <button class="btn-ghost" id="jr-clear" type="button">清空日誌</button>
            </div>
          </div>
        </details>
      </div>

      <div class="results" id="jr-out"></div>
    </div>`;

  const q = id => view.querySelector('#' + id);
  q('jr-add').addEventListener('click', () => addTrade(view));
  q('jr-f-ticker').addEventListener('keydown', e => { if (e.key === 'Enter') addTrade(view); });
  q('jr-f-price').addEventListener('keydown', e => { if (e.key === 'Enter') addTrade(view); });
  q('jr-side-buy').addEventListener('click', () => setSide(view, 'buy'));
  q('jr-side-sell').addEventListener('click', () => setSide(view, 'sell'));
  wireChoice(view, 'jr-f-score', v => { form.score = v; });
  wireChoice(view, 'jr-f-depth', v => { form.depth = v === '' ? null : +v; });

  q('jr-parse').addEventListener('click', () => doParse(view));
  q('jr-demo').addEventListener('click', () => { q('jr-input').value = DEMO; doParse(view); });
  q('jr-export').addEventListener('click', () => exportCSV(view));
  q('jr-clear').addEventListener('click', async () => {
    const choice = await showModal({
      title: '清空交易日誌',
      body: '此動作無法復原。要先匯出一份 CSV 備份嗎？',
      buttons: [
        { label: '匯出 CSV 並清空', kind: 'primary', value: 'backup' },
        { label: '直接清空', kind: 'danger', value: 'clear' },
        { label: '取消', kind: 'ghost', value: null },
      ],
    });
    if (!choice) return;
    if (choice === 'backup') exportCSV(view);
    set(JOURNAL_KEY, []); uiPeriod = '__latest__'; editIdx = null; renderPanel(view); flash(view, '已清空');
  });

  renderPanel(view);
}
