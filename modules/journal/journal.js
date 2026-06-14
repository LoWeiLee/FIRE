/* modules/journal/journal.js — 模組3：交易日誌統計（佔位，模組3 階段實作） */
export const id = 'journal';
export const title = '交易日誌';

export function mount(view) {
  view.innerHTML = `
    <div class="placeholder">
      <div class="tag">模組 3</div>
      <h2>交易日誌統計</h2>
      <p>貼上交易 CSV（日期、代號、買/賣、股數、價格、賣出類型、決策評分、三層判讀完整度），產出季度／年度切換的統計面板：交易筆數與金額、買賣分布、賣出類型分布、決策評分分布、三層判讀完整度趨勢，以及單一標的 30 天內重複交易標記。資料存於瀏覽器、可持續累加與匯出。</p>
      <div class="soon">即將推出</div>
    </div>`;
}
export function unmount() {}
