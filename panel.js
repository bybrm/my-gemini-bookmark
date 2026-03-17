/**
 * panel.js - 書籤與資料夾管理核心業務邏輯
 *
 * 職責：
 * 1. 從 chrome.storage.local 讀取/寫入資料
 * 2. 渲染資料夾與書籤清單
 * 3. 處理所有 CRUD 操作（新增、重命名、刪除）
 * 4. 書籤當前 Gemini 對話頁面
 * 5. 搜尋過濾
 *
 * 資料結構：
 * {
 *   folders: [
 *     {
 *       id: "f_12345",
 *       name: "程式碼開發",
 *       bookmarks: [
 *         { title: "...", url: "...", addedAt: 1710736914000 }
 *       ]
 *     }
 *   ]
 * }
 */

/* ====== 狀態管理 ====== */
/** @type {{ folders: Array }} 本地資料快取 */
let state = { folders: [] };

/** @type {string} 目前搜尋關鍵字 */
let searchQuery = "";

/** @type {Set<string>} 目前展開中的資料夾 ID 集合 */
let expandedFolders = new Set();

/* ====== Shadow Root 參照（由 content.js 傳入）====== */
/** @type {ShadowRoot} */
let shadowRoot = null;

/**
 * 初始化面板邏輯
 * 由 content.js 在 Shadow DOM 掛載後呼叫
 *
 * @param {ShadowRoot} root - 面板所在的 Shadow Root
 */
function initPanel(root) {
  shadowRoot = root;
  loadData().then(() => {
    bindEvents();
    render();
  });

  /**
   * 監聽來自 content.js 的快捷書籤事件
   * 當頂部「書籤此對話」按鈕被點擊後，content.js 會 dispatch 此事件
   * detail.folderId 為使用者選擇的目標資料夾 ID
   */
  document.addEventListener("gemini-quick-bookmark", (e) => {
    const folderId = e.detail?.folderId;
    if (folderId) bookmarkCurrentTab(folderId);
  });
}

/* ====== 資料讀寫 ====== */

/**
 * 從 chrome.storage.local 載入所有資料
 * @returns {Promise<void>}
 */
async function loadData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["folders"], (result) => {
      state.folders = result.folders || [];
      resolve();
    });
  });
}

/**
 * 將目前 state 儲存回 chrome.storage.local
 * @returns {Promise<void>}
 */
async function saveData() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ folders: state.folders }, resolve);
  });
}

/* ====== 唯一 ID 產生器 ====== */
/**
 * 產生帶前綴的唯一 ID
 * @param {string} prefix - 前綴字串，例如 "f" 或 "b"
 * @returns {string} 例如 "f_1710736914123"
 */
function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/* ====== 資料夾 CRUD ====== */

/**
 * 新增資料夾
 * @param {string} name - 資料夾名稱
 */
async function addFolder(name) {
  const trimmed = name.trim();
  if (!trimmed) return;

  const folder = {
    id: genId("f"),
    name: trimmed,
    bookmarks: [],
  };
  state.folders.push(folder);
  await saveData();
  expandedFolders.add(folder.id);
  render();
  showToast(`已新增資料夾「${trimmed}」`);
}

/**
 * 重命名資料夾
 * @param {string} folderId - 資料夾 ID
 * @param {string} newName - 新名稱
 */
async function renameFolder(folderId, newName) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder || !newName.trim()) return;

  folder.name = newName.trim();
  await saveData();
  render();
  showToast("資料夾已重命名");
}

/**
 * 刪除資料夾及其所有書籤
 * @param {string} folderId - 資料夾 ID
 */
async function deleteFolder(folderId) {
  state.folders = state.folders.filter((f) => f.id !== folderId);
  expandedFolders.delete(folderId);
  await saveData();
  render();
  showToast("資料夾已刪除", true);
}

/* ====== 書籤 CRUD ====== */

/**
 * 書籤當前 Gemini 對話分頁至指定資料夾
 * 透過 chrome.runtime 訊息向 background 查詢當前分頁資訊
 *
 * @param {string} folderId - 目標資料夾 ID
 */
