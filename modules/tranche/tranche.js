/* modules/tranche/tranche.js — 模組1：分批建倉計算器（佔位，模組1 階段實作） */
export const id = 'tranche';
export const title = '分批建倉';

export function mount(view) {
  view.innerHTML = `
    <div class="placeholder">
      <div class="tag">模組 1</div>
      <h2>分批建倉計算器</h2>
      <p>輸入可用現金、標的現價、目標配置、分批數與各批比重，算出每批股數（不買零股）、各批執行後的累計持股與剩餘現金，並對照你設定的現金舒適區間。建倉計畫可存於瀏覽器、標記已執行第幾批。</p>
      <div class="soon">即將推出 · 下一個實作模組</div>
    </div>`;
}
export function unmount() {}
