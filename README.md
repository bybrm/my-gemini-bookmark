# ✨ Gemini 資料夾精靈 (my-gemini-bookmark)

> 專屬於 [Gemini](https://gemini.google.com) 的高隱私對話書籤與資料夾管理 Chrome 擴充功能

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 功能特色

- 📁 **多層資料夾**：支援無限層子資料夾巢狀結構
- 🔖 **一鍵書籤**：自動讀取 Gemini 對話標題與 URL
- 🖱️ **拖放排序**：資料夾與書籤皆可拖放重新排序或跨資料夾移動
- 🔍 **即時搜尋**：快速過濾書籤標題與資料夾名稱
- ↔️ **左右切換**：面板可任意切換到左側或右側
- 🔒 **零外洩**：所有資料僅儲存於 `chrome.storage.local`，不傳送任何資料到外部伺服器
- 🛡️ **Shadow DOM 隔離**：不注入 Gemini 頁面 DOM，外掛永不因 Gemini 改版而崩潰

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

| 操作 | 說明 |
|------|------|
| 點擊 ✨ 工具列圖示 | 開啟 / 關閉浮動面板 |
| **書籤此對話** 按鈕 | 將當前 Gemini 對話加入指定資料夾 |
| 資料夾的 **＋** 按鈕 | 直接書籤到該資料夾 |
| 資料夾的 **📁＋** 按鈕 | 在該資料夾下新增子資料夾 |
| 拖曳資料夾 | 上/下 30%：重新排序；中間 40%：移入成子資料夾 |
| 拖曳書籤 | 排序或拖至其他資料夾 header 移動 |
| **⬅ 移至左側** 按鈕 | 切換面板左右側（偏好設定會記憶）|

---

## 技術架構

```
my-gemini-bookmark/
├── manifest.json    # Manifest V3，最小化權限
├── background.js    # Service Worker
├── content.js       # Shadow DOM 面板 + 全部業務邏輯
├── panel.css        # 面板樣式（注入 Shadow Root）
└── icons/           # 擴充功能圖示
```

**核心技術：**
- Chrome Extension Manifest V3
- Shadow DOM（closed mode）隔離
- HTML5 Drag and Drop API
- `chrome.storage.local`（本機儲存）

**權限說明：**
| 權限 | 用途 |
|------|------|
| `storage` | 儲存書籤與資料夾到本機 |
| `tabs` | 讀取當前分頁 URL |
| `activeTab` | 存取當前 Gemini 分頁 |
| `host_permissions: gemini.google.com` | 只在 Gemini 網域啟動 |

---

## 本機資料格式

```json
{
  "folders": [
    {
      "id": "f_xxx",
      "name": "資料夾名稱",
      "bookmarks": [
        {
          "id": "b_yyy",
          "title": "對話標題",
          "url": "https://gemini.google.com/app/...",
          "addedAt": 1710736914000
        }
      ],
      "children": []
    }
  ]
}
```

---

## License

MIT © [bybrm](https://github.com/bybrm)
