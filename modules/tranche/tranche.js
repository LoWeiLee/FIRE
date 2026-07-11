/* ============================================================
   modules/tranche/tranche.js — 模組1：分批建倉計算器
   - 雙模式目標輸入（金額 / 佔組合%）
   - 逐批股數（floor，不買零股）、累計持股、累計投入、剩餘現金
   - 剩餘現金佔組合% 對照設定頁現金舒適區間下緣
   - 多計畫存 localStorage、可命名/載入/刪除、每批可標記已執行
   - 不寫回共享持股資料（依使用者決策）
   ============================================================ */
import { get, set, remove, portfolioTotal } from '../../core/store.js';
import { getSettings } from '../../core/settings.js';
import { confirmModal, alertModal, flowCrumb } from '../../core/ui.js';

export const id = 'tranche';
export const title = '分批建倉';

const PLANS_KEY = 'tranchePlans';

let state, plansCache;

export function unmount() {}

/* ---------- 工具 ---------- */
function fmt(n) {
  if (n == null || !isFinite(n)) return '—';
  const neg = n < 0; n = Math.abs(n);
  const s = Math.round(n).toLocaleString('en-US');
  return (neg ? '−' : '') + s;
}
function fmt1(n) { return (n == null || !isFinite(n)) ? '—' : n.toFixed(1); }
function uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function defaultState() {
  return {
    name: '', ticker: '', price: 0, cash: 0,
    targetMode: 'amount', targetAmount: 0, targetPct: 0, portfolioTotal: 0,
    heldShares: 0, batchCount: 3,
    batches: evenBatches(3),
  };
}
function evenBatches(n) {
  const base = Math.floor(100 / n);
  const arr = Array.from({ length: n }, () => ({ weight: base, trigger: '', executed: false }));
  arr[0].weight += 100 - base * n; // 補足到 100
  return arr;
}
function resizeBatches(n) {
  // 保留使用者已調整的比重與觸發條件，不再無聲重置
  const old = state.batches;
  const next = [];
  for (let i = 0; i < n; i++) {
    if (old[i]) next.push({ weight: old[i].weight || 0, trigger: old[i].trigger, executed: old[i].executed });
    else next.push({ weight: 0, trigger: '', executed: false });
  }
  if (n > old.length) {
    // 新增的批平分「距 100% 的剩餘比重」
    const sum = old.reduce((s, b) => s + (b.weight || 0), 0);
    const remain = Math.max(0, 100 - sum);
    const cnt = n - old.length;
    const each = Math.floor(remain / cnt);
    for (let i = old.length; i < n; i++) next[i].weight = each;
    next[n - 1].weight += remain - each * cnt;
  }
  state.batches = next;
}
function evenizeBatches() {
  // 顯式的「平均分配」：只動比重，保留觸發條件與已執行
  const even = evenBatches(state.batches.length);
  state.batches = state.batches.map((b, i) => ({ ...b, weight: even[i].weight }));
}

