/* ============================================================
   modules/settings/settings.js — 設定頁
   個人化規則參數的可配置 UI，全部存 localStorage。
   被建倉計算器與偏離視覺化共用。

   P0-3：改為自動儲存。原本豁免標的、自訂分類、分類法切換都只改記憶體中的 s，
        畫面看起來已生效、切頁後全部丟失，與全站其他頁「邊改邊存」的心智模型衝突。
        現在每次變更（含數字欄位 debounce）通過驗證即寫入；「儲存設定」鈕保留為
        顯性回饋，不再是唯一的存檔途徑。
   P0-3：「回復預設值」是唯一立即持久化的破壞性動作，補上確認對話框。
   P1-1：交叉驗證（現金下緣 < 上緣、一般觸發點 <= 強檢視觸發點），
        矛盾組合擋下並顯示原因，不靜默寫入。
   ============================================================ */
import { getSettings, saveSettings, resetSettings, validateSettings, DEFAULT_SETTINGS, AI6_LAYERS } from '../../core/settings.js';
import { confirmModal, markLiveRegions } from '../../core/ui.js';

export const id = 'settings';
export const title = '設定';

let _cleanup = [];
let saveTimer = null;

export function unmount() {
  clearTimeout(saveTimer);
  _cleanup.forEach(fn => { try { fn(); } catch (e) {} });
  _cleanup = [];
}

