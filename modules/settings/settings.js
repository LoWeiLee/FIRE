/* ============================================================
   modules/settings/settings.js — 設定頁
   個人化規則參數的可配置 UI，全部存 localStorage。
   被建倉計算器與偏離視覺化共用。
   ============================================================ */
import { getSettings, saveSettings, resetSettings, DEFAULT_SETTINGS, AI6_LAYERS } from '../../core/settings.js';

export const id = 'settings';
export const title = '設定';

let _cleanup = [];

export function unmount() {
  _cleanup.forEach(fn => { try { fn(); } catch (e) {} });
  _cleanup = [];
}

export function mount(view) {
  let s = getSettings();

  function render() {
    const customRows = s.classification.custom.map((name, i) =>
      `<span class="tagchip">${escapeHtml(name)}<button data-rmlayer="${i}" title="移除">×</button></span>`
    ).join('');
    const exRows = s.exemptions.map((t, i) =>
      `<span class="tagchip">${escapeHtml(t)}<button data-rmex="${i}" title="移除">×</button></span>`
    ).join('');

    view.innerHTML = `
      <div class="setwrap">
        <header><div class="brand"><h1>設定</h1><p>這些規則參數會被「分批建倉」與「組合偏離」共用。所有設定只存在你的瀏覽器（localStorage），不會上傳。</p></div></header>

        <div class="setcard">
          <h3>集中度觸發點</h3>
          <div class="desc">單一標的佔組合比重超過觸發點時，偏離視覺化會亮燈提示走三層判讀（不是執行授權）。</div>
          <div class="setrow"><div class="lab">一般觸發點<small>達此比重提示重新檢視</small></div><div class="inrow"><input type="number" id="conc-single" value="${s.concentration.single}" min="1" max="100" step="1"><span class="suffix">%</span></div></div>
          <div class="setrow"><div class="lab">強檢視觸發點<small>達此比重強烈提示走三層判讀</small></div><div class="inrow"><input type="number" id="conc-strong" value="${s.concentration.strong}" min="1" max="100" step="1"><span class="suffix">%</span></div></div>
        </div>

        <div class="setcard">
          <h3>現金舒適區間</h3>
          <div class="desc">現金佔組合比重的舒適範圍。建倉計算器會用下緣判斷剩餘現金是否仍在區間內；偏離視覺化會在低於下緣或高於上緣時亮燈。</div>
          <div class="setrow"><div class="lab">下緣<small>低於此比重提示現金偏低</small></div><div class="inrow"><input type="number" id="cash-low" value="${s.cash.low}" min="0" max="100" step="1"><span class="suffix">%</span></div></div>
          <div class="setrow"><div class="lab">上緣<small>高於此比重提示現金偏高</small></div><div class="inrow"><input type="number" id="cash-high" value="${s.cash.high}" min="0" max="100" step="1"><span class="suffix">%</span></div></div>
        </div>

        <div class="setcard">
          <h3>單一分類上限</h3>
          <div class="desc">單一分類層級佔組合比重的上限，超過時偏離視覺化亮燈。</div>
          <div class="setrow"><div class="lab">分類上限</div><div class="inrow"><input type="number" id="cat-cap" value="${s.categoryCap}" min="0" max="100" step="1"><span class="suffix">%</span></div></div>
        </div>

        <div class="setcard">
          <h3>豁免標的清單</h3>
          <div class="desc">列在豁免清單的標的，即使超過集中度觸發點，偏離視覺化也只顯示「豁免」標籤而非警示（例如核心長期持股）。</div>
          <div class="inrow"><input type="text" id="ex-input" placeholder="輸入代號後按新增，例：NVDA" style="font-family:var(--mono);text-transform:uppercase"><button class="btn-ghost" id="ex-add">新增</button></div>
          <div class="tagrow" id="ex-list">${exRows || '<span style="color:var(--txt3);font-size:13px">尚無豁免標的</span>'}</div>
        </div>

        <div class="setcard">
          <h3>資產分類法</h3>
          <div class="desc">偏離視覺化的分類層級依此設定上色與分組。</div>
          <div class="seg-mode" style="margin-bottom:16px">
            <button id="mode-ai6" class="${s.classification.mode === 'ai6' ? 'on' : ''}">AI 產業鏈六層</button>
            <button id="mode-custom" class="${s.classification.mode === 'custom' ? 'on' : ''}">自訂分類</button>
          </div>
          ${s.classification.mode === 'ai6'
            ? `<div class="tagrow">${AI6_LAYERS.map(l => `<span class="tagchip">${escapeHtml(l)}</span>`).join('')}</div>`
            : `<div class="inrow"><input type="text" id="layer-input" placeholder="輸入分類名稱後按新增"><button class="btn-ghost" id="layer-add">新增</button></div>
               <div class="tagrow" id="layer-list" style="margin-top:12px">${customRows || '<span style="color:var(--txt3);font-size:13px">尚無自訂分類</span>'}</div>`}
        </div>

        <div class="savebar">
          <button class="btn-primary" id="save">儲存設定</button>
          <button class="btn-ghost" id="reset">回復預設值</button>
          <span class="savemsg" id="savemsg"></span>
        </div>
      </div>`;

    wire();
  }

  function collect() {
    const num = (sel, def) => { const v = parseFloat(view.querySelector(sel).value); return isNaN(v) ? def : v; };
    s.concentration.single = num('#conc-single', DEFAULT_SETTINGS.concentration.single);
    s.concentration.strong = num('#conc-strong', DEFAULT_SETTINGS.concentration.strong);
    s.cash.low = num('#cash-low', DEFAULT_SETTINGS.cash.low);
    s.cash.high = num('#cash-high', DEFAULT_SETTINGS.cash.high);
    s.categoryCap = num('#cat-cap', DEFAULT_SETTINGS.categoryCap);
  }

  function wire() {
    const q = sel => view.querySelector(sel);

    q('#ex-add').addEventListener('click', () => {
      const inp = q('#ex-input'); const t = inp.value.trim().toUpperCase();
      if (t && !s.exemptions.includes(t)) { collect(); s.exemptions.push(t); render(); }
    });
    q('#ex-input').addEventListener('keydown', e => { if (e.key === 'Enter') q('#ex-add').click(); });
    view.querySelectorAll('[data-rmex]').forEach(b =>
      b.addEventListener('click', () => { collect(); s.exemptions.splice(+b.dataset.rmex, 1); render(); }));

    q('#mode-ai6').addEventListener('click', () => { collect(); s.classification.mode = 'ai6'; render(); });
    q('#mode-custom').addEventListener('click', () => { collect(); s.classification.mode = 'custom'; render(); });

    if (s.classification.mode === 'custom') {
      q('#layer-add').addEventListener('click', () => {
        const inp = q('#layer-input'); const t = inp.value.trim();
        if (t && !s.classification.custom.includes(t)) { collect(); s.classification.custom.push(t); render(); }
      });
      q('#layer-input').addEventListener('keydown', e => { if (e.key === 'Enter') q('#layer-add').click(); });
      view.querySelectorAll('[data-rmlayer]').forEach(b =>
        b.addEventListener('click', () => { collect(); s.classification.custom.splice(+b.dataset.rmlayer, 1); render(); }));
    }

    q('#save').addEventListener('click', () => {
      collect(); saveSettings(s);
      const m = q('#savemsg'); m.textContent = '已儲存 ✓';
      setTimeout(() => { if (m) m.textContent = ''; }, 2500);
    });
    q('#reset').addEventListener('click', () => {
      resetSettings(); s = getSettings(); render();
      const m = q('#savemsg'); if (m) { m.textContent = '已回復預設值'; setTimeout(() => { if (m) m.textContent = ''; }, 2500); }
    });
  }

  render();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