/* ---------- 計算核心 ---------- */
function compute() {
  const T = state.targetMode === 'amount'
    ? (state.targetAmount || 0)
    : (state.portfolioTotal || 0) * (state.targetPct || 0) / 100;
  const price = state.price || 0;
  const cash = state.cash || 0;
  let cumShares = state.heldShares || 0;
  let cumInvested = 0;
  const rows = state.batches.map((b, i) => {
    const amount = (b.weight || 0) / 100 * T;
    const shares = price > 0 ? Math.floor(amount / price) : 0;
    const actual = shares * price;
    cumShares += shares;
    cumInvested += actual;
    const remaining = cash - cumInvested;
    const remainingPct = state.portfolioTotal > 0 ? remaining / state.portfolioTotal * 100 : null;
    return {
      i, weight: b.weight || 0, trigger: b.trigger || '', executed: !!b.executed,
      amount, shares, actual, cumShares, cumInvested, remaining, remainingPct,
      insufficient: cumInvested > cash + 1e-6,
    };
  });
  const totalShares = rows.reduce((s, r) => s + r.shares, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const avgCost = totalShares > 0 ? totalActual / totalShares : 0;
  const weightSum = state.batches.reduce((s, b) => s + (b.weight || 0), 0);
  const finalRemaining = cash - totalActual;
  const finalRemainingPct = state.portfolioTotal > 0 ? finalRemaining / state.portfolioTotal * 100 : null;
  return { T, rows, totalShares, totalActual, avgCost, weightSum, finalRemaining, finalRemainingPct };
}

/* ---------- 渲染：結果區（隨輸入即時更新，不重建輸入框以保留游標） ---------- */
function renderResults(view) {
  const r = compute();
  const s = getSettings();
  const low = s.cash.low, high = s.cash.high;
  const box = view.querySelector('#tr-results');
  if (!box) return;
  const detailsOpen = !!box.querySelector('details.adv[open]'); // 重繪前記住折疊狀態

  // 引導式空狀態：告訴使用者還缺什麼，填完自動出結果
  const reqs = [
    { label: '標的現價', ok: state.price > 0 },
    { label: '可用現金', ok: state.cash > 0 },
  ];
  if (state.targetMode === 'amount') {
    reqs.push({ label: '目標配置金額', ok: state.targetAmount > 0 });
  } else {
    reqs.push({ label: '目標佔組合比重 %', ok: state.targetPct > 0 });
    reqs.push({ label: '組合總值（佔組合 % 模式必填）', ok: state.portfolioTotal > 0 });
  }
  const missing = reqs.filter(x => !x.ok);
  if (missing.length) {
    box.innerHTML = `<div class="placeholder" style="margin:20px 0">
      <div class="tag">還缺 ${missing.length} 項</div>
      <h2>填完左側必填欄位就會自動計算</h2>
      <div class="gd-list">${reqs.map(x => `<span class="gd-i ${x.ok ? 'ok' : 'todo'}">${x.ok ? '✓' : '○'} ${x.label}</span>`).join('')}</div>
      <p style="margin-top:16px">選填：標的代號（記入日誌需要）、已持有股數、觸發條件。</p>
    </div>`;
    return;
  }

  const targetLine = r.T > 0
    ? `目標配置金額 <b>${fmt(r.T)}</b>` + (state.targetMode === 'pct' ? `（組合 ${fmt1(state.targetPct)}% × 總值 ${fmt(state.portfolioTotal)}）` : '')
    : '請先填入目標配置';

  const weightWarn = Math.abs(r.weightSum - 100) > 0.01
    ? `<span class="tr-warn">各批比重合計 ${fmt1(r.weightSum)}%（非 100%，已按填入比重計算）</span>` : '';

  const lampOf = pct => {
    if (pct == null) return '';
    const kind = pct < low ? 'bad' : (pct > high ? 'warn' : 'ok');
    const txt = pct < low ? '低於下緣' : (pct > high ? '高於上緣' : '區間內');
    return `<span class="lamp lamp-${kind}" title="現金舒適區間 ${low}–${high}%">${fmt1(pct)}% · ${txt}</span>`;
  };

  // 批次卡片：把「這批該買幾股、花多少錢」放在第一眼
  const cards = r.rows.map(row => {
    const cls = 'tr-card' + (row.executed ? ' done' : '') + (row.insufficient ? ' insuf' : '');
    const insuf = row.insufficient ? `<span class="tr-bad">現金不足</span>` : '';
    return `<div class="${cls}">
      <div class="tr-card-top">
        <label class="tr-exec"><input type="checkbox" data-exec="${row.i}" ${row.executed ? 'checked' : ''}>第 ${row.i + 1} 批${row.executed ? '（已執行）' : ''}</label>
        <span class="tr-card-w">比重 ${fmt1(row.weight)}%</span>
      </div>
      <div class="tr-card-main">買 <b>${fmt(row.shares)}</b> 股 ≈ <b>${fmt(row.actual)}</b><span class="tr-card-sub">目標金額 ${fmt(row.amount)}</span></div>
      <div class="tr-card-trig">${row.trigger ? '觸發：' + esc(row.trigger) : '<span class="tr-muted">未設觸發條件</span>'}</div>
      <div class="tr-card-foot">
        <span>執行後累計 <b>${fmt(row.cumShares)}</b> 股</span>
        <span>已投入 ${fmt(row.cumInvested)}</span>
        <span>剩餘現金 ${fmt(row.remaining)} ${insuf}</span>
        ${row.remainingPct != null ? `<span>${lampOf(row.remainingPct)}</span>` : ''}
        <span class="tr-card-act"><button class="jr-mini" data-log="${row.i}" type="button" title="以今天日期把這批寫入交易日誌">記入日誌</button></span>
      </div>
    </div>`;
  }).join('');

  // 明細表（折疊保留）
  const rows = r.rows.map(row => {
    const exClass = row.executed ? ' tr-done' : '';
    const insuf = row.insufficient ? `<span class="tr-bad">現金不足</span>` : '';
    const pctCell = row.remainingPct != null ? lampOf(row.remainingPct) : '—';
    return `<tr class="${exClass}">
      <td>第 ${row.i + 1} 批</td>
      <td class="tr-trig">${row.trigger ? esc(row.trigger) : '<span class="tr-muted">—</span>'}</td>
      <td class="num">${fmt1(row.weight)}%</td>
      <td class="num">${fmt(row.amount)}</td>
      <td class="num">${fmt(row.shares)}</td>
      <td class="num">${fmt(row.actual)}</td>
      <td class="num">${fmt(row.cumShares)}</td>
      <td class="num">${fmt(row.cumInvested)}</td>
      <td class="num">${fmt(row.remaining)} ${insuf}</td>
      <td>${pctCell}</td>
    </tr>`;
  }).join('');

  // 摘要：達標後現金占比燈號
  let finalLamp = '';
  if (r.finalRemainingPct != null) {
    const lamp = r.finalRemainingPct < low ? 'bad' : (r.finalRemainingPct > high ? 'warn' : 'ok');
    const txt = r.finalRemainingPct < low ? `低於舒適下緣 ${low}%` : (r.finalRemainingPct > high ? `高於舒適上緣 ${high}%` : `落在舒適區間 ${low}–${high}%`);
    finalLamp = `<span class="lamp lamp-${lamp}">${fmt1(r.finalRemainingPct)}% · ${txt}</span>`;
  }

  box.innerHTML = `
    <div class="zone">
      <div class="q">建倉計畫</div>
      <div class="pnote" style="margin-bottom:14px">${targetLine} ${weightWarn}</div>
      <div class="tr-cards">${cards}</div>
      <details class="adv" style="margin-top:14px">
        <summary>詳細表格（逐批完整數字）</summary>
        <div class="advbody">
          <div class="tr-tablewrap" style="margin-top:14px">
            <table class="tr-table">
              <thead><tr>
                <th>批次</th><th>觸發條件</th><th>比重</th><th>目標金額</th><th>股數</th>
                <th>實際金額</th><th>累計持股</th><th>累計投入</th><th>剩餘現金</th><th>剩餘現金佔組合</th>
              </tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </details>
    </div>

    <div class="zone">
      <div class="q">摘要</div>
      <div class="stats">
        <div class="stat"><div class="k">總投入</div><div class="v">${fmt(r.totalActual)}</div><div class="x">${state.cash > 0 ? fmt1(r.totalActual / state.cash * 100) + '% 可用現金' : ''}</div></div>
        <div class="stat"><div class="k">總股數</div><div class="v">${fmt(r.totalShares)}</div><div class="x">不含已持有 ${fmt(state.heldShares)}</div></div>
        <div class="stat"><div class="k">平均成本</div><div class="v">${r.avgCost > 0 ? fmt(r.avgCost) : '—'}</div><div class="x">本計畫買入均價</div></div>
        <div class="stat"><div class="k">達標後現金</div><div class="v">${fmt(r.finalRemaining)}</div><div class="x">${finalLamp || '填組合總值以顯示占比'}</div></div>
      </div>
    </div>

    <div class="zone">
      <div class="q">資金分布</div>
      <div class="panel">${stackedBar(r)}</div>
    </div>`;

  if (detailsOpen) { const d = box.querySelector('details.adv'); if (d) d.open = true; }

  box.querySelectorAll('[data-exec]').forEach(cb => cb.addEventListener('change', () => {
    state.batches[+cb.dataset.exec].executed = cb.checked;
    autosaveExec(view);
    renderResults(view);
  }));

  // A6：把某批以今天日期記入交易日誌（買進），打通執行 → 記錄
  box.querySelectorAll('[data-log]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.log;
    const row = compute().rows[i];
    if (!String(state.ticker || '').trim()) { alertModal('請先填「標的代號」，日誌需要知道記在哪一檔。'); return; }
    if (!(row.shares > 0) || !(state.price > 0)) { alertModal('這批的股數或價格為 0，沒有可記入的交易。'); return; }
    const t = {
      date: todayStr(), ticker: String(state.ticker).trim().toUpperCase(), side: 'buy',
      shares: row.shares, price: state.price, sellType: '', score: '', depth: null,
      note: `分批建倉：${state.name.trim() || '未命名計畫'} 第 ${i + 1} 批`,
    };
    const all = get('journal', []);
    const key = x => [x.date, x.ticker, x.side, x.shares, x.price].join('|');
    if (all.some(x => key(x) === key(t))) { flash(view, '日誌已有完全相同的一筆，未重複記入'); return; }
    all.push(t);
    all.sort((a, b) => a.date.localeCompare(b.date));
    set('journal', all);
    if (!state.batches[i].executed) { state.batches[i].executed = true; autosaveExec(view); }
    flash(view, `已記入交易日誌 ✓ 買 ${fmt(row.shares)} 股（評分可到日誌頁補）`);
    renderResults(view);
  }));
}

