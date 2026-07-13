/* ============================================================
   core/settings.js — 個人化規則參數（全部可在設定頁配置、存 localStorage）
   - 集中度觸發點（預設 15% / 20%）
   - 現金舒適區間（預設 10% – 25%）
   - 豁免標的清單
   - 資產分類法：'ai6'（AI 產業鏈六層）或 'custom'（自訂）
   - 單一分類上限
   這些參數被建倉計算器（現金舒適區間下緣）與偏離視覺化（觸發點燈號）共用。
   ============================================================ */

import { get, set } from './store.js';

export const SETTINGS_KEY = 'settings';

export const AI6_LAYERS = [
  '半導體 / 算力',
  '設備 / 製造',
  '雲端 / 基礎建設',
  '模型 / 平台',
  '應用 / 軟體',
  '終端 / 週邊',
];

export const DEFAULT_SETTINGS = {
  concentration: { single: 15, strong: 20 }, // 集中度觸發點（單一標的佔組合 %）
  cash: { low: 10, high: 25 },               // 現金舒適區間（%）
  exemptions: [],                            // 豁免標的代號（大寫）
  classification: { mode: 'ai6', custom: [...AI6_LAYERS] }, // 分類法
  categoryCap: 30,                           // 單一分類上限（%）
  staleDays: 7,                              // 持股現值快照幾天未更新即提示過期
};

export function getSettings() {
  const saved = get(SETTINGS_KEY, {});
  // 深層合併，確保新欄位有預設
  return {
    concentration: { ...DEFAULT_SETTINGS.concentration, ...(saved.concentration || {}) },
    cash: { ...DEFAULT_SETTINGS.cash, ...(saved.cash || {}) },
    exemptions: Array.isArray(saved.exemptions) ? saved.exemptions : [...DEFAULT_SETTINGS.exemptions],
    classification: {
      mode: (saved.classification && saved.classification.mode) || DEFAULT_SETTINGS.classification.mode,
      custom: (saved.classification && Array.isArray(saved.classification.custom) && saved.classification.custom.length)
        ? saved.classification.custom
        : [...DEFAULT_SETTINGS.classification.custom],
    },
    categoryCap: typeof saved.categoryCap === 'number' ? saved.categoryCap : DEFAULT_SETTINGS.categoryCap,
    staleDays: typeof saved.staleDays === 'number' ? saved.staleDays : DEFAULT_SETTINGS.staleDays,
  };
}

/* 交叉驗證：矛盾的門檻組合會讓下游燈號靜默產生怪異結果，因此在寫入前擋下。
   回傳錯誤訊息陣列，空陣列代表通過。 */
export function validateSettings(s) {
  const errs = [];
  const fin = v => Number.isFinite(Number(v));
  const c = s.concentration || {}, cash = s.cash || {};
  if (!fin(c.single) || !fin(c.strong)) errs.push('集中度觸發點需為數字。');
  else if (Number(c.single) > Number(c.strong)) {
    errs.push(`一般觸發點（${c.single}%）不可高於強檢視觸發點（${c.strong}%），否則燈號會恆亮強檢視。`);
  }
  if (!fin(cash.low) || !fin(cash.high)) errs.push('現金舒適區間需為數字。');
  else if (Number(cash.low) >= Number(cash.high)) {
    errs.push(`現金下緣（${cash.low}%）需小於上緣（${cash.high}%），否則現金永遠不會落在區間內。`);
  }
  if (!fin(s.categoryCap) || Number(s.categoryCap) <= 0) errs.push('單一分類上限需為大於 0 的數字。');
  if (!fin(s.staleDays) || Number(s.staleDays) < 1) errs.push('持股快照過期天數需為 1 以上的整數。');
  return errs;
}

/* 只在通過驗證時寫入。回傳 {ok, errors}。 */
export function saveSettings(s) {
  const errors = validateSettings(s);
  if (errors.length) return { ok: false, errors };
  set(SETTINGS_KEY, s);
  return { ok: true, errors: [] };
}

export function resetSettings() { set(SETTINGS_KEY, DEFAULT_SETTINGS); }

/* 目前生效的分類層級清單（依模式回傳） */
export function activeLayers() {
  const s = getSettings();
  return s.classification.mode === 'ai6' ? [...AI6_LAYERS] : s.classification.custom;
}

/* 判斷某代號是否在豁免清單（大小寫不敏感） */
export function isExempt(ticker) {
  const s = getSettings();
  return s.exemptions.map(t => String(t).toUpperCase()).includes(String(ticker).toUpperCase());
}
