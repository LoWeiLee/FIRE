/* ============================================================
   assets/shell.js — 共用 shell：導航、hash 路由、生命週期、全站匯出/匯入/清除
   - 根目錄無 hash 時預設顯示 FIRE（既有分享連結 qqamp.github.io/FIRE/ 不破壞）
   - 每次切換路由：unmount 舊模組 → 清空 #view → mount 新模組
   ============================================================ */
import * as fire from '../modules/fire/fire.js';
import * as tranche from '../modules/tranche/tranche.js';
import * as deviation from '../modules/deviation/deviation.js';
import * as journal from '../modules/journal/journal.js';
import * as settings from '../modules/settings/settings.js';
import { downloadBackup, importFromFile, clearAll, backupReminder, snoozeBackup } from '../core/store.js';
import { showModal, alertModal } from '../core/ui.js';

const ROUTES = [
  { hash: '#/fire', mod: fire, label: 'FIRE 試算' },
  { hash: '#/tranche', mod: tranche, label: '分批建倉' },
  { hash: '#/deviation', mod: deviation, label: '組合偏離' },
  { hash: '#/journal', mod: journal, label: '交易日誌' },
  { hash: '#/settings', mod: settings, label: '設定' },
];
const DEFAULT = ROUTES[0];

let currentMod = null;

function routeFor() {
  const h = location.hash;
  return ROUTES.find(r => r.hash === h) || DEFAULT;
}

function renderNav(active) {
  const nav = document.getElementById('navlinks');
  nav.innerHTML = ROUTES.map(r =>
    `<a href="${r.hash}" class="${r === active ? 'on' : ''}">${r.label}</a>`
  ).join('');
}

function renderRoute() {
  const route = routeFor();
  if (currentMod && typeof currentMod.unmount === 'function') {
    try { currentMod.unmount(); } catch (e) { console.error(e); }
  }
  renderNav(route);
  const view = document.getElementById('view');
  view.innerHTML = '';
  window.scrollTo(0, 0);
  try {
    route.mod.mount(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="placeholder"><div class="tag">載入錯誤</div><h2>${route.label}</h2><p>${String(e && e.message || e)}</p></div>`;
  }
  currentMod = route.mod;
  document.title = route.label + '｜投資工具箱';
}

function wireTools() {
  document.getElementById('btn-export').addEventListener('click', () => { downloadBackup(); renderBackupBanner(); });

  const fileInput = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const choice = await showModal({
      title: '匯入資料',
      body: '要如何處理瀏覽器中的現有資料？',
      buttons: [
        { label: '合併（保留現有，同名覆蓋）', kind: 'primary', value: 'merge' },
        { label: '取代（先清空再匯入）', kind: 'danger', value: 'replace' },
        { label: '取消', kind: 'ghost', value: null },
      ],
    });
    if (!choice) { fileInput.value = ''; return; }
    try {
      await importFromFile(file, { merge: choice === 'merge' });
      await alertModal('匯入完成。');
      renderRoute();
      renderBackupBanner();
    } catch (e) {
      await alertModal('匯入失敗：' + (e && e.message || e), { title: '發生錯誤' });
    }
    fileInput.value = '';
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    const choice = await showModal({
      title: '清除所有本機資料',
      body: '將刪除此瀏覽器中儲存的全部工具資料（持股、建倉計畫、交易日誌、設定、FIRE 輸入與方案）。此動作無法復原。',
      buttons: [
        { label: '先匯出備份再清除', kind: 'primary', value: 'backup' },
        { label: '直接清除', kind: 'danger', value: 'clear' },
        { label: '取消', kind: 'ghost', value: null },
      ],
    });
    if (!choice) return;
    if (choice === 'backup') downloadBackup();
    clearAll();
    renderRoute();
    renderBackupBanner();
  });
}

/* ---------- 備份提醒橫幅 ---------- */
function renderBackupBanner() {
  const existing = document.getElementById('backup-banner');
  if (existing) existing.remove();
  const st = backupReminder();
  if (!st) return;
  const msg = st.never
    ? '你還沒有備份過資料。'
    : `你已經 ${st.days} 天沒有備份資料了。`;
  const bar = document.createElement('div');
  bar.id = 'backup-banner';
  bar.className = 'backup-banner';
  bar.innerHTML = `<span class="bb-icon">⚠</span>
    <span class="bb-text">${msg}資料只存在這個瀏覽器，清快取或換裝置就會消失，建議定期匯出備份。</span>
    <span class="bb-acts">
      <button class="bb-primary" id="bb-backup" type="button">立即備份</button>
      <button class="bb-ghost" id="bb-snooze" type="button">7 天後再說</button>
    </span>`;
  const nav = document.querySelector('.topnav');
  nav.insertAdjacentElement('afterend', bar);
  bar.querySelector('#bb-backup').addEventListener('click', () => { downloadBackup(); renderBackupBanner(); });
  bar.querySelector('#bb-snooze').addEventListener('click', () => { snoozeBackup(7); renderBackupBanner(); });
}

window.addEventListener('hashchange', renderRoute);
wireTools();
renderRoute();
renderBackupBanner();
