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
import { downloadBackup, importFromFile, clearAll } from '../core/store.js';

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
  document.getElementById('btn-export').addEventListener('click', downloadBackup);

  const fileInput = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const merge = confirm('匯入資料：\n\n按「確定」＝合併（保留現有資料，同名覆蓋）\n按「取消」＝取代（先清空現有資料再匯入）');
    try {
      await importFromFile(file, { merge });
      alert('匯入完成。');
      renderRoute();
    } catch (e) {
      alert('匯入失敗：' + (e && e.message || e));
    }
    fileInput.value = '';
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('確定要清除本工具在這個瀏覽器儲存的所有資料嗎？\n\n此動作無法復原。建議先「匯出」備份。')) {
      clearAll();
      alert('已清除所有本機資料。');
      renderRoute();
    }
  });
}

window.addEventListener('hashchange', renderRoute);
wireTools();
renderRoute();