export function mount(view) {
  let s = getSettings();

  function render() {
    const customRows = s.classification.custom.map((name, i) =>
      `<span class="tagchip">${escapeHtml(name)}<button type="button" data-rmlayer="${i}" title="移除" aria-label="移除分類 ${escapeHtml(name)}">×</button></span>`
    ).join('');
    const exRows = s.exemptions.map((t, i) =>
      `<span class="tagchip">${escapeHtml(t)}<button type="button" data-rmex="${i}" title="移除" aria-label="移除豁免標的 ${escapeHtml(t)}">×</button></span>`
    ).join('');

    view.innerHTML = `
      <div class="setwrap">
        <header><div class="brand"><h1>設定</h1><p>這些規則參數會被「分批建倉」與「組合偏離」共用。所有設定只存在你的瀏覽器（localStorage），不會上傳。<b style="color:var(--txt)">改了就自動存</b>，不需要按儲存也不會丟失。</p></div></header>

        <div class="setcard">
          <h3>集中度觸發點</h3>
          <div class="desc">單一標的佔組合比重超過觸發點時，偏離視覺化會亮燈提示走三層判讀（不是執行授權）。一般觸發點需小於或等於強檢視觸發點。</div>
          <div class="setrow"><div class="lab">一般觸發點<small>達此比重提示重新檢視</small></div><div class="inrow"><input type="number" id="conc-single" value="${s.concentration.single}" min="1" max="100" step="1"><span class="suffix">%</span></div></div>
          <div class="setrow"><div class="lab">強檢視觸發點<small>達此比重強烈提示走三層判讀</small></div><div class="inrow"><input type="number" id="conc-strong" value="${s.concentration.strong}" min="1" max="100" step="1"><span class="suffix">%</span></div></div>
        </div>

        <div class="setcard">
          <h3>現金舒適區間</h3>
          <div class="desc">現金佔組合比重的舒適範圍。建倉計算器會用下緣判斷剩餘現金是否仍在區間內；偏離視覺化會在低於下緣或高於上緣時亮燈。下緣需小於上緣。</div>
          <div class="setrow"><div class="lab">下緣<small>低於此比重提示現金偏低</small></div><div class="inrow"><input type="number" id="cash-low" value="${s.cash.low}" min="0" max="100" step="1"><span class="suffix">%</span></div></div>
          <div class="setrow"><div class="lab">上緣<small>高於此比重提示現金偏高</small></div><div class="inrow"><input type="number" id="cash-high" value="${s.cash.high}" min="0" max="100" step="1"><span class="suffix">%</span></div></div>
        </div>

        <div class="setcard">
          <h3>單一分類上限</h3>
          <div class="desc">單一分類層級佔組合比重的上限，超過時偏離視覺化亮燈。</div>
          <div class="setrow"><div class="lab">分類上限</div><div class="inrow"><input type="number" id="cat-cap" value="${s.categoryCap}" min="1" max="100" step="1"><span class="suffix">%</span></div></div>
        </div>

        <div class="setcard">
          <h3>持股快照過期提醒</h3>
          <div class="desc">「組合偏離」的現值是你手動輸入的快照。超過這個天數沒更新，偏離診斷與 FIRE「帶入持股」會亮警示，提醒你數字可能已經失真。</div>
          <div class="setrow"><div class="lab">過期天數<small>超過此天數未更新即提示</small></div><div class="inrow"><input type="number" id="stale-days" value="${s.staleDays}" min="1" max="365" step="1"><span class="suffix">天</span></div></div>
        </div>

        <div class="setcard">
          <h3>豁免標的清單</h3>
          <div class="desc">列在豁免清單的標的，即使超過集中度觸發點，偏離視覺化也只顯示「豁免」標籤而非警示（例如核心長期持股）。</div>
          <div class="inrow"><input type="text" id="ex-input" placeholder="輸入代號後按新增，例：NVDA" style="font-family:var(--mono);text-transform:uppercase"><button class="btn-ghost" id="ex-add" type="button">新增</button></div>
          <div class="tagrow" id="ex-list">${exRows || '<span style="color:var(--txt2);font-size:13px">尚無豁免標的</span>'}</div>
        </div>

        <div class="setcard">
          <h3>資產分類法</h3>
          <div class="desc">偏離視覺化的分類層級依此設定上色與分組。</div>
          <div class="seg-mode" style="margin-bottom:16px" role="group" aria-label="資產分類法">
            <button type="button" id="mode-ai6" class="${s.classification.mode === 'ai6' ? 'on' : ''}" aria-pressed="${s.classification.mode === 'ai6'}">AI 產業鏈六層</button>
            <button type="button" id="mode-custom" class="${s.classification.mode === 'custom' ? 'on' : ''}" aria-pressed="${s.classification.mode === 'custom'}">自訂分類</button>
          </div>
          ${s.classification.mode === 'ai6'
            ? `<div class="tagrow">${AI6_LAYERS.map(l => `<span class="tagchip" style="padding:6px 13px">${escapeHtml(l)}</span>`).join('')}</div>`
            : `<div class="inrow"><input type="text" id="layer-input" placeholder="輸入分類名稱後按新增"><button class="btn-ghost" id="layer-add" type="button">新增</button></div>
               <div class="tagrow" id="layer-list" style="margin-top:12px">${customRows || '<span style="color:var(--txt2);font-size:13px">尚無自訂分類</span>'}</div>`}
        </div>

        <div class="savebar">
          <button class="btn-primary" id="save" type="button">儲存設定</button>
          <button class="btn-ghost" id="reset" type="button">回復預設值</button>
          <span class="savemsg" id="savemsg"></span>
        </div>
        <div class="errmsg" id="seterr"></div>
        <div class="chartnote" style="margin-top:12px">設定會在你每次修改後自動儲存。「儲存設定」按鈕只是讓你確認一下有存到；矛盾的數值組合（例如現金下緣大於上緣）會被擋下並在上方說明原因。</div>
      </div>`;

    wire();
    markLiveRegions(view);
  }

  /* 從 DOM 收集數值欄位到記憶體中的 s（不含清單類，那些直接改陣列） */
  function collect() {
    const num = (sel, def) => {
      const el = view.querySelector(sel);
      if (!el) return def;
      const v = parseFloat(el.value);
      return Number.isFinite(v) ? v : def;
    };
    s.concentration.single = num('#conc-single', DEFAULT_SETTINGS.concentration.single);
    s.concentration.strong = num('#conc-strong', DEFAULT_SETTINGS.concentration.strong);
    s.cash.low = num('#cash-low', DEFAULT_SETTINGS.cash.low);
    s.cash.high = num('#cash-high', DEFAULT_SETTINGS.cash.high);
    s.categoryCap = num('#cat-cap', DEFAULT_SETTINGS.categoryCap);
    s.staleDays = Math.round(num('#stale-days', DEFAULT_SETTINGS.staleDays));
  }

  function showErrors(errors) {
    const box = view.querySelector('#seterr');
    if (!box) return;
    box.innerHTML = errors.length
      ? `<b>設定未儲存：</b><ul>${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
      : '';
  }

  function flash(msg) {
    const m = view.querySelector('#savemsg');
    if (!m) return;
    m.textContent = msg;
    clearTimeout(m._t);
    m._t = setTimeout(() => { if (m) m.textContent = ''; }, 2500);
  }

  /* P0-3：自動儲存。通過驗證才寫入，未通過則顯示原因（記憶體中的值仍保留，方便繼續改） */
  function persist({ quiet = false } = {}) {
    collect();
    const errors = validateSettings(s);
    if (errors.length) { showErrors(errors); flash(''); return false; }
    showErrors([]);
    saveSettings(s);
    if (!quiet) flash('已儲存 ✓');
    return true;
  }

  /* 數字欄位邊打字邊存會太吵，用 debounce；清單類（新增/刪除 chip）立即存 */
  function persistDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist({ quiet: true }), 400);
  }

  function wire() {
    const q = sel => view.querySelector(sel);

    // 數字欄位：邊改邊存（含交叉驗證）
    ['#conc-single', '#conc-strong', '#cash-low', '#cash-high', '#cat-cap', '#stale-days'].forEach(sel => {
      const el = q(sel);
      if (el) {
        el.addEventListener('input', persistDebounced);
        el.addEventListener('blur', () => persist({ quiet: true }));
      }
    });

    /* 清單類變更：先收集數字欄位 → 改陣列 → 重繪（重繪會重建 #seterr）→ 再寫入並顯示錯誤 */
    const mutate = (fn, msg) => {
      collect();
      fn();
      render();
      if (persist({ quiet: true })) flash(msg); // 驗證未過時由 persist 顯示原因，不謊報「已儲存」
    };

    q('#ex-add').addEventListener('click', () => {
      const t = q('#ex-input').value.trim().toUpperCase();
      if (!t) return;
      if (s.exemptions.includes(t)) { flash('已在豁免清單中'); return; }
      mutate(() => s.exemptions.push(t), '已新增豁免標的 ✓');
    });
    q('#ex-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); q('#ex-add').click(); } });
    view.querySelectorAll('[data-rmex]').forEach(b =>
      b.addEventListener('click', () => mutate(() => s.exemptions.splice(+b.dataset.rmex, 1), '已移除 ✓')));

    q('#mode-ai6').addEventListener('click', () => mutate(() => { s.classification.mode = 'ai6'; }, '已切換分類法 ✓'));
    q('#mode-custom').addEventListener('click', () => mutate(() => { s.classification.mode = 'custom'; }, '已切換分類法 ✓'));

    if (s.classification.mode === 'custom') {
      q('#layer-add').addEventListener('click', () => {
        const t = q('#layer-input').value.trim();
        if (!t) return;
        if (s.classification.custom.includes(t)) { flash('此分類已存在'); return; }
        mutate(() => s.classification.custom.push(t), '已新增分類 ✓');
      });
      q('#layer-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); q('#layer-add').click(); } });
      view.querySelectorAll('[data-rmlayer]').forEach(b =>
        b.addEventListener('click', () => mutate(() => s.classification.custom.splice(+b.dataset.rmlayer, 1), '已移除 ✓')));
    }

    // 保留「儲存設定」作為顯性回饋（自動儲存已經生效，這只是讓人安心）
    q('#save').addEventListener('click', () => { if (persist()) flash('已儲存 ✓'); });

    // P0-3：唯一的破壞性動作，補上確認
    q('#reset').addEventListener('click', async () => {
      const ok = await confirmModal(
        '這會把集中度觸發點、現金舒適區間、分類上限、過期天數、豁免標的清單與自訂分類全部還原為預設值，你的自訂內容會消失。',
        { title: '回復預設值', okLabel: '回復預設值', danger: true }
      );
      if (!ok) return;
      resetSettings();
      s = getSettings();
      render();
      showErrors([]);
      flash('已回復預設值');
    });
  }

  render();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
