/* ============================================================
   modules/journal/journal.js — 模組3：交易日誌統計
   - 單筆表單快速記錄（日期預設今天、買賣切換、評分/完整度按鈕選取）
   - 批次匯入 CSV（進階折疊）→ 解析 → 累加去重存 localStorage
   - 交易明細表：單筆行內編輯、單筆刪除
   - 季/年切換的統計面板：筆數金額、買賣分布、賣出類型分布、決策評分分布
   - 三層判讀完整度（0–3）趨勢、單一標的 30 天內重複交易標記
   - 已實現損益與勝率（加權平均成本法，描述過去、非建議）
   - 可匯出 journal 專屬 CSV、可清空

   P0-2：「載入示範資料」改為非持久化預覽模式。原本 8 筆示範交易被 merge 進真實
        日誌並持久化，只能逐筆手動刪除，統計、趨勢、重複交易標記全被污染。
   P2-2：清空日誌可在 30 秒內復原。
   P2-3：新增每檔已實現損益、勝率、平均持有天數（加權平均成本法）。
   ============================================================ */
import { get, set, snapshot, restoreLast, UNDO_TTL_MS } from '../../core/store.js';
import { confirmModal, showModal, alertModal, flowCrumb, tipHTML, previewBanner, toast, markLiveRegions } from '../../core/ui.js';
import { splitLine, csvField } from '../../core/parse.js';

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
let demo = false;          // P0-2：示範預覽模式（不寫入 store）
let demoTrades = [];       // 示範模式下的暫存交易，只存在記憶體

