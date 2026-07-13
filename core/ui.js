/* ============================================================
   core/ui.js — 共用 UI 元件
   - showModal / confirmModal / alertModal：取代原生 confirm/alert
     的自訂對話框（多按鈕、危險動作樣式、Esc / 點背景取消）
     含 focus trap、aria-labelledby、關閉後 focus 回到觸發元素
   - toast：右下角輕量訊息，可帶一個動作按鈕（用於「復原」）
   - tipHTML：名詞提示（hover 與點擊/聚焦皆可觸發，觸控裝置可用）
   - previewBanner：示範資料預覽模式的頂端橫幅
   - flowCrumb：三頁工作流位置提示（診斷 → 計算 → 記錄）
   ============================================================ */

let modalSeq = 0;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* 通用對話框。buttons: [{label, kind:'primary'|'ghost'|'danger', value}]
   回傳 Promise，resolve 為被按下按鈕的 value；Esc 或點背景 resolve null。 */
export function showModal({ title = '', body = '', buttons = [] }) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const tid = 'mdl-t-' + (++modalSeq);
    const ov = document.createElement('div');
    ov.className = 'mdl-overlay';
    ov.innerHTML = `<div class="mdl-box" role="dialog" aria-modal="true"${title ? ` aria-labelledby="${tid}"` : ''}>
      ${title ? `<div class="mdl-title" id="${tid}">${title}</div>` : ''}
      <div class="mdl-body">${body}</div>
      <div class="mdl-btns">${buttons.map((b, i) => `<button type="button" class="mdl-btn ${b.kind || 'ghost'}" data-i="${i}">${b.label}</button>`).join('')}</div>
    </div>`;

    const done = v => {
      ov.remove();
      document.removeEventListener('keydown', onKey, true);
      // 關閉後把 focus 還給觸發元素，鍵盤使用者不會被丟回頁首
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        try { prevFocus.focus(); } catch (e) {}
      }
      resolve(v);
    };

    // focus trap：Tab 只在 modal 內循環，不會跑到背景頁面
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); return; }
      if (e.key !== 'Tab') return;
      const items = [...ov.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ov.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !ov.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);

    ov.addEventListener('click', e => { if (e.target === ov) done(null); });
    ov.querySelectorAll('.mdl-btn').forEach(btn => btn.addEventListener('click', () => done(buttons[+btn.dataset.i].value)));
    document.body.appendChild(ov);
    const first = ov.querySelector('.mdl-btn');
    if (first) first.focus();
  });
}

export function confirmModal(body, { title = '請確認', okLabel = '確定', cancelLabel = '取消', danger = false } = {}) {
  return showModal({
    title, body,
    buttons: [
      { label: okLabel, kind: danger ? 'danger' : 'primary', value: true },
      { label: cancelLabel, kind: 'ghost', value: false },
    ],
  }).then(v => v === true);
}

export function alertModal(body, { title = '' } = {}) {
  return showModal({ title, body, buttons: [{ label: '知道了', kind: 'primary', value: true }] });
}

/* ---------- toast：可帶「復原」動作的輕量訊息 ---------- */
let toastEl = null, toastTimer = null;

export function toast(msg, { actionLabel = '', onAction = null, ms = 6000 } = {}) {
  dismissToast();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<span class="toast-msg"></span>${actionLabel ? `<button type="button" class="toast-act">${actionLabel}</button>` : ''}<button type="button" class="toast-x" aria-label="關閉訊息">×</button>`;
  el.querySelector('.toast-msg').textContent = msg;
  if (actionLabel && onAction) {
    el.querySelector('.toast-act').addEventListener('click', () => { dismissToast(); onAction(); });
  }
  el.querySelector('.toast-x').addEventListener('click', dismissToast);
  document.body.appendChild(el);
  toastEl = el;
  toastTimer = setTimeout(dismissToast, ms);
}

export function dismissToast() {
  clearTimeout(toastTimer);
  if (toastEl) { toastEl.remove(); toastEl = null; }
}

/* ---------- 名詞提示（觸控可用） ----------
   原本只有 title 屬性，手機使用者永遠看不到解釋。改為 hover / 點擊 / 鍵盤聚焦
   皆可觸發的輕量 popover（樣式在 theme.css，內容取自 data-tip）。 */
export function tipHTML(label, text) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<button type="button" class="tip" data-tip="${esc(text)}" aria-label="${esc(label)}：${esc(text)}">${esc(label)}</button>`;
}

/* ---------- 示範資料預覽橫幅 ---------- */
/* 示範資料一律不寫入 store，只在畫面上預覽；離開時還原原本的資料。 */
export function previewBanner(text, onExit) {
  const bar = document.createElement('div');
  bar.className = 'preview-banner';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `<span class="pv-icon" aria-hidden="true">👁</span>
    <span class="pv-text"></span>
    <button type="button" class="pv-exit">離開示範</button>`;
  bar.querySelector('.pv-text').textContent = text;
  bar.querySelector('.pv-exit').addEventListener('click', onExit);
  return bar;
}

/* 工作流位置提示：組合偏離（診斷）→ 分批建倉（計算）→ 交易日誌（記錄） */
export function flowCrumb(current) {
  const steps = [
    { id: 'deviation', hash: '#/deviation', label: '① 組合偏離｜診斷' },
    { id: 'tranche', hash: '#/tranche', label: '② 分批建倉｜計算' },
    { id: 'journal', hash: '#/journal', label: '③ 交易日誌｜記錄' },
  ];
  return `<nav class="flowcrumb" aria-label="工作流"><span class="fc-t">工作流</span>` + steps.map(s =>
    s.id === current ? `<span class="fc-on" aria-current="step">${s.label}</span>` : `<a href="${s.hash}">${s.label}</a>`
  ).join('<span class="fc-sep" aria-hidden="true">→</span>') + `</nav>`;
}

/* 把容器內所有 .savemsg 標成 aria-live，螢幕報讀器才聽得到「已儲存 ✓」 */
export function markLiveRegions(root) {
  root.querySelectorAll('.savemsg').forEach(el => {
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
  });
}
