# ✨ Gemini 資料夾精靈 (my-gemini-bookmark)

> 📂 把 Gemini 對話，變成你自己的知識庫

> 為了解決「Gemini 對話難以管理」而誕生的高隱私書籤工具

---

## 🧠 開發初衷

在長期使用 [Gemini](https://gemini.google.com) 的過程中，我發現一個很實際的問題：

> ❗ 對話越來越多，但幾乎無法有效整理與回溯

常見痛點包括：

* 找不到之前問過的重要對話
* 無法分類（專案 / 技術 / 筆記 / 靈感）
* 無法建立自己的知識結構
* 每次都要重新搜尋或重問

因此，我開發了這個工具，目標很單純：

> ✅ **讓 Gemini 對話可以像「檔案總管」一樣被管理**

---

## 🎯 設計理念

這個專案不是只是做「書籤」，而是圍繞三個核心理念：

* ☁️ **跨裝置同步**：深度整合 Chrome 原生書籤系統，只要登入 Google 帳號，所有分層目錄與書籤自動跨設備同步。
* 🧩 **結構化管理**：支援多層資料夾，建立自己的知識樹。
* ⚡ **低干擾整合**：不破壞 Gemini UI，不依賴內部 DOM。

---

[![Manifest V3](https://imgshields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 功能特色

* ☁️ **原生書籤同步 (New)**：背後完全基於 Chrome `bookmarks` API，享有 Google 帳號自動同步的穩定性。
* 📁 **多層資料夾**：支援無限層子資料夾巢狀結構。
* 🎯 **一鍵閃電書籤 (New)**：如同電腦檔案管理員，點擊即可選中資料夾。選中後，按下「書籤」按鈕直接存入該目錄，無需任何多餘彈窗對話框！
* 🖱️ **雙向拖放排序**：
  * 資料夾與書籤皆可上下自由拖放重排。
  * 拖曳至其他資料夾可變成子目錄。
  * **拖曳至頂部「同步狀態列」**即可輕鬆將項目移回最外層根目錄。
* 🤖 **智慧對話標題擷取**：多層次 Fallback 自動讀取 Gemini 最精確的對話標題。
* 🔍 **即時搜尋**：快速過濾書籤標題與資料夾名稱。
* ↔️ **左右切換**：面板可任意切換到左側或右側。
* 🛡️ **Shadow DOM 隔離**：不注入 Gemini 頁面 DOM，避免版本耦合。

---

## 安裝方式（開發者模式）

1. 下載或 Clone 此 Repository

   ```bash
   git clone https://github.com/bybrm/my-gemini-bookmark.git
   ```

2. 開啟 Chrome，前往 `chrome://extensions/`

3. 開啟右上角「**開發人員模式**」

4. 點擊「**載入未封裝擴充功能**」，選擇 `my-gemini-bookmark` 資料夾

5. 前往 [gemini.google.com](https://gemini.google.com)，點擊工具列的 ✨ 圖示即可使用

---

## 使用說明

### 📌 初次設定流程
第一次開啟面板時，系統會要求您「**選擇同步資料夾**」。
您可以選擇 Chrome 書籤中現有的資料夾作為知識庫的根目錄，或者直接在底部輸入名稱建立一個新的。選定後，所有操作都會寫入這個資料夾內。

### ⌨️ 操作指南

| 操作 | 說明 |
| --- | --- |
| **點擊 ✨ 工具列圖示** | 開啟 / 關閉浮動面板 |
| **點擊資料夾名稱** | 將其設為「**目前選中**」狀態（高亮顯示），並展開其內容。 |
| **點擊頂部狀態列** | 取消選中子資料夾，將目標設回「**根目錄**」。 |
| **書籤此對話 按鈕** | 一鍵將當前對話存入「**目前選中**」的資料夾。若未選中任何項目則預設存入根目錄。 |
| **資料夾的 ＋ 按鈕** | （滑鼠懸停可見）不管選中狀態為何，強制書籤到該資料夾。 |
| **拖曳項目** | 上/下 30%：重新排序<br>中間 40%：移入成子資料夾<br>拖至頂部狀態列：移出至根目錄。 |
| **右上角 ⚙️ 按鈕** | 重新選擇或更換 Chrome 同步根資料夾。 |

---

## 技術架構

```
my-gemini-bookmark/
├── manifest.json    # Manifest V3
├── background.js    # Service Worker (處理 bookmarks API 權限與事件廣播)
├── content.js       # Shadow DOM 面板 + Proxy 代理請求機制
├── panel.css        # 面板樣式（注入 Shadow Root）
└── icons/           # 擴充功能圖示
```

**核心技術點：**
* **Chrome Bookmarks API Bridge**：由於 MV3 Content Script 無法直接操作書籤 API，本專案實作了 Proxy 代理機制，由 `content.js` 發送動作，交由 `background.js` 執行並同時廣播事件，保持多個分頁狀態即時同步。
* Chrome Extension Manifest V3
* Shadow DOM 樣式隔離與事件委派 (Event Delegation)

---

## 權限說明

| 權限                                    | 用途             |
| ------------------------------------- | -------------- |
| `bookmarks`                           | **核心權限**：讀取與寫入 Chrome 書籤，以達到雲端同步。 |
| `storage`                             | 儲存面板位置、偏好設定與選定的根目錄 ID。    |
| `tabs`                                | 讀取當前分頁 URL 供背景腳本廣播更新。     |
| `activeTab`                           | 存取當前 Gemini 分頁以抓取標題。 |
| `host_permissions: gemini.google.com` | 僅允許在 Gemini 網域中啟動 Content Script。 |

---

## License

MIT © [bybrm](https://github.com/bybrm)
