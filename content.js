/**
 * content.js — v4 (Chrome Bookmarks 同步版)
 *
 * 核心改變：
 * - 資料庫從 chrome.storage.local 改為 chrome.bookmarks API
 * - 資料自動透過 Google 帳號跨裝置同步
 * - 首次使用需選定一個 Chrome 書籤資料夾作為根目錄
 * - 監聽書籤變化事件，包含其他裝置同步進來的變更
 *
 * 操作對應：
 *   新增資料夾   → chrome.bookmarks.create({ parentId, title })
 *   新增書籤     → chrome.bookmarks.create({ parentId, title, url })
 *   刪除資料夾   → chrome.bookmarks.removeTree(id)
 *   刪除書籤     → chrome.bookmarks.remove(id)
 *   重命名       → chrome.bookmarks.update(id, { title })
 *   移動/排序    → chrome.bookmarks.move(id, { parentId, index })
 */

(function () {
  "use strict";

  if (document.getElementById("gemini-folder-host")) return;

  /* ====================================================
   * Shadow DOM
   * ==================================================== */
  const host = document.createElement("div");
  host.id = "gemini-folder-host";
  Object.assign(host.style, {
    position: "fixed", top: "0", left: "0",
    width: "0", height: "0", zIndex: "2147483647", pointerEvents: "none",
  });
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = chrome.runtime.getURL("panel.css");
  shadow.appendChild(styleLink);

  /* ====================================================
   * HTML 模板
   * ==================================================== */
  shadow.innerHTML += `
    <div class="panel-root hidden">
      <div class="toast"></div>

      <!-- 模態彈窗 -->
      <div class="modal-overlay hidden">
        <div class="modal-box">
          <div class="modal-title"></div>
          <div class="modal-body"></div>
          <input class="modal-input" type="text"/>
          <div class="modal-actions">
            <button class="btn-modal-cancel">取消</button>
            <button class="btn-modal-confirm">確認</button>
          </div>
        </div>
      </div>

      <!-- Header -->
      <div class="panel-header">
        <span class="panel-logo">✨</span>
        <span class="panel-title">Gemini 資料夾精靈</span>
        <button class="btn-settings" title="更換同步資料夾">⚙️</button>
        <button class="btn-position">⬅ 移至左側</button>
        <button class="btn-close">✕</button>
      </div>

      <!-- 首次設定頁 -->
      <div class="setup-page hidden">
        <div class="setup-icon">📚</div>
        <div class="setup-title">選擇同步資料夾</div>
        <div class="setup-desc">
          選擇一個 Chrome 書籤資料夾作為資料庫<br>
          所有書籤將透過 Google 帳號自動同步到其他裝置
        </div>
        <div class="setup-folder-list"></div>
        <div class="setup-divider">─── 或建立新資料夾 ───</div>
        <div class="setup-create-row">
          <input class="setup-new-input" type="text" placeholder="新資料夾名稱…" maxlength="50"/>
          <button class="btn-create-root">建立</button>
        </div>
      </div>

      <!-- 主面板 -->
      <div class="main-panel hidden">
        <!-- 同步狀態列 -->
        <div class="sync-status">
          <span class="sync-icon">📚</span>
          <span class="sync-folder-name"></span>
          <span class="sync-badge">Chrome 書籤同步中</span>
        </div>

        <!-- 書籤當前對話 -->
        <div class="bookmark-btn-area">
          <button class="btn-bookmark" id="quick-bookmark-btn">
            <span>＋</span><span>書籤此對話</span>
          </button>
        </div>

        <!-- 搜尋 -->
        <div class="search-area">
          <div class="search-wrapper">
            <span class="search-icon">🔍</span>
            <input class="search-input" type="text" placeholder="搜尋書籤或資料夾…"/>
          </div>
        </div>

        <!-- 資料夾列表 -->
        <div class="folder-list-area"></div>

        <!-- 底部：新增根資料夾 -->
        <div class="panel-footer">
          <input class="new-folder-input" type="text" placeholder="在根目錄新增資料夾…" maxlength="50"/>
          <button class="btn-add-folder">新增</button>
        </div>
      </div>
    </div>
  `;

  /* ====================================================
   * 狀態
   * ==================================================== */
  /** @type {string|null} 用戶選定的根書籤資料夾 ID */
  let rootFolderId = null;
  /** @type {string} 根資料夾顯示名稱 */
  let rootFolderTitle = "";
  /** @type {Set<string>} 目前展開的節點 ID */
  let expandedNodes = new Set();
  /** @type {boolean} 面板是否可見 */
  let isPanelVisible = false;
  /** @type {string} 搜尋關鍵字 */
  let searchQuery = "";
  /** @type {number|null} Toast 計時器 */
  let toastTimer = null;
  /** @type {{type:string, id:string}|null} 拖放狀態 */
  let dragState = null;
  /**
   * 是否為本擴充功能自己觸發的書籤變更
   * 為 true 時忽略 onCreated/onRemoved 等事件（避免重複刷新）
   */
  let isOurOperation = false;

  /* ====================================================
   * 工具函數
   * ==================================================== */
  const q = (sel) => shadow.querySelector(sel);
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /* ====================================================
   * Chrome Bookmarks API Promise 包裝
   * ==================================================== */
  const bm = {
    /** 取得某節點的子樹 */
    getSubTree: (id) =>
      new Promise((res, rej) =>
        chrome.bookmarks.getSubTree(id, (r) =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(r)
        )
      ),

    /** 取得完整書籤樹 */
    getTree: () => new Promise((res) => chrome.bookmarks.getTree(res)),

    /** 建立資料夾或書籤 */
    create: (props) =>
      new Promise((res, rej) =>
        chrome.bookmarks.create(props, (r) =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(r)
        )
      ),

    /** 移除單一書籤 */
    remove: (id) =>
      new Promise((res, rej) =>
        chrome.bookmarks.remove(id, () =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
        )
      ),

    /** 移除資料夾（含所有子節點）*/
    removeTree: (id) =>
      new Promise((res, rej) =>
        chrome.bookmarks.removeTree(id, () =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
        )
      ),

    /** 更新標題或 URL */
    update: (id, changes) =>
      new Promise((res, rej) =>
        chrome.bookmarks.update(id, changes, (r) =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(r)
        )
      ),

    /** 移動節點（排序或換父節點）*/
    move: (id, dest) =>
      new Promise((res, rej) =>
        chrome.bookmarks.move(id, dest, (r) =>
          chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(r)
        )
      ),

    /** 搜尋書籤 */
    search: (query) =>
      new Promise((res) => chrome.bookmarks.search(query, res)),
  };

  /* ====================================================
   * 根資料夾管理
   * ==================================================== */

  /** 從 storage 讀取已選定的根資料夾 */
  async function loadRootFolder() {
    return new Promise((res) => {
      chrome.storage.local.get(
        ["rootBookmarkFolderId", "rootBookmarkFolderTitle", "panelPosition"],
        (r) => {
          rootFolderId = r.rootBookmarkFolderId || null;
          rootFolderTitle = r.rootBookmarkFolderTitle || "";
          res();
        }
      );
    });
  }

  /**
   * 儲存選定的根資料夾
   * @param {string} id - Chrome 書籤節點 ID
   * @param {string} title - 顯示名稱
   */
  async function saveRootFolder(id, title) {
    rootFolderId = id;
    rootFolderTitle = title;
    return new Promise((res) =>
      chrome.storage.local.set({ rootBookmarkFolderId: id, rootBookmarkFolderTitle: title }, res)
    );
  }

  /* ====================================================
   * Setup 頁面
   * ==================================================== */

  /** 顯示資料夾選擇設定頁 */
  async function showSetupPage() {
    q(".setup-page").classList.remove("hidden");
    q(".main-panel").classList.add("hidden");

    const listEl = q(".setup-folder-list");
    listEl.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:13px;">載入中…</div>`;

    // 取得完整書籤樹
    const tree = await bm.getTree();
    const topLevel = tree[0]?.children || [];

    listEl.innerHTML = "";

    /**
     * 遞迴渲染 Chrome 書籤資料夾供選擇
     * @param {Array} nodes - Chrome 書籤節點陣列
     * @param {number} depth - 縮排層數
     */
    function renderPickerFolders(nodes, depth = 0) {
      nodes.forEach((node) => {
        if (node.url) return; // 跳過書籤，只顯示資料夾

        const el = document.createElement("div");
        el.className = "picker-folder-item";
        el.dataset.id = node.id;
        el.style.paddingLeft = `${12 + depth * 16}px`;
        el.innerHTML = `<span>📁</span> <span class="picker-folder-name">${esc(node.title || "(未命名)")}</span>`;

        el.addEventListener("click", async () => {
          await saveRootFolder(node.id, node.title);
          await showMainPanel();
          showToast(`已選擇「${node.title}」作為同步資料夾`);
        });

        listEl.appendChild(el);

        // 遞迴顯示子資料夾
        if (node.children?.length) {
          renderPickerFolders(node.children, depth + 1);
        }
      });
    }

    renderPickerFolders(topLevel);

    if (listEl.children.length === 0) {
      listEl.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:13px;">尚無書籤資料夾</div>`;
    }

    // 建立新資料夾
    const createInput = q(".setup-new-input");
    const oldCreateBtn = q(".btn-create-root");
    const createBtn = oldCreateBtn.cloneNode(true);
    oldCreateBtn.parentNode.replaceChild(createBtn, oldCreateBtn);

    const doCreate = async () => {
      const name = createInput.value.trim();
      if (!name) return;
      try {
        // 建立在「其他書籤」下（ID="2" 為 Chrome 預設）
        const newFolder = await bm.create({ parentId: "2", title: name });
        await saveRootFolder(newFolder.id, newFolder.title);
        await showMainPanel();
        showToast(`已建立並選擇「${name}」`);
      } catch (e) {
        showToast("建立失敗：" + e.message, true);
      }
    };

    createBtn.addEventListener("click", doCreate);
    createInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doCreate(); });
  }

  /** 顯示主面板，從 Chrome 書籤載入資料 */
  async function showMainPanel() {
    q(".setup-page").classList.add("hidden");
    q(".main-panel").classList.remove("hidden");
    await renderFromBookmarks();
    bindMainPanelEvents();
  }

  /* ====================================================
   * 主渲染（從 Chrome 書籤讀取）
   * ==================================================== */

  /**
   * 從 Chrome 書籤子樹載入資料並重新渲染
   * 這是唯一的資料讀取入口
   */
  async function renderFromBookmarks() {
    if (!rootFolderId) return;

    try {
      const results = await bm.getSubTree(rootFolderId);
      const rootNode = results[0];

      if (!rootNode) {
        // 根資料夾已被刪除，重置設定
        await saveRootFolder(null, "");
        showSetupPage();
        return;
      }

      // 更新顯示名稱
      rootFolderTitle = rootNode.title;
      const syncName = q(".sync-folder-name");
      if (syncName) syncName.textContent = rootNode.title;

      renderTree(rootNode.children || []);
    } catch (e) {
      console.error("[Gemini精靈] 讀取書籤失敗:", e);
    }
  }

  /**
   * 渲染書籤樹（分離資料夾與書籤）
   * @param {Array} nodes - Chrome 書籤節點
   */
  function renderTree(nodes) {
    const listArea = q(".folder-list-area");
    if (!listArea) return;

    let displayNodes = searchQuery ? filterNodes(nodes, searchQuery) : nodes;

    const folders = displayNodes.filter((n) => !n.url);
    const bookmarks = displayNodes.filter((n) => n.url);

    if (folders.length === 0 && bookmarks.length === 0) {
      listArea.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📂</div>
          <div class="empty-state-text">${
            searchQuery
              ? "找不到符合的結果"
              : "同步資料夾是空的<br>在下方新增資料夾，或點擊「書籤此對話」"
          }</div>
        </div>`;
      return;
    }

    listArea.innerHTML =
      renderFolderNodes(folders, 0) +
      bookmarks.map((b) => renderBookmarkNode(b, rootFolderId, 10)).join("");

    bindDynamicEvents();
  }

  /**
   * 遞迴過濾節點（搜尋用）
   * @param {Array} nodes
   * @param {string} query
   * @returns {Array}
   */
  function filterNodes(nodes, query) {
    return nodes
      .map((n) => {
        if (n.url) {
          return (n.title.toLowerCase().includes(query) || n.url.toLowerCase().includes(query))
            ? n : null;
        }
        const filteredChildren = filterNodes(n.children || [], query);
        if (n.title.toLowerCase().includes(query)) return n;
        if (filteredChildren.length > 0) return { ...n, children: filteredChildren };
        return null;
      })
      .filter(Boolean);
  }

  /** 渲染多個資料夾節點 */
  function renderFolderNodes(folders, depth) {
    return folders.map((f) => renderFolderNode(f, depth)).join("");
  }

  /**
   * 渲染單一資料夾節點（含子資料夾與書籤）
   * @param {Object} node - Chrome 書籤節點（無 url）
   * @param {number} depth - 巢狀深度
   */
  function renderFolderNode(node, depth) {
    const isOpen = expandedNodes.has(node.id);
    const children = node.children || [];
    const subFolders = children.filter((n) => !n.url);
    const bookmarks = children.filter((n) => n.url);
    const totalCount = children.length;
    const indent = 10 + depth * 18;

    return `
      <div class="folder-item" data-node-id="${node.id}" data-depth="${depth}" draggable="true">
        <div class="folder-header" data-node-id="${node.id}" style="padding-left:${indent}px">
          <span class="folder-toggle ${isOpen ? "open" : ""}">▶</span>
          <span class="folder-icon">📁</span>
          <span class="folder-name" title="${esc(node.title)}">${esc(node.title)}</span>
          ${totalCount > 0 ? `<span class="folder-count">${totalCount}</span>` : ""}
          <div class="folder-actions">
            <button class="btn-icon btn-bookmark-to-folder" title="書籤此頁到此資料夾">＋</button>
            <button class="btn-icon btn-add-subfolder" title="新增子資料夾">📁＋</button>
            <button class="btn-icon btn-rename-folder" title="重命名">✏️</button>
            <button class="btn-icon danger btn-delete-folder" title="刪除">🗑️</button>
          </div>
        </div>
        <div class="bookmark-list ${isOpen ? "open" : ""}">
          <div class="subfolder-list">
            ${renderFolderNodes(subFolders, depth + 1)}
          </div>
          ${bookmarks.map((b) => renderBookmarkNode(b, node.id, indent + 18)).join("")}
        </div>
      </div>`;
  }

  /**
   * 渲染單一書籤節點
   * @param {Object} node - Chrome 書籤節點（有 url）
   * @param {string} parentId - 父資料夾 ID
   * @param {number} indent - 左縮排 px
   */
  function renderBookmarkNode(node, parentId, indent = 28) {
    return `
      <div class="bookmark-item"
           data-node-id="${node.id}"
           data-parent-id="${parentId}"
           data-url="${esc(node.url || "")}"
           title="${esc(node.url || "")}"
           draggable="true"
           style="padding:6px 8px 6px ${indent}px">
        <span class="bookmark-favicon">💬</span>
        <span class="bookmark-title">${esc(node.title || node.url || "")}</span>
        <div class="bookmark-actions">
          <button class="btn-icon danger btn-delete-bookmark" title="刪除">✕</button>
        </div>
      </div>`;
  }

  /* ====================================================
   * CRUD 操作（透過 Chrome Bookmarks API）
   * ==================================================== */

  /**
   * 新增資料夾
   * @param {string} name - 資料夾名稱
   * @param {string|null} parentId - 父資料夾 ID（null = 根目錄）
   */
  async function addFolder(name, parentId) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      isOurOperation = true;
      const newFolder = await bm.create({ parentId: parentId || rootFolderId, title: trimmed });
      expandedNodes.add(parentId || rootFolderId);
      expandedNodes.add(newFolder.id);
      await renderFromBookmarks();
      showToast(`已新增資料夾「${trimmed}」`);
    } catch (e) {
      showToast("新增失敗：" + e.message, true);
    } finally {
      isOurOperation = false;
    }
  }

  /**
   * 書籤當前 Gemini 對話到指定資料夾
   * @param {string} parentFolderId - 目標資料夾 ID
   */
  async function bookmarkCurrentTab(parentFolderId) {
    const url = window.location.href;
    if (!url.startsWith("https://gemini.google.com/")) {
      showToast("請在 Gemini 對話頁面使用", true);
      return;
    }

    const title = getGeminiConversationTitle();

    try {
      // 檢查是否已書籤（在同一資料夾）
      const existing = await bm.search({ url });
      if (existing.some((r) => r.parentId === parentFolderId)) {
        showToast("此對話已在資料夾中");
        return;
      }

      isOurOperation = true;
      await bm.create({ parentId: parentFolderId, title, url });
      await renderFromBookmarks();
      showToast("已加入書籤 ✓");
    } catch (e) {
      showToast("書籤失敗：" + e.message, true);
    } finally {
      isOurOperation = false;
    }
  }

  /**
   * 重命名書籤或資料夾
   * @param {string} nodeId
   * @param {string} newTitle
   */
  async function renameNode(nodeId, newTitle) {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      isOurOperation = true;
      await bm.update(nodeId, { title: trimmed });
      await renderFromBookmarks();
      showToast("已重命名");
    } catch (e) {
      showToast("重命名失敗", true);
    } finally {
      isOurOperation = false;
    }
  }

  /**
   * 刪除資料夾（含所有子節點）
   * @param {string} nodeId
   */
  async function deleteFolder(nodeId) {
    try {
      isOurOperation = true;
      expandedNodes.delete(nodeId);
      await bm.removeTree(nodeId);
      await renderFromBookmarks();
      showToast("資料夾已刪除", true);
    } catch (e) {
      showToast("刪除失敗", true);
    } finally {
      isOurOperation = false;
    }
  }

  /**
   * 刪除單一書籤
   * @param {string} nodeId
   */
  async function deleteBookmark(nodeId) {
    try {
      isOurOperation = true;
      await bm.remove(nodeId);
      await renderFromBookmarks();
      showToast("書籤已刪除", true);
    } catch (e) {
      showToast("刪除失敗", true);
    } finally {
      isOurOperation = false;
    }
  }

  /* ====================================================
   * 取得 Gemini 對話標題（多層 fallback）
   * ==================================================== */
  function getGeminiConversationTitle() {
    const sidebarSels = [
      '[aria-selected="true"] .conversation-title',
      '[aria-selected="true"] span',
      '[aria-current="true"] .title',
      'li[aria-selected="true"]',
    ];
    for (const sel of sidebarSels) {
      try {
        const text = document.querySelector(sel)?.textContent?.trim();
        if (text && text.length > 1 && text.length < 200) return text;
      } catch (_) {}
    }
    const raw = document.title || "";
    const cleaned = raw
      .replace(/\s*[-|–—]\s*Gemini\s*$/i, "")
      .replace(/^Gemini\s*[-|–—]\s*/i, "")
      .trim();
    return cleaned && cleaned !== "Gemini" && cleaned.length > 2 ? cleaned : raw || window.location.href;
  }

  /* ====================================================
   * 拖放（使用 chrome.bookmarks.move）
   * ==================================================== */

  function bindDragEvents() {
    // === 資料夾拖拽 ===
    shadow.querySelectorAll(".folder-item[draggable='true']").forEach((item) => {
      const nodeId = item.dataset.nodeId;

      item.addEventListener("dragstart", (e) => {
        if (e.target.closest(".bookmark-item")) return;
        dragState = { type: "folder", id: nodeId };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "folder");
        setTimeout(() => item.classList.add("dragging"), 0);
        e.stopPropagation();
      });

      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        clearDragFeedback();
        dragState = null;
      });

      const header = item.querySelector(".folder-header");
      header?.addEventListener("dragover", (e) => {
        if (!dragState) return;
        e.preventDefault(); e.stopPropagation();
        clearDragFeedback("folders");
        header.classList.add("drag-over");
      });

      header?.addEventListener("dragleave", (e) => {
        if (!header.contains(e.relatedTarget)) header.classList.remove("drag-over");
      });

      header?.addEventListener("drop", async (e) => {
        e.preventDefault(); e.stopPropagation();
        header.classList.remove("drag-over");
        if (!dragState || dragState.id === nodeId) return;

        const rect = header.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / rect.height;

        try {
          isOurOperation = true;
          if (dragState.type === "bookmark") {
            // 將書籤移入此資料夾
            await bm.move(dragState.id, { parentId: nodeId });
            expandedNodes.add(nodeId);
          } else if (dragState.type === "folder") {
            if (ratio < 0.3 || ratio > 0.7) {
              // 同層排序：移到目標資料夾前/後
              const targetItem = header.closest(".folder-item");
              const siblings = [...targetItem.parentElement.querySelectorAll(":scope > .folder-item")];
              const targetIdx = siblings.indexOf(targetItem);
              const srcItem = shadow.querySelector(`.folder-item[data-node-id="${dragState.id}"]`);
              if (srcItem?.parentElement === targetItem.parentElement) {
                await bm.move(dragState.id, { index: ratio < 0.3 ? targetIdx : targetIdx + 1 });
              }
            } else {
              // 移入成為子資料夾
              await bm.move(dragState.id, { parentId: nodeId });
              expandedNodes.add(nodeId);
            }
          }
          await renderFromBookmarks();
        } catch (err) {
          console.error("[Gemini精靈] 移動失敗:", err);
        } finally {
          isOurOperation = false;
          dragState = null;
        }
      });
    });

    // === 書籤拖拽 ===
    shadow.querySelectorAll(".bookmark-item[draggable='true']").forEach((item) => {
      const nodeId = item.dataset.nodeId;
      const parentId = item.dataset.parentId;

      item.addEventListener("dragstart", (e) => {
        dragState = { type: "bookmark", id: nodeId, parentId };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "bookmark");
        setTimeout(() => item.classList.add("dragging"), 0);
        e.stopPropagation();
      });

      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        clearDragFeedback();
        dragState = null;
      });

      item.addEventListener("dragover", (e) => {
        if (!dragState || dragState.type !== "bookmark" || dragState.id === nodeId) return;
        e.preventDefault(); e.stopPropagation();
        clearDragFeedback("bookmarks");
        const rect = item.getBoundingClientRect();
        item.classList.add(e.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
      });

      item.addEventListener("dragleave", () => {
        item.classList.remove("drop-before", "drop-after");
      });

      item.addEventListener("drop", async (e) => {
        e.preventDefault(); e.stopPropagation();
        const before = item.classList.contains("drop-before");
        item.classList.remove("drop-before", "drop-after");
        if (!dragState || dragState.type !== "bookmark" || dragState.id === nodeId) return;

        try {
          isOurOperation = true;
          const siblings = [...item.parentElement.querySelectorAll(":scope > .bookmark-item")];
          const targetIdx = siblings.indexOf(item);
          await bm.move(dragState.id, {
            parentId: item.dataset.parentId,
            index: before ? targetIdx : targetIdx + 1,
          });
          await renderFromBookmarks();
        } catch (err) {
          console.error("[Gemini精靈] 書籤移動失敗:", err);
        } finally {
          isOurOperation = false;
          dragState = null;
        }
      });
    });
  }

  function clearDragFeedback(type) {
    if (type !== "bookmarks")
      shadow.querySelectorAll(".folder-header.drag-over").forEach((el) => el.classList.remove("drag-over"));
    if (type !== "folders")
      shadow.querySelectorAll(".bookmark-item.drop-before,.bookmark-item.drop-after").forEach((el) =>
        el.classList.remove("drop-before", "drop-after")
      );
  }

  /* ====================================================
   * 靜態事件（初始化一次）
   * ==================================================== */
  function bindStaticEvents() {
    q(".btn-close")?.addEventListener("click", closePanel);
    q(".btn-position")?.addEventListener("click", togglePosition);
    q(".btn-settings")?.addEventListener("click", showSetupPage);
  }

  /** 主面板動態事件（showMainPanel 後呼叫，避免重複綁定用 clone）*/
  function bindMainPanelEvents() {
    const folderInput = q(".new-folder-input");

    const oldAdd = q(".btn-add-folder");
    const addBtn = oldAdd.cloneNode(true);
    oldAdd.parentNode.replaceChild(addBtn, oldAdd);
    addBtn.addEventListener("click", () => {
      addFolder(folderInput.value, null);
      folderInput.value = "";
    });
    folderInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { addFolder(folderInput.value, null); folderInput.value = ""; }
    });

    const oldSearch = q(".search-input");
    const searchInput = oldSearch.cloneNode(true);
    oldSearch.parentNode.replaceChild(searchInput, oldSearch);
    searchInput.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderFromBookmarks();
    });

    const oldQuick = q("#quick-bookmark-btn");
    const quickBtn = oldQuick.cloneNode(true);
    oldQuick.parentNode.replaceChild(quickBtn, oldQuick);
    quickBtn.addEventListener("click", async () => {
      if (!rootFolderId) { showToast("請先選擇同步資料夾", true); return; }
      // 取得所有資料夾的扁平清單供選擇
      const results = await bm.getSubTree(rootFolderId);
      const allFolders = [];
      const flatten = (nodes, prefix = "") => {
        nodes.forEach((n) => {
          if (!n.url) {
            const label = prefix ? `${prefix} › ${n.title}` : n.title;
            allFolders.push({ id: n.id, name: label });
            flatten(n.children || [], label);
          }
        });
      };
      allFolders.push({ id: rootFolderId, name: results[0]?.title || "根目錄" });
      flatten(results[0]?.children || []);

      if (allFolders.length === 1) {
        bookmarkCurrentTab(allFolders[0].id);
      } else {
        showFolderPicker(allFolders);
      }
    });
  }

  /** 動態事件（每次 renderTree 後呼叫）*/
  function bindDynamicEvents() {
    // 展開/收合
    shadow.querySelectorAll(".folder-header").forEach((header) => {
      header.addEventListener("click", (e) => {
        if (e.target.closest(".folder-actions")) return;
        const id = header.dataset.nodeId;
        if (!id) return;
        expandedNodes.has(id) ? expandedNodes.delete(id) : expandedNodes.add(id);
        renderFromBookmarks();
      });
    });

    // 書籤此頁到資料夾
    shadow.querySelectorAll(".btn-bookmark-to-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".folder-item")?.dataset.nodeId;
        if (id) bookmarkCurrentTab(id);
      });
    });

    // 新增子資料夾
    shadow.querySelectorAll(".btn-add-subfolder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".folder-item")?.dataset.nodeId;
        const name = btn.closest(".folder-item")?.querySelector(".folder-name")?.textContent || "";
        if (id) showAddSubfolderModal(id, name);
      });
    });

    // 重命名
    shadow.querySelectorAll(".btn-rename-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".folder-item")?.dataset.nodeId;
        const name = btn.closest(".folder-item")?.querySelector(".folder-name")?.textContent || "";
        if (id) showRenameModal(id, name);
      });
    });

    // 刪除資料夾
    shadow.querySelectorAll(".btn-delete-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".folder-item")?.dataset.nodeId;
        const name = btn.closest(".folder-item")?.querySelector(".folder-name")?.textContent || "";
        if (id) showDeleteModal("folder", id, name);
      });
    });

    // 開啟書籤
    shadow.querySelectorAll(".bookmark-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        if (e.target.closest(".bookmark-actions")) return;
        const url = item.dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

    // 刪除書籤
    shadow.querySelectorAll(".btn-delete-bookmark").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const item = btn.closest(".bookmark-item");
        const id = item?.dataset.nodeId;
        const title = item?.querySelector(".bookmark-title")?.textContent || "此書籤";
        if (id) showDeleteModal("bookmark", id, title);
      });
    });

    // 拖放事件
    bindDragEvents();
  }

  /* ====================================================
   * 面板開關與位置
   * ==================================================== */
  function openPanel() {
    const panel = q(".panel-root");
    if (!panel) return;
    isPanelVisible = true;
    panel.classList.remove("hidden");
    host.style.pointerEvents = "auto";
  }
  function closePanel() {
    const panel = q(".panel-root");
    if (!panel) return;
    isPanelVisible = false;
    panel.classList.add("hidden");
    host.style.pointerEvents = "none";
  }
  function togglePanel() { isPanelVisible ? closePanel() : openPanel(); }

  function togglePosition() {
    const panel = q(".panel-root");
    const btn = q(".btn-position");
    const isLeft = panel?.classList.contains("position-left");
    panel?.classList.toggle("position-left", !isLeft);
    if (btn) btn.textContent = isLeft ? "⬅ 移至左側" : "➡ 移至右側";
    chrome.storage.local.set({ panelPosition: isLeft ? "right" : "left" });
  }

  function applyStoredPosition() {
    chrome.storage.local.get(["panelPosition"], (r) => {
      const panel = q(".panel-root");
      const btn = q(".btn-position");
      const isLeft = r.panelPosition === "left";
      panel?.classList.toggle("position-left", isLeft);
      if (btn) btn.textContent = isLeft ? "➡ 移至右側" : "⬅ 移至左側";
    });
  }

  /* ====================================================
   * 模態彈窗
   * ==================================================== */

  /**
   * 複製按鈕並清除舊事件監聽（Chrome Extension 慣用做法）
   */
  function refreshBtn(sel, text, cls) {
    const old = q(sel);
    if (!old) return null;
    const fresh = old.cloneNode(false);
    fresh.textContent = text;
    fresh.className = cls;
    old.parentNode.replaceChild(fresh, old);
    return fresh;
  }

  function showAddSubfolderModal(parentId, parentName) {
    q(".modal-title").textContent = "新增子資料夾";
    q(".modal-body").textContent = `在「${parentName}」下新增：`;
    const input = q(".modal-input");
    input.value = ""; input.style.display = "block";
    q(".modal-overlay").classList.remove("hidden");
    input.focus();

    const confirm = refreshBtn(".btn-modal-confirm", "新增", "btn-modal-confirm");
    const cancel = refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel");
    const doAdd = () => {
      addFolder(input.value, parentId);
      expandedNodes.add(parentId);
      q(".modal-overlay").classList.add("hidden");
    };
    confirm?.addEventListener("click", doAdd);
    cancel?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doAdd();
      if (e.key === "Escape") q(".modal-overlay").classList.add("hidden");
    });
  }

  function showRenameModal(nodeId, currentName) {
    q(".modal-title").textContent = "重命名";
    q(".modal-body").textContent = "請輸入新名稱：";
    const input = q(".modal-input");
    input.value = currentName; input.style.display = "block";
    q(".modal-overlay").classList.remove("hidden");
    input.focus(); input.select();

    const confirm = refreshBtn(".btn-modal-confirm", "確認", "btn-modal-confirm");
    const cancel = refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel");
    const doRename = () => { renameNode(nodeId, input.value); q(".modal-overlay").classList.add("hidden"); };
    confirm?.addEventListener("click", doRename);
    cancel?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doRename();
      if (e.key === "Escape") q(".modal-overlay").classList.add("hidden");
    });
  }

  function showDeleteModal(type, nodeId, name) {
    q(".modal-title").textContent = type === "folder" ? "刪除資料夾" : "刪除書籤";
    q(".modal-body").textContent =
      type === "folder"
        ? `確定刪除「${name}」及其所有書籤與子資料夾？`
        : `確定刪除書籤「${name}」？`;
    q(".modal-input").style.display = "none";
    q(".modal-overlay").classList.remove("hidden");

    const confirm = refreshBtn(".btn-modal-confirm", "刪除", "btn-modal-confirm danger");
    const cancel = refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel");
    confirm?.addEventListener("click", () => {
      type === "folder" ? deleteFolder(nodeId) : deleteBookmark(nodeId);
      q(".modal-overlay").classList.add("hidden");
    });
    cancel?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
  }

  function showFolderPicker(folders) {
    q(".modal-title").textContent = "選擇目標資料夾";
    q(".modal-input").style.display = "none";
    const body = q(".modal-body");
    body.innerHTML = folders
      .map(
        (f) => `
      <div data-folder-id="${f.id}" style="
        padding:8px 12px;border-radius:6px;cursor:pointer;margin-bottom:4px;
        background:var(--item-hover);display:flex;align-items:center;gap:8px;
        font-size:14px;color:var(--text-primary);">
        📁 ${esc(f.name)}
      </div>`
      )
      .join("");
    q(".modal-overlay").classList.remove("hidden");

    body.querySelectorAll("[data-folder-id]").forEach((el) => {
      el.addEventListener("mouseover", () => (el.style.background = "var(--item-active)"));
      el.addEventListener("mouseout", () => (el.style.background = "var(--item-hover)"));
      el.addEventListener("click", () => {
        bookmarkCurrentTab(el.dataset.folderId);
        q(".modal-overlay").classList.add("hidden");
      });
    });

    refreshBtn(".btn-modal-confirm", "取消", "btn-modal-confirm")?.addEventListener(
      "click", () => q(".modal-overlay").classList.add("hidden")
    );
    refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel")?.addEventListener(
      "click", () => q(".modal-overlay").classList.add("hidden")
    );
  }

  /* ====================================================
   * Toast
   * ==================================================== */
  function showToast(msg, isError = false) {
    const t = q(".toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast" + (isError ? " error" : "");
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2500);
  }

  /* ====================================================
   * 監聽書籤變更（跨裝置同步反應）
   * ==================================================== */

  /**
   * 監聽 Chrome 書籤的任何變更
   * 若不是本擴充功能自己觸發的（isOurOperation=false），
   * 且面板當下可見，則自動刷新
   */
  function listenForBookmarkChanges() {
    const refresh = () => {
      if (isOurOperation || !rootFolderId || !isPanelVisible) return;
      renderFromBookmarks();
    };
    chrome.bookmarks.onCreated.addListener(refresh);
    chrome.bookmarks.onRemoved.addListener(refresh);
    chrome.bookmarks.onChanged.addListener(refresh);
    chrome.bookmarks.onMoved.addListener(refresh);
  }

  /* ====================================================
   * 訊息監聽（來自 background.js）
   * ==================================================== */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggle") { togglePanel(); sendResponse({ ok: true }); }
    return true;
  });

  /* ====================================================
   * 初始化
   * ==================================================== */
  async function init() {
    bindStaticEvents();
    applyStoredPosition();
    await loadRootFolder();

    if (rootFolderId) {
      await showMainPanel();
    } else {
      await showSetupPage();
    }

    listenForBookmarkChanges();
  }

  init();
})();