const SELL_TYPES = ['停利', '停損', '再平衡', '換股', '調整部位'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function unmount() { demo = false; demoTrades = []; }

/* 目前面板要呈現的交易來源：示範模式讀記憶體，正常模式讀 store */
function currentTrades() {
  return demo ? demoTrades : get(JOURNAL_KEY, []);
}

/* ---------- 工具 ---------- */
function fmt(n) { return (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US'); }
function fmt1(n) { return (n == null || !isFinite(n)) ? '—' : n.toFixed(1); }
function fmtSigned(n) { return (n == null || !isFinite(n)) ? '—' : (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)).toLocaleString('en-US'); }
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

/* ---------- 解析（splitLine / csvField 已抽到 core/parse.js 共用） ---------- */
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

/* ---------- P2-3：已實現損益（加權平均成本法） ----------
   逐筆依日期推進，每檔維護「持有股數 / 成本總額 / 加權平均取得日」：
     買進 → 股數與成本累加；加權平均取得日 = Σ(股數 × 取得日) / 總股數
     賣出 → 已實現損益 = 賣出股數 × (賣價 − 當時加權平均成本)
             持有天數  = 賣出日 − 當時加權平均取得日
             成本按比例扣除（不改變剩餘部位的單位成本）
   沒有前置買進紀錄的賣出（部位在開始記錄前就持有）沒有成本基礎，
   標記為「無成本基礎」並排除於損益與勝率之外，不猜測成本。
   這是描述過去，不是建議。 */
function realized(trades) {
  const sorted = trades.slice().sort((a, b) => {
    const c = String(a.date).localeCompare(String(b.date));
    return c !== 0 ? c : (a.side === 'buy' ? -1 : 1); // 同日先買後賣，避免當沖被判無成本基礎
  });
  const pos = {}; // ticker → {shares, cost, dateWeighted}
  const sells = [];
  sorted.forEach(t => {
    const tk = t.ticker;
    const p = pos[tk] || (pos[tk] = { shares: 0, cost: 0, dw: 0 });
    const ms = normDate(t.date) ? normDate(t.date).ms : null;
    if (t.side === 'buy') {
      p.shares += t.shares;
      p.cost += t.shares * t.price;
      if (ms != null) p.dw += t.shares * ms;
      return;
    }
    // 賣出
    if (p.shares <= 0) { sells.push({ ...t, noBasis: true }); return; }
    const sold = Math.min(t.shares, p.shares);
    const avgCost = p.cost / p.shares;
    const avgMs = p.dw / p.shares;
    const pnl = sold * (t.price - avgCost);
    const holdDays = (ms != null && isFinite(avgMs)) ? Math.max(0, Math.round((ms - avgMs) / DAY)) : null;
    sells.push({
      ...t, noBasis: false, matched: sold, avgCost, pnl, holdDays,
      pnlPct: avgCost > 0 ? (t.price - avgCost) / avgCost * 100 : null,
      partial: t.shares > p.shares, // 賣超過持有：超出部分無成本基礎
    });
    // 成本按比例扣除，剩餘部位的單位成本不變
    const ratio = (p.shares - sold) / p.shares;
    p.cost *= ratio;
    p.dw *= ratio;
    p.shares -= sold;
  });
  return sells;
}

/* 依標的彙總已實現損益 */
function realizedByTicker(sells) {
  const map = {};
  sells.filter(s => !s.noBasis).forEach(s => {
    const m = map[s.ticker] || (map[s.ticker] = { ticker: s.ticker, n: 0, wins: 0, pnl: 0, days: [], proceeds: 0, cost: 0 });
    m.n++;
    if (s.pnl > 0) m.wins++;
    m.pnl += s.pnl;
    m.proceeds += s.matched * s.price;
    m.cost += s.matched * s.avgCost;
    if (s.holdDays != null) m.days.push(s.holdDays);
  });
  return Object.values(map).map(m => ({
    ...m,
    winRate: m.n ? m.wins / m.n * 100 : null,
    avgDays: m.days.length ? m.days.reduce((a, b) => a + b, 0) / m.days.length : null,
    roi: m.cost > 0 ? m.pnl / m.cost * 100 : null,
  })).sort((a, b) => b.pnl - a.pnl);
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
  for (let g = 0; g <= 3; g++) { const y = Y(g); grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.07)"/><text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#c4cad3" font-family="IBM Plex Mono" font-size="12">${g}</text>`; }
  const bars = data.map((d, i) => {
    const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
    if (d.avg == null) return `<text x="${x + w / 2}" y="${H - padB + 18}" text-anchor="middle" fill="#c4cad3" font-family="IBM Plex Sans" font-size="12">${esc(d.label)}</text>`;
    const y = Y(d.avg), h = padT + plotH - y;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#e0b25a"><title>${esc(d.label)}：平均 ${fmt1(d.avg)}（${d.n} 筆）</title></rect>
      <text x="${x + w / 2}" y="${y - 6}" text-anchor="middle" fill="#f2cc7b" font-family="IBM Plex Mono" font-size="12">${fmt1(d.avg)}</text>
      <text x="${x + w / 2}" y="${H - padB + 18}" text-anchor="middle" fill="#c4cad3" font-family="IBM Plex Sans" font-size="12">${esc(d.label)}</text>`;
  }).join('');
  const desc = data.filter(d => d.avg != null).map(d => `${d.label} 平均 ${fmt1(d.avg)}`).join('；');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block" role="img" aria-label="三層判讀完整度趨勢：${esc(desc)}">${grid}${bars}</svg>
    <div class="chartnote">各期「三層判讀完整度」平均（0–3）。只計入有填完整度的交易。</div>`;
}

/* ---------- P2-3：已實現損益區塊 ---------- */
function realizedZone(allTrades, scopeKeys) {
  const sells = realized(allTrades);                                 // 成本基礎需要完整歷史
  const inScope = sells.filter(s => scopeKeys == null || scopeKeys.has(rowKey(s)));
  const withBasis = inScope.filter(s => !s.noBasis);
  const noBasis = inScope.filter(s => s.noBasis);

  if (!inScope.length) {
    return `<div class="zone">
      <div class="q">已實現損益與勝率</div>
      <div class="chartnote">此期間沒有賣出交易，因此沒有已實現損益。買進不產生已實現損益。</div>
    </div>`;
  }

  const byT = realizedByTicker(withBasis);
  const totalPnl = withBasis.reduce((s, x) => s + x.pnl, 0);
  const totalCost = withBasis.reduce((s, x) => s + x.matched * x.avgCost, 0);
  const wins = withBasis.filter(x => x.pnl > 0).length;
  const winRate = withBasis.length ? wins / withBasis.length * 100 : null;
  const allDays = withBasis.filter(x => x.holdDays != null).map(x => x.holdDays);
  const avgDays = allDays.length ? allDays.reduce((a, b) => a + b, 0) / allDays.length : null;

  // 持有天數分布
  const buckets = [
    { label: '< 30 天', test: d => d < 30 },
    { label: '30–90 天', test: d => d >= 30 && d < 90 },
    { label: '90–180 天', test: d => d >= 90 && d < 180 },
    { label: '180–365 天', test: d => d >= 180 && d < 365 },
    { label: '≥ 1 年', test: d => d >= 365 },
  ];
  const dayEntries = buckets.map(b => ({ label: b.label, count: allDays.filter(b.test).length }));

  const rows = byT.map(m => `<tr>
    <td class="dv-tk">${esc(m.ticker)}</td>
    <td class="num">${m.n}</td>
    <td class="num ${m.pnl >= 0 ? 'jr-buy' : 'jr-sell'}">${fmtSigned(m.pnl)}</td>
    <td class="num ${m.roi != null && m.roi >= 0 ? 'jr-buy' : 'jr-sell'}">${m.roi != null ? (m.roi >= 0 ? '+' : '−') + Math.abs(m.roi).toFixed(1) + '%' : '—'}</td>
    <td class="num">${m.winRate != null ? m.winRate.toFixed(0) + '%' : '—'}<span class="tr-muted"> (${m.wins}/${m.n})</span></td>
    <td class="num">${m.avgDays != null ? Math.round(m.avgDays) + ' 天' : '—'}</td>
  </tr>`).join('');

  return `<div class="zone">
    <div class="q">已實現損益與勝率（${tipHTML('加權平均成本法', '每次買進後重算持有部位的平均成本；賣出時以「賣價 − 當時平均成本 × 賣出股數」計算已實現損益。分批買進的部位不區分批次先後。')}）</div>
    <div class="stats" style="margin-top:0;margin-bottom:16px">
      <div class="stat"><div class="k">已實現損益</div><div class="v" style="color:${totalPnl >= 0 ? 'var(--ok)' : 'var(--bad)'}">${fmtSigned(totalPnl)}</div><div class="x">${withBasis.length} 筆賣出</div></div>
      <div class="stat"><div class="k">報酬率</div><div class="v" style="color:${totalPnl >= 0 ? 'var(--ok)' : 'var(--bad)'}">${totalCost > 0 ? (totalPnl >= 0 ? '+' : '−') + Math.abs(totalPnl / totalCost * 100).toFixed(1) + '%' : '—'}</div><div class="x">相對賣出部位成本</div></div>
      <div class="stat"><div class="k">勝率</div><div class="v">${winRate != null ? winRate.toFixed(0) + '%' : '—'}</div><div class="x">${wins}/${withBasis.length} 筆獲利了結</div></div>
      <div class="stat"><div class="k">平均持有天數</div><div class="v">${avgDays != null ? Math.round(avgDays) + ' 天' : '—'}</div><div class="x">加權平均取得日起算</div></div>
    </div>
    ${byT.length ? `<div class="tr-tablewrap">
      <table class="tr-table">
        <thead><tr><th>標的</th><th>賣出筆數</th><th>已實現損益</th><th>報酬率</th><th>勝率</th><th>平均持有</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : ''}
    ${allDays.length ? `<div style="margin-top:16px"><div class="q" style="margin-bottom:11px">持有天數分布</div>${distBars(dayEntries)}</div>` : ''}
    <div class="chartnote">
      這是<b style="color:var(--txt)">描述過去</b>，不是對未來的判斷，也不含任何買賣建議。損益採加權平均成本法，未計入手續費、稅負與匯率。
      ${noBasis.length ? `<br>有 ${noBasis.length} 筆賣出在日誌中找不到對應的買進紀錄（部位可能在開始記錄之前就持有），無成本基礎，已排除於上述損益與勝率之外——工具不會替你猜測成本。` : ''}
    </div>
  </div>`;
}

/* ---------- 渲染面板 ---------- */
function renderPanel(view) {
  const all = currentTrades();
  const box = view.querySelector('#jr-out');
  if (!all.length) {
    box.innerHTML = `<div class="placeholder" style="margin:20px 0"><div class="tag">尚無交易</div><h2>用左側表單記下第一筆交易</h2><p>填日期、代號、買賣、股數、價格，按「新增這筆」即可。也可以展開「批次匯入」貼 CSV，或載入示範資料看效果（示範資料只用於預覽，不會混進你的日誌）。</p></div>`;
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

  // P2-3：已實現損益以完整歷史算成本基礎，但只呈現落在目前期間的賣出
  const scopeKeys = periodKey === '__all__' ? null : new Set(scope.map(rowKey));

  // 交易明細（帶存檔陣列索引，供單筆編輯/刪除；示範模式不提供編輯與刪除）
  const indexed = all.map((t, i) => ({ t, i }));
  const scopeIdx = periodKey === '__all__' ? indexed : indexed.filter(x => periodOf(x.t, uiMode).key === periodKey);
  const desc = scopeIdx.slice().sort((a, b) => b.t.date.localeCompare(a.t.date) || b.i - a.i);
  const shown = desc.slice(0, 50);
  const detailRows = shown.map(({ t, i }) => {
    if (!demo && editIdx === i) {
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
      <td class="jr-act">${demo
        ? '<span class="tr-muted">示範</span>'
        : `<button class="jr-mini" data-edit="${i}" type="button">編輯</button><button class="jr-mini danger" data-delrow="${i}" type="button">刪除</button>`}</td>
    </tr>`;
  }).join('');

  box.innerHTML = `
    <div class="jr-bar2">
      <div class="seg-mode" role="group" aria-label="統計期間單位">
        <button type="button" id="jr-mode-q" class="${uiMode === 'quarter' ? 'on' : ''}" aria-pressed="${uiMode === 'quarter'}">季度</button>
        <button type="button" id="jr-mode-y" class="${uiMode === 'year' ? 'on' : ''}" aria-pressed="${uiMode === 'year'}">年度</button>
      </div>
      <div class="inrow" style="gap:8px;flex:0 0 auto"><span class="suffix">期間</span><select id="jr-period" style="width:auto;min-width:130px" aria-label="選擇期間">${opts}</select></div>
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

    ${realizedZone(all, scopeKeys)}

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
      <div class="q">${tipHTML('三層判讀', '體感／故事／時機三層檢核，走完幾層。這是你自己記下的決策紀律指標。')}完整度趨勢（跨各期，回饋迴路核心）</div>
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

  if (demo) return; // 示範模式：明細唯讀，不掛編輯/刪除

  // 明細表：單筆編輯 / 刪除
  box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { editIdx = +b.dataset.edit; renderPanel(view); }));
  box.querySelectorAll('[data-delrow]').forEach(b => b.addEventListener('click', async () => {
    const i = +b.dataset.delrow;
    const t = all[i];
    if (!t) return;
    if (await confirmModal(`刪除 ${t.date} ${t.ticker} ${t.side === 'buy' ? '買' : '賣'} ${t.shares} 股 這筆紀錄？`, { danger: true, okLabel: '刪除' })) {
      snapshot([JOURNAL_KEY], '刪除交易');
      const next = all.slice(); next.splice(i, 1);
      set(JOURNAL_KEY, next);
      editIdx = null;
      renderPanel(view);
      flash(view, '已刪除 1 筆');
      toast(`已刪除 ${t.date} ${t.ticker} 這筆紀錄。`, {
        actionLabel: '復原', ms: UNDO_TTL_MS,
        onAction: () => { if (restoreLast()) { renderPanel(view); toast('已復原 ✓', { ms: 3000 }); } else alertModal('復原時效已過（30 秒）。'); },
      });
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
  if (demo) { flash(view, '示範模式無法匯入，請先離開示範'); return; }
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

function exportCSV(view, trades) {
  const all = trades || currentTrades();
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

/* ---------- P0-2：示範資料預覽模式 ---------- */
function enterDemo(view) {
  if (demo) return;
  demoTrades = parseCSV(DEMO);
  demo = true;
  editIdx = null; uiPeriod = '__latest__';
  refreshDemoUI(view);
  flash(view, '示範資料檢視中（未寫入你的日誌）');
}
function exitDemo(view) {
  if (!demo) return;
  demo = false; demoTrades = [];
  editIdx = null; uiPeriod = '__latest__';
  refreshDemoUI(view);
  flash(view, '已離開示範，你的日誌原封未動 ✓');
}
function refreshDemoUI(view) {
  const slot = view.querySelector('#jr-banner');
  if (slot) {
    slot.innerHTML = '';
    if (demo) {
      slot.appendChild(previewBanner(
        '示範資料檢視中。這 8 筆交易只用於預覽統計效果，不會寫入你的日誌。離開示範後，統計數字與明細會回到載入前的狀態。',
        () => exitDemo(view)
      ));
    }
  }
  const b = view.querySelector('#jr-demo');
  if (b) b.textContent = demo ? '離開示範' : '載入示範資料';
  ['jr-add', 'jr-parse', 'jr-clear', 'jr-input', 'jr-f-date', 'jr-f-ticker', 'jr-f-shares', 'jr-f-price', 'jr-f-note'].forEach(id => {
    const el = view.querySelector('#' + id);
    if (el) el.disabled = demo;
  });
  renderPanel(view);
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
  st.disabled = side !== 'sell' || demo;
  if (side !== 'sell') st.value = '';
}

function resetChoice(view, boxId) {
  view.querySelectorAll('#' + boxId + ' button').forEach(x => x.classList.toggle('on', x.dataset.v === ''));
}

function addTrade(view) {
  if (demo) { flash(view, '示範模式無法新增，請先離開示範'); return; }
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
  demo = false; demoTrades = [];
  view.innerHTML = `
    <header><div class="brand">
      <h1>交易日誌統計</h1>
      <p>把每筆買賣記下來，工具幫你看回去：已實現損益與勝率、買賣分布、賣出類型、決策評分、三層判讀完整度的變化趨勢，以及短期內反覆進出的標的。資料只存在你的瀏覽器、可持續累加，是回看自己決策品質的鏡子。</p>
    </div></header>
    ${flowCrumb('journal')}

    <div id="jr-banner"></div>

    <datalist id="jr-selltypes">${SELL_TYPES.map(t => `<option value="${t}">`).join('')}</datalist>

    <div class="grid">
      <div class="controls">
        <div class="panel">
          <div class="seclabel">新增交易</div>
          <div class="jr-fg">
            <div><label for="jr-f-date">日期</label><input type="date" id="jr-f-date" value="${todayStr()}"></div>
            <div><label for="jr-f-ticker">代號</label><input type="text" id="jr-f-ticker" placeholder="NVDA" style="text-transform:uppercase"></div>
            <div><label>買 / 賣</label><div class="seg-mode jr-side" role="group" aria-label="買或賣"><button id="jr-side-buy" class="on" type="button" aria-pressed="true">買</button><button id="jr-side-sell" type="button" aria-pressed="false">賣</button></div></div>
            <div><label for="jr-f-shares">股數</label><input type="number" id="jr-f-shares" min="0" step="1" placeholder="0"></div>
            <div><label for="jr-f-price">價格</label><input type="number" id="jr-f-price" min="0" step="0.01" placeholder="每股成交價"></div>
            <div><label for="jr-f-selltype">賣出類型（賣出時）</label><select id="jr-f-selltype" disabled><option value="">未標記</option>${SELL_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
          </div>
          <div class="jr-choicewrap"><label>決策評分</label>
            <div class="jr-choice" id="jr-f-score" role="group" aria-label="決策評分">
              <button data-v="" class="on" type="button">未評</button><button data-v="✅" type="button">✅ 好</button><button data-v="⚠️" type="button">⚠️ 普</button><button data-v="❌" type="button">❌ 差</button>
            </div>
          </div>
          <div class="jr-choicewrap"><label>三層判讀完整度（體感 / 故事 / 時機，走完幾層）</label>
            <div class="jr-choice" id="jr-f-depth" role="group" aria-label="三層判讀完整度">
              <button data-v="" class="on" type="button">未填</button><button data-v="0" type="button">0</button><button data-v="1" type="button">1</button><button data-v="2" type="button">2</button><button data-v="3" type="button">3</button>
            </div>
          </div>
          <div class="jr-choicewrap"><label for="jr-f-note">決策備註（選填，一句話記下為什麼）</label>
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
            <div class="sub" style="margin:14px 0 10px">批次匯入欄位：日期, 代號, 買/賣, 股數, 價格, 賣出類型(可空), 決策評分 ✅/⚠️/❌ 或 好/普/差(可空), 三層判讀完整度 0–3(可空), 決策備註(可空，可用引號包住含逗號的文字)。日期 YYYY-MM-DD 或 YYYY/MM/DD。逗號或 Tab 分隔，可含表頭。完全相同的列會自動去重。</div>
            <textarea id="jr-input" rows="9" aria-label="批次匯入交易 CSV" placeholder="日期,代號,買/賣,股數,價格,賣出類型,決策評分,三層判讀完整度&#10;2026-02-20,NVDA,賣,30,125,停損,⚠️,1"></textarea>
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
  // P0-2：示範資料 = 預覽模式切換，不再 merge 進真實日誌
  q('jr-demo').addEventListener('click', () => { demo ? exitDemo(view) : enterDemo(view); });
  q('jr-export').addEventListener('click', () => exportCSV(view));
  q('jr-clear').addEventListener('click', async () => {
    if (demo) { flash(view, '示範模式無法清空，請先離開示範'); return; }
    const existing = get(JOURNAL_KEY, []);
    if (!existing.length) { flash(view, '日誌已經是空的'); return; }
    const choice = await showModal({
      title: '清空交易日誌',
      body: `將刪除 ${existing.length} 筆交易紀錄。清空後 30 秒內可以按「復原」救回來。`,
      buttons: [
        { label: '匯出 CSV 並清空', kind: 'primary', value: 'backup' },
        { label: '直接清空', kind: 'danger', value: 'clear' },
        { label: '取消', kind: 'ghost', value: null },
      ],
    });
    if (!choice) return;
    if (choice === 'backup') exportCSV(view, existing);
    snapshot([JOURNAL_KEY], '清空日誌');
    set(JOURNAL_KEY, []); uiPeriod = '__latest__'; editIdx = null; renderPanel(view); flash(view, '已清空');
    toast(`已清空交易日誌（${existing.length} 筆）。`, {
      actionLabel: '復原', ms: UNDO_TTL_MS,
      onAction: () => { if (restoreLast()) { renderPanel(view); toast('已復原日誌 ✓', { ms: 3500 }); } else alertModal('復原時效已過（30 秒），資料無法還原。'); },
    });
  });

  renderPanel(view);
  markLiveRegions(view);
}