async function bookmarkCurrentTab(folderId) {
  // 向 content.js 環境（parent window）取得分頁資訊
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getTabInfo" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        showToast("無法取得分頁資訊", true);
        resolve();
        return;
      }

      const { url, title } = response;

      // 驗證是否為 Gemini 網址
      if (!url || !url.startsWith("https://gemini.google.com/")) {
        showToast("請在 Gemini 對話頁面使用此功能", true);
        resolve();
        return;
      }

      const folder = state.folders.find((f) => f.id === folderId);
      if (!folder) {
        resolve();
        return;
      }

      // 防止重複書籤
      const exists = folder.bookmarks.some((b) => b.url === url);
      if (exists) {
        showToast("此對話已在資料夾中", false, "warn");
        resolve();
        return;
      }

      folder.bookmarks.push({
        id: genId("b"),
        title: title || url,
        url,
        addedAt: Date.now(),
      });

      saveData().then(() => {
        render();
        showToast(`已加入「${folder.name}」`);
        resolve();
      });
    });
  });
}

/**
 * 刪除指定書籤
 * @param {string} folderId - 所屬資料夾 ID
 * @param {string} bookmarkId - 書籤 ID
 */
async function deleteBookmark(folderId, bookmarkId) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return;

  folder.bookmarks = folder.bookmarks.filter((b) => b.id !== bookmarkId);
  await saveData();
  render();
  showToast("書籤已刪除", true);
}

/* ====== 渲染 ====== */

/**
 * 主渲染函數：根據 state 渲染整個資料夾列表
 * 支援搜尋過濾
 */
