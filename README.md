# 投資工具箱（Investment Toolbox）

一組純靜態、純客戶端的個人投資輔助工具，部署在 GitHub Pages。
線上版：<https://qqamp.github.io/FIRE/>

由原本的「FIRE 退休計算機」擴充而成，現在 FIRE 計算機是其中一個模組，另有三個新工具。所有工具只做計算與診斷呈現，**不提供任何買賣建議**。

## 四個模組

| 模組 | 路徑 | 做什麼 |
|---|---|---|
| FIRE 試算 | `#/fire` | 用 1871 年以來真實市場歷史與蒙地卡羅，估算幾歲能退休、成功率、離目標多遠 |
| 分批建倉 | `#/tranche` | 把目標配置拆成 1–4 批，算每批股數（不買零股）、累計持股與剩餘現金，對照現金舒適區間 |
| 組合偏離 | `#/deviation` | 貼上持股，產出分類 treemap、實際 vs 目標偏離橫條、集中度/現金/分類觸發點燈號 |
| 交易日誌 | `#/journal` | 貼上交易，季/年統計：買賣分布、賣出類型、決策評分、三層判讀完整度趨勢、30 天重複交易標記 |

各模組詳細使用方式見 [`docs/使用說明.md`](docs/使用說明.md)。

## 設計原則

- **個人資料零落地**：repo 內沒有任何真實持股、金額、姓名。所有使用者資料都在瀏覽器端輸入，持久化一律用 `localStorage`，並提供 JSON 匯出／匯入／一鍵清除（右上角工具列）。
- **純靜態、純客戶端**：沒有後端、沒有建置步驟。直接是 GitHub Pages 站台，push 即部署。
- **參數化個人規則**：集中度觸發點、現金舒適區間、豁免標的清單、資產分類法、分類上限全部在「設定」頁可配置，存 localStorage。
- **正體中文介面**，金融術語保留英文（P/E、RSI、MACD 等）。

## 本機預覽

ES modules 不能用 `file://` 直接開，需要起一個本機伺服器。在專案根目錄執行：

```
python -m http.server 8000
```

然後瀏覽器開 <http://localhost:8000/>。

## 部署到 GitHub Pages

本專案就是 Pages 站台本身，無需建置。把檔案 commit 後 push 到 Pages 分支即可：

```
git add -A
git commit -m "更新"
git push origin HEAD:main
```

等一兩分鐘，<https://qqamp.github.io/FIRE/> 就會更新。根目錄無 hash 時預設顯示 FIRE，舊分享連結不受影響。

## 目錄結構

```
index.html            shell：導航 + 路由掛載點
assets/
  theme.css           共用主題（深色金色設計系統）與各模組樣式
  shell.js            hash 路由、模組生命週期、全站匯出/匯入/清除
core/
  store.js            localStorage 封裝、持股共享狀態、JSON 備份
  settings.js         個人化規則參數與預設值
modules/
  fire/               FIRE 試算
  tranche/            分批建倉計算器
  deviation/          組合偏離視覺化
  journal/            交易日誌統計
  settings/           設定頁
docs/
  使用說明.md          四個模組的使用說明
```

## 資料與隱私

所有資料只存在你自己的瀏覽器（localStorage），不會上傳到任何伺服器。換瀏覽器或裝置時，用右上角「匯出」備份成 JSON，再在新裝置「匯入」即可。「清除」會刪掉本工具在此瀏覽器的所有資料（建議先匯出備份）。

## 免責聲明

本工具僅供教育與研究用途，**不構成投資或財務建議**。所有回測與統計皆為情境分析，並非對未來的預測。FIRE 模組的歷史資料源自 Robert Shiller 公開資料集，受 FI Calc 啟發獨立打造，與其無隸屬關係。
