/* ============================================================
   core/ui.js — 共用 UI 元件
   - showModal / confirmModal / alertModal：取代原生 confirm/alert
     的自訂對話框（支援多按鈕、危險動作樣式、Esc / 點背景取消）
   - flowCrumb：三頁工作流位置提示（診斷 → 計算 → 記錄）
   ============================================================ */

/* 通用對話框。buttons: [{label, kind:'primary'|'ghost'|'danger', value}]
   回傳 Promise，resolve 為被按下按鈕的 value；Esc 或點背景 resolve null。 */
export function showModal({ title = '', body = '', buttons = [] }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'mdl-overlay';
    ov.innerHTML = `<div class="mdl-box" role="dialog" aria-modal="true">
      ${title ? `<div class="mdl-title">${title}</div>` : ''}
      <div class="mdl-body">${body}</div>
      <div class="mdl-btns">${buttons.map((b, i) => `<button type="button" class="mdl-btn ${b.kind || 'ghost'}" data-i="${i}">${b.label}</button>`).join('')}</div>
    </div>`;
    const done = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
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

/* 工作流位置提示：組合偏離（診斷）→ 分批建倉（計算）→ 交易日誌（記錄） */
export function flowCrumb(current) {
  const steps = [
    { id: 'deviation', hash: '#/deviation', label: '① 組合偏離｜診斷' },
    { id: 'tranche', hash: '#/tranche', label: '② 分批建倉｜計算' },
    { id: 'journal', hash: '#/journal', label: '③ 交易日誌｜記錄' },
  ];
  return `<div class="flowcrumb"><span class="fc-t">工作流</span>` + steps.map(s =>
    s.id === current ? `<span class="fc-on">${s.label}</span>` : `<a href="${s.hash}">${s.label}</a>`
  ).join('<span class="fc-sep">→</span>') + `</div>`;
}