function render() {
  const listArea = q(".folder-list-area");
  if (!listArea) return;

  // 套用搜尋過濾
  const filtered = state.folders
    .map((folder) => {
      if (!searchQuery) return folder;
      return {
        ...folder,
        bookmarks: folder.bookmarks.filter(
          (b) =>
            b.title.toLowerCase().includes(searchQuery) ||
            b.url.toLowerCase().includes(searchQuery)
        ),
      };
    })
    .filter((folder) => {
      if (!searchQuery) return true;
      return (
        folder.name.toLowerCase().includes(searchQuery) ||
        folder.bookmarks.length > 0
      );
    });

  if (filtered.length === 0) {
    listArea.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📂</div>
        <div class="empty-state-text">
          ${
            searchQuery
              ? "找不到符合的結果"
              : "尚無資料夾<br>在下方輸入名稱建立第一個資料夾"
          }
        </div>
      </div>
    `;
    return;
  }

  listArea.innerHTML = filtered.map(renderFolder).join("");
  bindFolderEvents();
}

/**
 * 渲染單一資料夾的 HTML
 * @param {Object} folder - 資料夾物件
 * @returns {string} HTML 字串
 */
function renderFolder(folder) {
  const isOpen = expandedFolders.has(folder.id);
  const count = folder.bookmarks.length;

  return `
    <div class="folder-item" data-folder-id="${folder.id}">
      <div class="folder-header">
        <span class="folder-toggle ${isOpen ? "open" : ""}">▶</span>
        <span class="folder-icon">📁</span>
        <span class="folder-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</span>
        ${count > 0 ? `<span class="folder-count">${count}</span>` : ""}
        <div class="folder-actions">
          <button class="btn-icon btn-bookmark-to-folder" title="書籤此頁">＋</button>
          <button class="btn-icon btn-rename-folder" title="重命名">✏️</button>
          <button class="btn-icon danger btn-delete-folder" title="刪除資料夾">🗑️</button>
        </div>
      </div>
      <div class="bookmark-list ${isOpen ? "open" : ""}">
        ${count === 0
          ? `<div style="padding:6px 10px 6px 32px;font-size:12px;color:var(--text-muted);">空的資料夾</div>`
          : folder.bookmarks.map((b) => renderBookmark(folder.id, b)).join("")
        }
      </div>
    </div>
  `;
}

/**
 * 渲染單一書籤的 HTML
 * @param {string} folderId - 所屬資料夾 ID
 * @param {Object} bookmark - 書籤物件
 * @returns {string} HTML 字串
 */
function renderBookmark(folderId, bookmark) {
  return `
    <div class="bookmark-item"
         data-folder-id="${folderId}"
         data-bookmark-id="${bookmark.id}"
         data-url="${escapeHtml(bookmark.url)}"
         title="${escapeHtml(bookmark.url)}">
      <span class="bookmark-favicon">💬</span>
      <span class="bookmark-title">${escapeHtml(bookmark.title)}</span>
      <div class="bookmark-actions">
        <button class="btn-icon danger btn-delete-bookmark" title="刪除書籤">✕</button>
      </div>
    </div>
  `;
}

/* ====== 事件綁定 ====== */

/**
 * 綁定靜態元素的事件（只在初始化時執行一次）
 */
function bindEvents() {
  // 關閉按鈕
  q(".btn-close")?.addEventListener("click", () => {
    const panel = q(".panel-root");
    panel?.classList.add("hidden");
    // 通知 content.js 面板已關閉
    document.dispatchEvent(new CustomEvent("gemini-panel-close"));
  });

  // 位置切換按鈕
  q(".btn-position")?.addEventListener("click", togglePosition);

  // 新增資料夾（按 Enter 或點按鈕）
  const folderInput = q(".new-folder-input");
  const addBtn = q(".btn-add-folder");

  folderInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFolder(folderInput.value);
  });
  addBtn?.addEventListener("click", () => {
    addFolder(folderInput.value);
    folderInput.value = "";
  });
  folderInput?.addEventListener("input", () => {
    addBtn.textContent = folderInput.value.trim() ? "新增" : "新增";
  });

  // 搜尋
  q(".search-input")?.addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    render();
  });
}

/**
 * 綁定動態渲染後的資料夾/書籤事件
 * 每次 render() 後呼叫
 */
function bindFolderEvents() {
  // 資料夾展開/收合
  shadowRoot.querySelectorAll(".folder-header").forEach((header) => {
    // 避免點按操作按鈕時也觸發展開
    header.addEventListener("click", (e) => {
      if (e.target.closest(".folder-actions")) return;
      const folderId = header.closest(".folder-item")?.dataset.folderId;
      if (!folderId) return;
      toggleFolder(folderId);
    });
  });

  // 書籤當前頁 (+ 按鈕)
  shadowRoot.querySelectorAll(".btn-bookmark-to-folder").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const folderId = btn.closest(".folder-item")?.dataset.folderId;
      if (folderId) bookmarkCurrentTab(folderId);
    });
  });

  // 重命名資料夾
  shadowRoot.querySelectorAll(".btn-rename-folder").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const folderId = btn.closest(".folder-item")?.dataset.folderId;
      const folder = state.folders.find((f) => f.id === folderId);
      if (folder) showRenameModal(folderId, folder.name);
    });
  });

  // 刪除資料夾
  shadowRoot.querySelectorAll(".btn-delete-folder").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const folderId = btn.closest(".folder-item")?.dataset.folderId;
      const folder = state.folders.find((f) => f.id === folderId);
      if (folder) showDeleteModal("folder", folderId, folder.name);
    });
  });

  // 開啟書籤連結
  shadowRoot.querySelectorAll(".bookmark-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (e.target.closest(".bookmark-actions")) return;
      const url = item.dataset.url;
      if (url) chrome.runtime.sendMessage({ action: "openUrl", url });
    });
  });

  // 刪除書籤
  shadowRoot.querySelectorAll(".btn-delete-bookmark").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = btn.closest(".bookmark-item");
      const folderId = item?.dataset.folderId;
      const bookmarkId = item?.dataset.bookmarkId;
      if (folderId && bookmarkId) {
        showDeleteModal("bookmark", folderId, "此書籤", bookmarkId);
      }
    });
  });
}

/* ====== 資料夾展開/收合 ====== */

/**
 * 切換資料夾展開狀態
 * @param {string} folderId - 資料夾 ID
 */
function toggleFolder(folderId) {
  if (expandedFolders.has(folderId)) {
    expandedFolders.delete(folderId);
  } else {
    expandedFolders.add(folderId);
  }
  render();
}

/* ====== 位置切換 ====== */

/**
 * 切換面板左右側位置，並儲存偏好設定
 */
async function togglePosition() {
  const panel = q(".panel-root");
  const isLeft = panel?.classList.contains("position-left");

  if (isLeft) {
    panel.classList.remove("position-left");
    q(".btn-position").textContent = "⬅ 移至左側";
    chrome.storage.local.set({ panelPosition: "right" });
  } else {
    panel.classList.add("position-left");
    q(".btn-position").textContent = "➡ 移至右側";
    chrome.storage.local.set({ panelPosition: "left" });
  }
}

/**
 * 從 storage 讀取並套用面板位置偏好
 */
async function applyStoredPosition() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["panelPosition"], (result) => {
      const panel = q(".panel-root");
      const btn = q(".btn-position");
      if (result.panelPosition === "left") {
        panel?.classList.add("position-left");
        if (btn) btn.textContent = "➡ 移至右側";
      } else {
        panel?.classList.remove("position-left");
        if (btn) btn.textContent = "⬅ 移至左側";
      }
      resolve();
    });
  });
}

/* ====== 模態彈窗 ====== */

/**
 * 顯示重命名模態
 * @param {string} folderId
 * @param {string} currentName
 */
function showRenameModal(folderId, currentName) {
  const overlay = q(".modal-overlay");
  const title = q(".modal-title");
  const body = q(".modal-body");
  const input = q(".modal-input");
  const confirm = q(".btn-modal-confirm");
  const cancel = q(".btn-modal-cancel");

  title.textContent = "重命名資料夾";
  body.textContent = "請輸入新的資料夾名稱：";
  input.value = currentName;
  input.style.display = "block";
  confirm.textContent = "確認";
  confirm.className = "btn-modal-confirm";

  // 清除舊的事件監聽
  const newConfirm = confirm.cloneNode(true);
  confirm.parentNode.replaceChild(newConfirm, confirm);
  const newCancel = cancel.cloneNode(true);
  cancel.parentNode.replaceChild(newCancel, cancel);

  overlay.classList.remove("hidden");
  input.focus();
  input.select();

  q(".btn-modal-confirm").addEventListener("click", () => {
    renameFolder(folderId, input.value);
    overlay.classList.add("hidden");
  });

  q(".btn-modal-cancel").addEventListener("click", () => {
    overlay.classList.add("hidden");
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      renameFolder(folderId, input.value);
      overlay.classList.add("hidden");
    }
    if (e.key === "Escape") overlay.classList.add("hidden");
  });
}

/**
 * 顯示刪除確認模態
 * @param {"folder"|"bookmark"} type - 刪除類型
 * @param {string} folderId
 * @param {string} name - 顯示名稱
 * @param {string} [bookmarkId]
 */
function showDeleteModal(type, folderId, name, bookmarkId) {
  const overlay = q(".modal-overlay");
  const title = q(".modal-title");
  const body = q(".modal-body");
  const input = q(".modal-input");
  const confirm = q(".btn-modal-confirm");
  const cancel = q(".btn-modal-cancel");

  title.textContent = type === "folder" ? "刪除資料夾" : "刪除書籤";
  body.textContent =
    type === "folder"
      ? `確定要刪除資料夾「${name}」及其所有書籤嗎？`
      : `確定要刪除書籤「${name}」嗎？`;
  input.style.display = "none";
  confirm.textContent = "刪除";
  confirm.className = "btn-modal-confirm danger";

  const newConfirm = confirm.cloneNode(true);
  confirm.parentNode.replaceChild(newConfirm, confirm);
  const newCancel = cancel.cloneNode(true);
  cancel.parentNode.replaceChild(newCancel, cancel);

  overlay.classList.remove("hidden");

  q(".btn-modal-confirm").addEventListener("click", () => {
    if (type === "folder") {
      deleteFolder(folderId);
    } else {
      deleteBookmark(folderId, bookmarkId);
    }
    overlay.classList.add("hidden");
  });

  q(".btn-modal-cancel").addEventListener("click", () => {
    overlay.classList.add("hidden");
  });
}

/* ====== Toast 通知 ====== */

/** @type {number|null} Toast 計時器 ID */
let toastTimer = null;

/**
 * 顯示短暫的 Toast 通知
 * @param {string} message - 通知文字
 * @param {boolean} [isError=false] - 是否為錯誤樣式
 * @param {string} [type="success"] - 通知類型
 */
function showToast(message, isError = false, type = "success") {
  const toast = q(".toast");
  if (!toast) return;

  toast.textContent = message;
  toast.className = "toast" + (isError ? " error" : "");
  toast.classList.add("show");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

/* ====== 工具函數 ====== */

/**
 * Shadow Root 內的快捷選擇器
 * @param {string} selector - CSS 選擇器
 * @returns {Element|null}
 */
function q(selector) {
  return shadowRoot?.querySelector(selector) ?? null;
}

/**
 * 跳脫 HTML 特殊字元，防止 XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ====== 匯出給 content.js 使用的介面 ====== */
window.__geminiPanel = { initPanel, applyStoredPosition };
