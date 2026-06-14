/* ============================================================
   modules/journal/journal.js — 模組3：交易日誌統計
   - 貼上 CSV → 解析 → 累加去重存 localStorage
   - 季/年切換的統計面板：筆數金額、買賣分布、賣出類型分布、決策評分分布
   - 三層判讀完整度（0–3）趨勢、單一標的 30 天內重複交易標記
   - 可匯出 journal 專屬 CSV、可清空
   ============================================================ */
import { get, set } from '../../core/store.js';

export const id = 'journal';
export const title = '交易日誌';

const JOURNAL_KEY = 'journal';
const DAY = 86400000;

const DEMO = `日期,代號,買/賣,股數,價格,賣出類型,決策評分,三層判讀完整度
2025-08-15,NVDA,買,100,110,,✅,3
2025-09-10,AVGO,買,50,160,,⚠️,2
2025-11-20,NVDA,賣,40,140,停利,✅,3
2026-01-12,TSM,買,80,190,,✅,2
2026-02-03,NVDA,買,30,130,,❌,1
2026-02-20,NVDA,賣,30,125,停損,⚠️,1
2026-03-05,MSFT,買,60,420,,✅,3
2026-05-10,PLTR,買,100,30,,⚠️,0`;

let uiMode = 'quarter'; // 'quarter' | 'year'
let uiPeriod = '__latest__';

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
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let rows = lines.map(l => l.split(/\t|,/).map(c => c.trim()));
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
    box.innerHTML = `<div class="placeholder" style="margin:20px 0"><div class="tag">尚無交易</div><h2>貼上交易紀錄或載入示範資料</h2><p>在左側貼上 CSV 後按「解析並累加」，或按「載入示範資料」看效果。</p></div>`;
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
      <div class="q">買賣分布</div>
      ${distBars([
        { label: '買進', count: buys.length, sub: fmt(amt(buys)) },
        { label: '賣出', count: sells.length, sub: fmt(amt(sells)) },
      ])}
    </div>

    <div class="zone">
      <div class="q">賣出類型分布</div>
      ${sells.length ? distBars(sellTypeEntries) : '<div class="chartnote">此期間沒有賣出交易。</div>'}
    </div>

    <div class="zone">
      <div class="q">決策評分分布</div>
      ${distBars(scoreEntries)}
    </div>

    <div class="zone">
      <div class="q">三層判讀完整度趨勢（跨各期）</div>
      <div class="panel">${trendSVG(all, uiMode)}</div>
    </div>

    <div class="zone">
      <div class="q">單一標的 30 天內重複交易</div>
      ${reps.length
        ? `<div class="lampgrid">` + reps.map(r => `<div class="lampcard warn"><div class="lc-k">${esc(r.ticker)}</div><div class="lc-v">${r.count} 次</div><div class="lc-x">30 天窗內${r.span ? `（${r.span[0]} ~ ${r.span[1]}）` : ''}有多次進出</div></div>`).join('') + `</div>`
        : '<div class="chartnote">此期間沒有單一標的在 30 天內重複交易。</div>'}
      <div class="chartnote">依目前選取期間計算。觀察短期內的重複進出，留意是否情緒性交易。</div>
    </div>`;

  view.querySelector('#jr-mode-q').addEventListener('click', () => { uiMode = 'quarter'; uiPeriod = '__latest__'; renderPanel(view); });
  view.querySelector('#jr-mode-y').addEventListener('click', () => { uiMode = 'year'; uiPeriod = '__latest__'; renderPanel(view); });
  view.querySelector('#jr-period').addEventListener('change', e => { uiPeriod = e.target.value; renderPanel(view); });
}

/* ---------- 動作 ---------- */
function doParse(view) {
  const text = view.querySelector('#jr-input').value;
  const incoming = parseCSV(text);
  if (!incoming.length) { flash(view, '沒有可解析的交易列'); return; }
  const { merged, added } = mergeDedup(get(JOURNAL_KEY, []), incoming);
  set(JOURNAL_KEY, merged);
  uiPeriod = '__latest__';
  flash(view, `新增 ${added} 筆（去重後），目前共 ${merged.length} 筆 ✓`);
  view.querySelector('#jr-input').value = '';
  renderPanel(view);
}

function exportCSV(view) {
  const all = get(JOURNAL_KEY, []);
  if (!all.length) { flash(view, '目前沒有交易可匯出'); return; }
  const header = '日期,代號,買/賣,股數,價格,賣出類型,決策評分,三層判讀完整度';
  const body = all.map(t => [t.date, t.ticker, t.side === 'buy' ? '買' : '賣', t.shares, t.price, t.sellType || '', t.score || '', t.depth == null ? '' : t.depth].join(',')).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `交易日誌_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function flash(view, msg) {
  const m = view.querySelector('#jr-msg');
  if (m) { m.textContent = msg; setTimeout(() => { if (m) m.textContent = ''; }, 3000); }
}

export function mount(view) {
  uiMode = 'quarter'; uiPeriod = '__latest__';
  view.innerHTML = `
    <header><div class="brand">
      <h1>交易日誌統計</h1>
      <p>把每筆買賣記下來，工具幫你看回去：買賣分布、賣出類型、決策評分、三層判讀完整度的變化趨勢，以及短期內反覆進出的標的。資料只存在你的瀏覽器、可持續累加，是回看自己決策品質的鏡子。</p>
    </div></header>

    <div class="grid">
      <div class="controls">
        <div class="panel">
          <div class="seclabel">貼上交易</div>
          <div class="field">
            <div class="sub">欄位：日期, 代號, 買/賣, 股數, 價格, 賣出類型(可空), 決策評分 ✅/⚠️/❌(可空), 三層判讀完整度 0–3(可空)。日期 YYYY-MM-DD 或 YYYY/MM/DD。逗號或 Tab 分隔，可含表頭。完全相同的列會自動去重。</div>
            <textarea id="jr-input" rows="12" placeholder="日期,代號,買/賣,股數,價格,賣出類型,決策評分,三層判讀完整度&#10;2026-02-20,NVDA,賣,30,125,停損,⚠️,1"></textarea>
          </div>
          <div class="savebar">
            <button class="btn-primary" id="jr-parse" type="button">解析並累加</button>
            <button class="btn-ghost" id="jr-demo" type="button">載入示範資料</button>
            <button class="btn-ghost" id="jr-export" type="button">匯出 CSV</button>
            <button class="btn-ghost" id="jr-clear" type="button">清空日誌</button>
            <span class="savemsg" id="jr-msg"></span>
          </div>
        </div>
      </div>

      <div class="results" id="jr-out"></div>
    </div>`;

  const q = id => view.querySelector('#' + id);
  q('jr-parse').addEventListener('click', () => doParse(view));
  q('jr-demo').addEventListener('click', () => { q('jr-input').value = DEMO; doParse(view); });
  q('jr-export').addEventListener('click', () => exportCSV(view));
  q('jr-clear').addEventListener('click', () => {
    if (confirm('清空所有交易日誌？此動作無法復原，建議先匯出 CSV 備份。')) { set(JOURNAL_KEY, []); uiPeriod = '__latest__'; renderPanel(view); flash(view, '已清空'); }
  });

  renderPanel(view);
}