/* A2：勾選已執行後，若計畫已儲存過則自動存回，不再依賴手動儲存 */
function autosaveExec(view) {
  const plans = get(PLANS_KEY, []);
  let idx = state.id ? plans.findIndex(p => p.id === state.id) : -1;
  if (idx < 0 && state.name.trim()) idx = plans.findIndex(p => p.name === state.name.trim());
  if (idx >= 0) {
    const snap = JSON.parse(JSON.stringify(state));
    snap.id = plans[idx].id; snap.name = plans[idx].name;
    state.id = snap.id;
    plans[idx] = snap;
    set(PLANS_KEY, plans);
    renderPlans(view);
    flash(view, '已執行狀態已自動存回計畫 ✓');
  } else {
    flash(view, '提示：此計畫尚未儲存，勾選狀態重新整理後不會保留');
  }
}

/* ---------- SVG 堆疊條（零依賴） ---------- */
function stackedBar(r) {
  const cash = state.cash || 0;
  const denom = Math.max(cash, r.totalActual, 1);
  const palette = ['#e0b25a', '#cf9a45', '#bf8a3d', '#a9772f'];
  let x = 0;
  const W = 100;
  const segs = [];
  r.rows.forEach((row, i) => {
    if (row.actual <= 0) return;
    const w = row.actual / denom * W;
    segs.push(`<rect x="${x}" y="0" width="${w}" height="22" fill="${palette[i % palette.length]}"><title>第 ${i + 1} 批投入 ${fmt(row.actual)}</title></rect>`);
    x += w;
  });
  if (r.finalRemaining > 0) {
    const w = r.finalRemaining / denom * W;
    segs.push(`<rect x="${x}" y="0" width="${w}" height="22" fill="#3a434f"><title>剩餘現金 ${fmt(r.finalRemaining)}</title></rect>`);
  }
  const overspend = r.totalActual > cash;
  const legend = r.rows.filter(row => row.actual > 0).map((row, i) =>
    `<span class="leg-i"><i style="background:${palette[i % palette.length]}"></i>第 ${i + 1} 批 ${fmt(row.actual)}</span>`).join('')
    + (r.finalRemaining > 0 ? `<span class="leg-i"><i style="background:#3a434f"></i>剩餘現金 ${fmt(r.finalRemaining)}</span>` : '');
  return `
    <svg viewBox="0 0 100 22" preserveAspectRatio="none" style="width:100%;height:22px;border-radius:6px;overflow:hidden;display:block">${segs.join('')}</svg>
    <div class="tr-legend">${legend}</div>
    ${overspend ? `<div class="tr-warn" style="margin-top:10px">累計投入 ${fmt(r.totalActual)} 已超過可用現金 ${fmt(cash)}，超出部分需要額外資金。</div>` : ''}`;
}

