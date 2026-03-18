/**
 * background.js - Service Worker
 *
 * 職責：
 * 1. 監聽使用者點擊擴充功能工具列圖示
 * 2. 將 "toggle" 訊息傳送給當前分頁的 Content Script
 *
 * 注意：Service Worker 沒有 DOM 存取權，只負責事件中繼
 */

/**
 * 監聽工具列圖示點擊事件
 * 當使用者點擊圖示時，向對應分頁的 content.js 發送 toggle 訊號
 *
 * @param {chrome.tabs.Tab} tab - 當前被點擊時的活躍分頁物件
 */
chrome.action.onClicked.addListener((tab) => {
  // 安全確認：只在 gemini.google.com 網域才傳送訊息
  if (!tab.url || !tab.url.startsWith("https://gemini.google.com/")) {
    console.warn("[Gemini資料夾精靈] 非 Gemini 頁面，不執行操作");
    return;
  }

  // 向 content.js 傳送 toggle 指令
  chrome.tabs.sendMessage(tab.id, { action: "toggle" }, (response) => {
    // 處理 content script 尚未載入的情況
    if (chrome.runtime.lastError) {
      console.warn(
        "[Gemini資料夾精靈] 無法傳送訊息至 content script:",
        chrome.runtime.lastError.message
      );
    }
  });
});

/**
 * 監聽來自 panel.js 的訊息
 * panel.js 透過 chrome.runtime.sendMessage 發送 openUrl 指令
 *
 * @param {Object} request - 訊息物件
 * @param {Object} sender - 發送方
 * @param {Function} sendResponse - 回應函數
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "openUrl" && request.url) {
    // 在新分頁開啟書籤連結
    chrome.tabs.create({ url: request.url }, () => {
      sendResponse({ ok: true });
    });
    return true; // 支援非同步回應
  }

  // 接收來自 content script 的 chrome.bookmarks API 請求
  if (request.action === "bm_api") {
    const { method, args } = request;
    try {
      if (!chrome.bookmarks[method]) {
        sendResponse({ error: `Method ${method} not found in bookmarks API` });
        return false;
      }
      
      chrome.bookmarks[method](...(args || []), (result) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ result });
        }
      });
      return true; // 保持異步通道
    } catch (e) {
      sendResponse({ error: e.message });
      return false;
    }
  }
});

/* ====================================================
 * 書籤變更廣播器
 * ==================================================== */
// Content script 由於權限限制無法直接監聽 bookmarks 事件，由 Service Worker 統一廣播
function broadcastBookmarkChange() {
  chrome.tabs.query({ url: "*://gemini.google.com/*" }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { action: "bm_changed" }, () => {
        if (chrome.runtime.lastError) {} // 忽略不存在或尚未初始化的分頁
      });
    });
  });
}

chrome.bookmarks.onCreated.addListener(broadcastBookmarkChange);
chrome.bookmarks.onRemoved.addListener(broadcastBookmarkChange);
chrome.bookmarks.onChanged.addListener(broadcastBookmarkChange);
chrome.bookmarks.onMoved.addListener(broadcastBookmarkChange);
