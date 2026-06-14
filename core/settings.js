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
  };
}

export function saveSettings(s) { set(SETTINGS_KEY, s); }

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