/* ---------- 渲染：批次輸入（批數改變時重建） ---------- */
function renderBatchInputs(view) {
  const box = view.querySelector('#tr-batches');
  if (!box) return;
  box.innerHTML = state.batches.map((b, i) => `
    <div class="tr-batch">
      <div class="tr-batch-h">第 ${i + 1} 批</div>
      <div class="flowgrid">
        <div><label>比重 %</label><input type="number" data-bk="weight" data-bi="${i}" value="${b.weight}" min="0" max="100" step="1"></div>
        <div><label>觸發條件（自由文字）</label><input type="text" data-bk="trigger" data-bi="${i}" value="${esc(b.trigger)}" placeholder="例：跌破 20MA / 財報後 / 回測支撐"></div>
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-bk]').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.bi, k = inp.dataset.bk;
    state.batches[i][k] = inp.type === 'number' ? (parseFloat(inp.value) || 0) : inp.value;
    renderResults(view);
  }));
}

/* ---------- 渲染：計畫管理列 ---------- */
function renderPlans(view) {
  const box = view.querySelector('#tr-plans');
  if (!box) return;
  plansCache = get(PLANS_KEY, []);
  const chips = plansCache.length
    ? plansCache.map(p => {
        const done = (p.batches || []).filter(b => b.executed).length;
        return `<span class="tagchip">${esc(p.name || '未命名')}${done ? ` <em style="color:var(--ok);font-style:normal">(${done}/${(p.batches || []).length} 已執行)</em>` : ''}
          <button data-load="${p.id}" title="載入">↺</button><button data-del="${p.id}" title="刪除">×</button></span>`;
      }).join('')
    : '<span class="tr-muted" style="font-size:13px">尚無儲存的計畫</span>';
  box.innerHTML = chips;
  box.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => {
    const p = plansCache.find(x => x.id === b.dataset.load);
    if (p) { state = JSON.parse(JSON.stringify(p)); syncForm(view); renderBatchInputs(view); renderResults(view); }
  }));
  box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const p = plansCache.find(x => x.id === b.dataset.del);
    if (await confirmModal(`刪除建倉計畫「${p ? p.name : ''}」？`, { danger: true, okLabel: '刪除' })) {
      set(PLANS_KEY, plansCache.filter(x => x.id !== b.dataset.del));
      renderPlans(view);
    }
  }));
}

/* 把 state 寫回輸入框（載入計畫時用） */
function syncForm(view) {
  const q = id => view.querySelector('#' + id);
  q('tr-name').value = state.name || '';
  q('tr-ticker').value = state.ticker || '';
  q('tr-price').value = state.price || '';
  q('tr-cash').value = state.cash || '';
  q('tr-held').value = state.heldShares || '';
  q('tr-ptotal').value = state.portfolioTotal || '';
  q('tr-tamount').value = state.targetAmount || '';
  q('tr-tpct').value = state.targetPct || '';
  q('tr-count').value = state.batchCount;
  setMode(view, state.targetMode);
}

function setMode(view, mode) {
  state.targetMode = mode;
  view.querySelector('#mode-amount').classList.toggle('on', mode === 'amount');
  view.querySelector('#mode-pct').classList.toggle('on', mode === 'pct');
  view.querySelector('#row-amount').style.display = mode === 'amount' ? '' : 'none';
  view.querySelector('#row-pct').style.display = mode === 'pct' ? '' : 'none';
  // A5：切到「佔組合 %」時，若有共享持股資料就自動帶入組合總值
  if (mode === 'pct' && !(state.portfolioTotal > 0)) {
    const t = portfolioTotal();
    if (t > 0) {
      state.portfolioTotal = t;
      view.querySelector('#tr-ptotal').value = t;
      flash(view, '已自動帶入共享持股的組合總值');
    }
  }
}

/* ---------- mount ---------- */
export function mount(view) {
  state = defaultState();

  view.innerHTML = `
    <header><div class="brand">
      <h1>分批建倉計算器</h1>
      <p>把「想買多少」拆成幾批分批進場：算出每批該買幾股（不買零股）、各批執行後的累計持股與剩餘現金，並對照你設定的現金舒適區間。計畫可存在瀏覽器、逐批標記已執行。這是執行計算工具，不產出買賣建議。</p>
    </div></header>
    ${flowCrumb('tranche')}

    <div class="grid">
      <div class="controls">
        <div class="panel">
          <div class="seclabel">標的與資金</div>
          <div class="field"><label>標的代號（選填）</label><input type="text" id="tr-ticker" placeholder="例：NVDA" style="text-transform:uppercase"></div>
          <div class="field"><label>標的現價</label><input type="number" id="tr-price" min="0" step="0.01" placeholder="每股價格"></div>
          <div class="field"><label>可用現金</label><input type="number" id="tr-cash" min="0" step="1000" placeholder="這次建倉可動用的現金"></div>
          <div class="field"><label>目前已持有股數（選填）</label><input type="number" id="tr-held" min="0" step="1" placeholder="0"></div>
        </div>

        <div class="panel" style="margin-top:18px">
          <div class="seclabel">目標配置</div>
          <div class="seg-mode" style="margin-bottom:16px">
            <button id="mode-amount" class="on">直接填金額</button>
            <button id="mode-pct">佔組合 %</button>
          </div>
          <div class="field" id="row-amount"><label>目標配置金額</label><input type="number" id="tr-tamount" min="0" step="1000" placeholder="總共想投入這檔多少"></div>
          <div class="field" id="row-pct" style="display:none"><label>目標佔組合比重 %</label><input type="number" id="tr-tpct" min="0" max="100" step="0.5" placeholder="例：8"></div>
          <div class="field">
            <label>組合總值</label>
            <div class="sub">用來計算剩餘現金佔組合 %（佔組合 % 模式必填）。</div>
            <div class="inrow"><input type="number" id="tr-ptotal" min="0" step="10000" placeholder="整體投資組合市值"><button class="btn-ghost" id="tr-pull" type="button" style="white-space:nowrap">帶入持股</button></div>
          </div>
        </div>

        <div class="panel" style="margin-top:18px">
          <div class="seclabel">分批設計</div>
          <div class="field"><label>分批數</label>
            <div class="sub">改批數會保留你調過的比重與觸發條件；要重新平均用右邊按鈕。</div>
            <div class="inrow"><select id="tr-count" style="width:auto;flex:1"><option value="1">1 批</option><option value="2">2 批</option><option value="3" selected>3 批</option><option value="4">4 批</option></select><button class="btn-ghost" id="tr-even" type="button" style="white-space:nowrap">平均分配比重</button></div>
          </div>
          <div id="tr-batches"></div>
        </div>

        <div class="panel" style="margin-top:18px">
          <div class="seclabel">計畫管理</div>
          <div class="field"><label>計畫名稱</label><input type="text" id="tr-name" placeholder="例：NVDA 回檔分批"></div>
          <div class="savebar" style="margin-bottom:14px">
            <button class="btn-primary" id="tr-save" type="button">儲存計畫</button>
            <button class="btn-ghost" id="tr-new" type="button">清空重來</button>
            <span class="savemsg" id="tr-msg"></span>
          </div>
          <div class="tagrow" id="tr-plans"></div>
        </div>
      </div>

      <div class="results" id="tr-results"></div>
    </div>`;

  const q = id => view.querySelector('#' + id);
  const bind = (id, key, num) => q(id).addEventListener('input', () => {
    state[key] = num ? (parseFloat(q(id).value) || 0) : q(id).value;
    renderResults(view);
  });
  bind('tr-ticker', 'ticker', false);
  bind('tr-price', 'price', true);
  bind('tr-cash', 'cash', true);
  bind('tr-held', 'heldShares', true);
  bind('tr-tamount', 'targetAmount', true);
  bind('tr-tpct', 'targetPct', true);
  bind('tr-ptotal', 'portfolioTotal', true);
  q('tr-name').addEventListener('input', () => { state.name = q('tr-name').value; });

  q('mode-amount').addEventListener('click', () => { setMode(view, 'amount'); renderResults(view); });
  q('mode-pct').addEventListener('click', () => { setMode(view, 'pct'); renderResults(view); });

  q('tr-pull').addEventListener('click', () => {
    const t = portfolioTotal();
    if (t > 0) { state.portfolioTotal = t; q('tr-ptotal').value = t; renderResults(view); }
    else alertModal('共享持股資料目前為空。請先在「組合偏離」模組輸入持股，或手動填組合總值。');
  });

  q('tr-count').addEventListener('change', () => {
    state.batchCount = parseInt(q('tr-count').value);
    resizeBatches(state.batchCount);
    renderBatchInputs(view);
    renderResults(view);
  });

  q('tr-even').addEventListener('click', () => {
    evenizeBatches();
    renderBatchInputs(view);
    renderResults(view);
    flash(view, '比重已平均分配');
  });

  q('tr-save').addEventListener('click', () => {
    if (!state.name.trim()) { q('tr-name').focus(); flash(view, '請先填計畫名稱'); return; }
    const plans = get(PLANS_KEY, []);
    const snapshot = JSON.parse(JSON.stringify(state));
    const existing = plans.findIndex(p => p.name === state.name.trim());
    snapshot.name = state.name.trim();
    if (existing >= 0) { snapshot.id = plans[existing].id; plans[existing] = snapshot; }
    else { snapshot.id = uid(); plans.push(snapshot); }
    set(PLANS_KEY, plans);
    renderPlans(view);
    flash(view, '已儲存 ✓');
  });

  q('tr-new').addEventListener('click', async () => {
    if (await confirmModal('清空目前輸入，開新計畫？（已儲存的計畫不受影響）')) {
      state = defaultState(); syncForm(view); renderBatchInputs(view); renderResults(view);
    }
  });

  // 接收「組合偏離 → 帶入建倉」的交接資料
  const ho = get('trancheHandoff', null);
  if (ho && ho.ticker) {
    remove('trancheHandoff');
    state.ticker = ho.ticker;
    state.targetMode = 'amount';
    state.targetAmount = Math.max(0, Math.round(ho.amount || 0));
    if (ho.portfolioTotal > 0) state.portfolioTotal = Math.round(ho.portfolioTotal);
    syncForm(view);
    flash(view, `已帶入 ${ho.ticker} 回到目標所需金額，請填現價與可用現金`);
  }

  renderBatchInputs(view);
  renderPlans(view);
  renderResults(view);
}

function flash(view, msg) {
  const m = view.querySelector('#tr-msg');
  if (!m) return;
  m.textContent = msg;
  clearTimeout(m._t); // 避免舊訊息的清除計時器洗掉新訊息
  m._t = setTimeout(() => { m.textContent = ''; }, 3000);
}
