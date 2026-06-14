/* modules/deviation/deviation.js — 模組2：組合偏離視覺化（佔位，模組2 階段實作） */
export const id = 'deviation';
export const title = '組合偏離';

export function mount(view) {
  view.innerHTML = `
    <div class="placeholder">
      <div class="tag">模組 2</div>
      <h2>組合偏離視覺化</h2>
      <p>貼上持股 CSV（代號、現值、實際佔比、目標佔比、分類層級），產出分類層級 treemap、每檔「實際 vs 目標」偏離橫條圖（偏離 &gt;5% 高亮），以及觸發點燈號列：集中度、現金區間、分類上限。只做診斷呈現，不產出買賣建議。</p>
      <div class="soon">即將推出</div>
    </div>`;
}
export function unmount() {}
