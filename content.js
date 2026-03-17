/**
 * content.js — v3 (子資料夾 + 拖放)
 *
 * 資料結構：
 * {
 *   folders: [
 *     {
 *       id: "f_xxx", name: "Dev",
 *       bookmarks: [{ id, title, url, addedAt }],
 *       children: [  // 子資料夾（無限層）
 *         { id: "f_yyy", name: "Python", bookmarks: [], children: [] }
 *       ]
 *     }
 *   ]
 * }
 *
 * 拖放規則：
 * - 🗂 資料夾 → 拖到同層其他資料夾頭部：重新排序
 * - 🗂 資料夾 → 拖到另一個資料夾的「✕放入子資料夾」區：移入成為子資料夾
 * - 💬 書籤 → 拖到同資料夾其他書籤：重新排序
 * - 💬 書籤 → 拖到其他資料夾頭部：移入那個資料夾
 */

(function () {
  "use strict";

  if (document.getElementById("gemini-folder-host")) return;

  /* ====================================================
   * Shadow DOM 建立
   * ==================================================== */
  const host = document.createElement("div");
  host.id = "gemini-folder-host";
  Object.assign(host.style, {
    position: "fixed", top: "0", left: "0",
    width: "0", height: "0",
    zIndex: "2147483647", pointerEvents: "none",
  });
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  /* ====================================================
   * 注入 CSS
   * ==================================================== */
  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = chrome.runtime.getURL("panel.css");
  shadow.appendChild(styleLink);

  /* ====================================================
   * 面板 HTML
   * ==================================================== */
  shadow.innerHTML += `
    <div class="panel-root hidden">
      <div class="toast"></div>
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
      <div class="panel-header">
        <span class="panel-logo">✨</span>
        <span class="panel-title">Gemini 資料夾精靈</span>
        <button class="btn-position">⬅ 移至左側</button>
        <button class="btn-close">✕</button>
      </div>
      <div class="bookmark-btn-area">
        <button class="btn-bookmark" id="quick-bookmark-btn">
          <span>＋</span><span>書籤此對話</span>
        </button>
      </div>
      <div class="search-area">
        <div class="search-wrapper">
          <span class="search-icon">🔍</span>
          <input class="search-input" type="text" placeholder="搜尋書籤或資料夾…"/>
        </div>
      </div>
      <div class="folder-list-area"></div>
      <div class="panel-footer">
        <input class="new-folder-input" type="text" placeholder="新增根資料夾…" maxlength="50"/>
        <button class="btn-add-folder">新增</button>
      </div>
    </div>
  `;

  /* ====================================================
   * 狀態
   * ==================================================== */
  let state = { folders: [] };
  let searchQuery = "";
  let expandedFolders = new Set();
  let isPanelVisible = false;
  let toastTimer = null;

  /**
   * 拖放狀態物件
   * @type {{ type:'folder'|'bookmark', id:string, folderId?:string }|null}
   */
  let dragState = null;

  /* ====================================================
   * 工具函數
   * ==================================================== */
  const q = (sel) => shadow.querySelector(sel);
  const genId = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const esc = (s) =>
    String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
              .replace(/"/g,"&quot;").replace(/'/g,"&#39;");

  /* ====================================================
   * 樹狀遍歷
   * ==================================================== */

  /**
   * 在樹中依 ID 尋找資料夾
   * @param {string} id
   * @param {Array} [tree]
   * @returns {{ folder, parent:Array, index:number }|null}
   */
  function findFolder(id, tree = state.folders) {
    for (let i = 0; i < tree.length; i++) {
      if (tree[i].id === id) return { folder: tree[i], parent: tree, index: i };
      const found = findFolder(id, tree[i].children || []);
      if (found) return found;
    }
    return null;
  }

  /**
   * 判斷 targetId 是否在 sourceId 的子樹中（防止資料夾移入自身後代）
   * @param {string} sourceId
   * @param {string} targetId
   * @returns {boolean}
   */
  function isDescendant(sourceId, targetId) {
    const res = findFolder(sourceId);
    if (!res) return false;
    return !!findFolder(targetId, res.folder.children || []);
  }

  /**
   * 遷移舊資料結構（補上缺少的 id/children 欄位）
   * @param {Array} folders
   * @returns {Array}
   */
  function migrateTree(folders) {
    return (folders || []).map((f) => ({
      id: f.id || genId("f"),
      name: f.name || "未命名",
      bookmarks: (f.bookmarks || []).map((b) => ({
        id: b.id || genId("b"),
        title: b.title || b.url || "",
        url: b.url || "",
        addedAt: b.addedAt || Date.now(),
      })),
      children: migrateTree(f.children || []),
    }));
  }

  /* ====================================================
   * Storage
   * ==================================================== */
  async function loadData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["folders"], (r) => {
        state.folders = migrateTree(r.folders || []);
        resolve();
      });
    });
  }

  async function saveData() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ folders: state.folders }, resolve);
    });
  }

  /* ====================================================
   * 資料夾 CRUD
   * ==================================================== */

  /**
   * 新增資料夾（parentFolderId=null 則為根層）
   * @param {string} name
   * @param {string|null} [parentFolderId]
   */
  async function addFolder(name, parentFolderId = null) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const f = { id: genId("f"), name: trimmed, bookmarks: [], children: [] };

    if (parentFolderId) {
      const res = findFolder(parentFolderId);
      if (!res) return;
      res.folder.children.push(f);
      expandedFolders.add(parentFolderId);
    } else {
      state.folders.push(f);
    }
    expandedFolders.add(f.id);
    await saveData();
    render();
    showToast(`已新增資料夾「${trimmed}」`);
  }

  async function renameFolder(folderId, newName) {
    const res = findFolder(folderId);
    if (!res || !newName.trim()) return;
    res.folder.name = newName.trim();
    await saveData();
    render();
    showToast("資料夾已重命名");
  }

  async function deleteFolder(folderId) {
    const res = findFolder(folderId);
    if (!res) return;
    res.parent.splice(res.index, 1);
    expandedFolders.delete(folderId);
    await saveData();
    render();
    showToast("資料夾已刪除", true);
  }

  /* ====================================================
   * 書籤 CRUD
   * ==================================================== */

  /**
   * 書籤當前分頁至指定資料夾
   * @param {string} folderId
   */
  async function bookmarkCurrentTab(folderId) {
    const url = window.location.href;
    if (!url.startsWith("https://gemini.google.com/")) {
      showToast("請在 Gemini 對話頁面使用", true);
      return;
    }
    const res = findFolder(folderId);
    if (!res) return;
    const folder = res.folder;

    if (folder.bookmarks.some((b) => b.url === url)) {
      showToast("此對話已在資料夾中");
      return;
    }
    folder.bookmarks.push({
      id: genId("b"),
      title: getGeminiConversationTitle(),
      url,
      addedAt: Date.now(),
    });
    await saveData();
    render();
    showToast(`已加入「${folder.name}」`);
  }

  async function deleteBookmark(folderId, bookmarkId) {
    const res = findFolder(folderId);
    if (!res) return;
    res.folder.bookmarks = res.folder.bookmarks.filter((b) => b.id !== bookmarkId);
    await saveData();
    render();
    showToast("書籤已刪除", true);
  }

  /* ====================================================
   * 拖放：書籤移動（跨資料夾 or 重新排序）
   * ==================================================== */

  /**
   * 將書籤移至目標資料夾（拖到 folder-header 觸發）
   */
  async function moveBookmarkToFolder(srcFolderId, bookmarkId, dstFolderId) {
    if (srcFolderId === dstFolderId) return;
    const srcRes = findFolder(srcFolderId);
    const dstRes = findFolder(dstFolderId);
    if (!srcRes || !dstRes) return;

    const bi = srcRes.folder.bookmarks.findIndex((b) => b.id === bookmarkId);
    if (bi === -1) return;
    const [bm] = srcRes.folder.bookmarks.splice(bi, 1);

    if (dstRes.folder.bookmarks.some((b) => b.url === bm.url)) {
      srcRes.folder.bookmarks.splice(bi, 0, bm); // rollback
      showToast("此書籤已在目標資料夾");
      return;
    }
    dstRes.folder.bookmarks.push(bm);
    await saveData();
    render();
    showToast(`已移至「${dstRes.folder.name}」`);
  }

  /**
   * 書籤重新排序（drop onto another bookmark）
   */
  async function reorderBookmark(srcFolderId, bookmarkId, dstFolderId, targetBookmarkId, before) {
    const srcRes = findFolder(srcFolderId);
    const dstRes = findFolder(dstFolderId);
    if (!srcRes || !dstRes) return;

    const bi = srcRes.folder.bookmarks.findIndex((b) => b.id === bookmarkId);
    if (bi === -1) return;
    const [bm] = srcRes.folder.bookmarks.splice(bi, 1);

    // If moved to different folder, check duplicate
    if (srcFolderId !== dstFolderId && dstRes.folder.bookmarks.some((b) => b.url === bm.url)) {
      srcRes.folder.bookmarks.splice(bi, 0, bm);
      showToast("此書籤已在目標資料夾");
      return;
    }

    const ti = dstRes.folder.bookmarks.findIndex((b) => b.id === targetBookmarkId);
    if (ti === -1) {
      dstRes.folder.bookmarks.push(bm);
    } else {
      dstRes.folder.bookmarks.splice(before ? ti : ti + 1, 0, bm);
    }
    await saveData();
    render();
  }

  /**
   * 資料夾重新排序（同父層）
   */
  async function reorderFolder(sourceId, targetId, before) {
    const srcRes = findFolder(sourceId);
    const tgtRes = findFolder(targetId);
    if (!srcRes || !tgtRes) return;
    if (srcRes.parent !== tgtRes.parent) return; // 不同層，不處理

    const folder = srcRes.folder;
    srcRes.parent.splice(srcRes.index, 1);
    const newTi = tgtRes.parent.findIndex((f) => f.id === targetId);
    tgtRes.parent.splice(before ? newTi : newTi + 1, 0, folder);
    await saveData();
    render();
  }

  /**
   * 將一個資料夾移入另一個資料夾成為子資料夾
   */
  async function moveFolderIntoFolder(sourceId, targetParentId) {
    if (sourceId === targetParentId) return;
    if (isDescendant(sourceId, targetParentId)) {
      showToast("不能移入自己的子資料夾", true);
      return;
    }
    const srcRes = findFolder(sourceId);
    const tgtRes = findFolder(targetParentId);
    if (!srcRes || !tgtRes) return;

    const folder = srcRes.folder;
    srcRes.parent.splice(srcRes.index, 1);
    tgtRes.folder.children.push(folder);
    expandedFolders.add(targetParentId);
    await saveData();
    render();
    showToast(`已將「${folder.name}」移入「${tgtRes.folder.name}」`);
  }

  /* ====================================================
   * 取得 Gemini 對話標題
   * ==================================================== */
  function getGeminiConversationTitle() {
    const sidebarSelectors = [
      '[aria-selected="true"] .conversation-title',
      '[aria-selected="true"] span',
      '[aria-current="true"] .title',
      '[aria-current="page"] .title',
      'li[aria-selected="true"]',
    ];
    for (const sel of sidebarSelectors) {
      try {
        const text = document.querySelector(sel)?.textContent?.trim();
        if (text && text.length > 1 && text.length < 200) return text;
      } catch (_) {}
    }
    const headerSelectors = ["h1", '[class*="conversationTitle"]', '[class*="chatTitle"]'];
    for (const sel of headerSelectors) {
      try {
        const text = document.querySelector(sel)?.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) return text;
      } catch (_) {}
    }
    const raw = document.title || "";
    const cleaned = raw.replace(/\s*[-|–—]\s*Gemini\s*$/i, "").replace(/^Gemini\s*[-|–—]\s*/i, "").trim();
    return (cleaned && cleaned !== "Gemini" && cleaned.length > 2) ? cleaned : (raw || window.location.href);
  }

  /* ====================================================
   * 渲染
   * ==================================================== */

  function render() {
    const listArea = q(".folder-list-area");
    if (!listArea) return;

    let source = state.folders;

    // 搜尋模式：過濾並展開含結果的資料夾
    if (searchQuery) {
      source = filterTree(state.folders, searchQuery);
    }

    if (source.length === 0) {
      listArea.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📂</div>
          <div class="empty-state-text">${searchQuery ? "找不到符合的結果" : "尚無資料夾<br>在下方輸入名稱新增"}</div>
        </div>`;
      return;
    }

    listArea.innerHTML = renderFolderList(source, 0);
    bindDynamicEvents();
  }

  /**
   * 遞迴過濾資料夾樹（搜尋用）
   */
  function filterTree(folders, q) {
    return folders
      .map((f) => {
        const matchName = f.name.toLowerCase().includes(q);
        const filteredBookmarks = f.bookmarks.filter(
          (b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
        );
        const filteredChildren = filterTree(f.children || [], q);
        if (!matchName && filteredBookmarks.length === 0 && filteredChildren.length === 0) return null;
        return { ...f, bookmarks: matchName ? f.bookmarks : filteredBookmarks, children: filteredChildren };
      })
      .filter(Boolean);
  }

  /**
   * 渲染資料夾陣列 HTML（遞迴）
   * @param {Array} folders
   * @param {number} depth - 巢狀層數（用於 padding 縮排）
   */
  function renderFolderList(folders, depth) {
    return folders.map((f) => renderFolder(f, depth)).join("");
  }

  function renderFolder(folder, depth) {
    const isOpen = expandedFolders.has(folder.id);
    const bCount = folder.bookmarks.length;
    const cCount = (folder.children || []).length;
    const totalCount = bCount + cCount;
    const indent = 10 + depth * 18; // 18px per level

    return `
      <div class="folder-item" data-folder-id="${folder.id}" data-depth="${depth}" draggable="true">
        <div class="folder-header" style="padding-left:${indent}px">
          <span class="folder-toggle ${isOpen ? "open" : ""}">▶</span>
          <span class="folder-icon">📁</span>
          <span class="folder-name" title="${esc(folder.name)}">${esc(folder.name)}</span>
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
            ${renderFolderList(folder.children || [], depth + 1)}
          </div>
          ${folder.bookmarks.map((b) => renderBookmark(folder.id, b, indent + 18)).join("")}
        </div>
      </div>`;
  }

  function renderBookmark(folderId, bookmark, indent = 28) {
    return `
      <div class="bookmark-item"
           data-folder-id="${folderId}"
           data-bookmark-id="${bookmark.id}"
           data-url="${esc(bookmark.url)}"
           title="${esc(bookmark.url)}"
           draggable="true"
           style="padding:6px 8px 6px ${indent}px">
        <span class="bookmark-favicon">💬</span>
        <span class="bookmark-title">${esc(bookmark.title)}</span>
        <div class="bookmark-actions">
          <button class="btn-icon danger btn-delete-bookmark" title="刪除">✕</button>
        </div>
      </div>`;
  }

  /* ====================================================
   * 靜態事件（初始化一次）
   * ==================================================== */
  function bindStaticEvents() {
    q(".btn-close")?.addEventListener("click", closePanel);
    q(".btn-position")?.addEventListener("click", togglePosition);

    const folderInput = q(".new-folder-input");
    q(".btn-add-folder")?.addEventListener("click", () => {
      addFolder(folderInput.value, null);
      folderInput.value = "";
    });
    folderInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { addFolder(folderInput.value, null); folderInput.value = ""; }
    });

    q(".search-input")?.addEventListener("input", (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      render();
    });

    q("#quick-bookmark-btn")?.addEventListener("click", () => {
      chrome.storage.local.get(["folders"], (r) => {
        const all = migrateTree(r.folders || []);
        const flat = flattenFolders(all);
        if (flat.length === 0) { showToast("請先建立一個資料夾！", true); return; }
        if (flat.length === 1) { bookmarkCurrentTab(flat[0].id); }
        else { showFolderPicker(flat); }
      });
    });
  }

  /**
   * 將樹狀資料夾攤平（用於 folder picker）
   */
  function flattenFolders(folders, prefix = "") {
    let result = [];
    for (const f of folders) {
      const label = prefix ? `${prefix} › ${f.name}` : f.name;
      result.push({ id: f.id, name: label });
      result = result.concat(flattenFolders(f.children || [], label));
    }
    return result;
  }

  /* ====================================================
   * 動態事件（每次 render 重綁）
   * ==================================================== */
  function bindDynamicEvents() {
    // --- 資料夾展開/收合 ---
    shadow.querySelectorAll(".folder-header").forEach((header) => {
      header.addEventListener("click", (e) => {
        if (e.target.closest(".folder-actions")) return;
        const id = header.closest(".folder-item")?.dataset.folderId;
        if (!id) return;
        expandedFolders.has(id) ? expandedFolders.delete(id) : expandedFolders.add(id);
        render();
      });
    });

    // --- 書籤此頁 (資料夾的 ＋) ---
    shadow.querySelectorAll(".btn-bookmark-to-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".folder-item")?.dataset.folderId;
        if (id) bookmarkCurrentTab(id);
      });
    });

    // --- 新增子資料夾 ---
    shadow.querySelectorAll(".btn-add-subfolder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const parentId = btn.closest(".folder-item")?.dataset.folderId;
        if (parentId) showAddSubfolderModal(parentId);
      });
    });

    // --- 重命名 ---
    shadow.querySelectorAll(".btn-rename-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".folder-item")?.dataset.folderId;
        const res = findFolder(id);
        if (res) showRenameModal(id, res.folder.name);
      });
    });

    // --- 刪除資料夾 ---
    shadow.querySelectorAll(".btn-delete-folder").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".folder-item")?.dataset.folderId;
        const res = findFolder(id);
        if (res) showDeleteModal("folder", id, res.folder.name);
      });
    });

    // --- 開啟書籤 ---
    shadow.querySelectorAll(".bookmark-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        if (e.target.closest(".bookmark-actions")) return;
        const url = item.dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

    // --- 刪除書籤 ---
    shadow.querySelectorAll(".btn-delete-bookmark").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const item = btn.closest(".bookmark-item");
        const folderId = item?.dataset.folderId;
        const bookmarkId = item?.dataset.bookmarkId;
        const res = findFolder(folderId);
        const bm = res?.folder.bookmarks.find((b) => b.id === bookmarkId);
        if (folderId && bookmarkId) showDeleteModal("bookmark", folderId, bm?.title || "此書籤", bookmarkId);
      });
    });

    // --- 拖放事件 ---
    bindDragEvents();
  }

  /* ====================================================
   * 拖放邏輯
   * ==================================================== */

  function bindDragEvents() {
    // === 資料夾拖拽 ===
    shadow.querySelectorAll(".folder-item[draggable='true']").forEach((item) => {
      const folderId = item.dataset.folderId;

      item.addEventListener("dragstart", (e) => {
        // 只處理直接點到 folder-header 的情況（避免書籤拖拽觸發）
        if (e.target.closest(".bookmark-item")) return;
        dragState = { type: "folder", id: folderId };
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

      // Drop zone: folder header（讓書籤或資料夾移入）
      const header = item.querySelector(".folder-header");
      header?.addEventListener("dragover", (e) => {
        if (!dragState) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        clearDragFeedback();
        header.classList.add("drag-over");
      });

      header?.addEventListener("dragleave", (e) => {
        if (!header.contains(e.relatedTarget)) header.classList.remove("drag-over");
      });

      header?.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        header.classList.remove("drag-over");
        if (!dragState) return;

        if (dragState.type === "bookmark") {
          // 書籤移入此資料夾
          moveBookmarkToFolder(dragState.folderId, dragState.id, folderId);
        } else if (dragState.type === "folder" && dragState.id !== folderId) {
          // 判斷：拖到同層（重新排序）或移入（子資料夾）
          // 根據 drop 位置：上 40% = 前移，中 20% = 移入，下 40% = 後移
          const rect = header.getBoundingClientRect();
          const ratio = (e.clientY - rect.top) / rect.height;

          const srcRes = findFolder(dragState.id);
          const tgtRes = findFolder(folderId);
          if (!srcRes || !tgtRes) return;

          if (ratio < 0.3) {
            reorderFolder(dragState.id, folderId, true);   // 插在前面
          } else if (ratio > 0.7) {
            reorderFolder(dragState.id, folderId, false);  // 插在後面
          } else {
            moveFolderIntoFolder(dragState.id, folderId);  // 移入為子資料夾
          }
        }
        dragState = null;
      });
    });

    // === 書籤拖拽 ===
    shadow.querySelectorAll(".bookmark-item[draggable='true']").forEach((item) => {
      const folderId = item.dataset.folderId;
      const bookmarkId = item.dataset.bookmarkId;

      item.addEventListener("dragstart", (e) => {
        dragState = { type: "bookmark", id: bookmarkId, folderId };
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
        if (!dragState || dragState.type !== "bookmark") return;
        if (dragState.id === bookmarkId) return;
        e.preventDefault(); e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        clearDragFeedback("bookmark");

        const rect = item.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        item.classList.add(before ? "drop-before" : "drop-after");
      });

      item.addEventListener("dragleave", () => {
        item.classList.remove("drop-before", "drop-after");
      });

      item.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        const before = item.classList.contains("drop-before");
        item.classList.remove("drop-before", "drop-after");
        if (!dragState || dragState.type !== "bookmark") return;
        if (dragState.id === bookmarkId) return;
        reorderBookmark(dragState.folderId, dragState.id, folderId, bookmarkId, before);
        dragState = null;
      });
    });
  }

  function clearDragFeedback(type) {
    if (type !== "bookmark") shadow.querySelectorAll(".folder-header.drag-over").forEach((el) => el.classList.remove("drag-over"));
    if (type !== "folder") shadow.querySelectorAll(".bookmark-item.drop-before, .bookmark-item.drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
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

  function refreshBtn(sel, text, cls) {
    const old = q(sel);
    if (!old) return null;
    const fresh = old.cloneNode(false);
    fresh.textContent = text;
    fresh.className = cls;
    old.parentNode.replaceChild(fresh, old);
    return fresh;
  }

  function showAddSubfolderModal(parentFolderId) {
    const parentRes = findFolder(parentFolderId);
    const parentName = parentRes?.folder.name || "";
    q(".modal-title").textContent = "新增子資料夾";
    q(".modal-body").textContent = `在「${parentName}」下新增：`;
    const input = q(".modal-input");
    input.value = "";
    input.style.display = "block";
    q(".modal-overlay").classList.remove("hidden");
    input.focus();

    const confirm = refreshBtn(".btn-modal-confirm", "新增", "btn-modal-confirm");
    const cancel = refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel");

    const doAdd = () => {
      addFolder(input.value, parentFolderId);
      q(".modal-overlay").classList.add("hidden");
    };
    confirm?.addEventListener("click", doAdd);
    cancel?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doAdd();
      if (e.key === "Escape") q(".modal-overlay").classList.add("hidden");
    });
  }

  function showRenameModal(folderId, currentName) {
    q(".modal-title").textContent = "重命名資料夾";
    q(".modal-body").textContent = "請輸入新名稱：";
    const input = q(".modal-input");
    input.value = currentName; input.style.display = "block";
    q(".modal-overlay").classList.remove("hidden");
    input.focus(); input.select();

    const confirm = refreshBtn(".btn-modal-confirm", "確認", "btn-modal-confirm");
    const cancel = refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel");
    const doRename = () => { renameFolder(folderId, input.value); q(".modal-overlay").classList.add("hidden"); };
    confirm?.addEventListener("click", doRename);
    cancel?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doRename();
      if (e.key === "Escape") q(".modal-overlay").classList.add("hidden");
    });
  }

  function showDeleteModal(type, folderId, name, bookmarkId) {
    q(".modal-title").textContent = type === "folder" ? "刪除資料夾" : "刪除書籤";
    q(".modal-body").textContent =
      type === "folder" ? `確定刪除「${name}」及其所有書籤與子資料夾？` : `確定刪除書籤「${name}」？`;
    q(".modal-input").style.display = "none";
    q(".modal-overlay").classList.remove("hidden");

    const confirm = refreshBtn(".btn-modal-confirm", "刪除", "btn-modal-confirm danger");
    const cancel = refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel");
    confirm?.addEventListener("click", () => {
      type === "folder" ? deleteFolder(folderId) : deleteBookmark(folderId, bookmarkId);
      q(".modal-overlay").classList.add("hidden");
    });
    cancel?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
  }

  function showFolderPicker(flatFolders) {
    q(".modal-title").textContent = "選擇目標資料夾";
    q(".modal-input").style.display = "none";
    const body = q(".modal-body");
    body.innerHTML = flatFolders.map((f) => `
      <div data-folder-id="${f.id}" style="
        padding:8px 12px;border-radius:6px;cursor:pointer;margin-bottom:4px;
        background:var(--item-hover);display:flex;align-items:center;gap:8px;
        font-size:14px;color:var(--text-primary);">
        📁 ${esc(f.name)}
      </div>`).join("");
    q(".modal-overlay").classList.remove("hidden");

    body.querySelectorAll("[data-folder-id]").forEach((el) => {
      el.addEventListener("mouseover", () => (el.style.background = "var(--item-active)"));
      el.addEventListener("mouseout", () => (el.style.background = "var(--item-hover)"));
      el.addEventListener("click", () => {
        bookmarkCurrentTab(el.dataset.folderId);
        q(".modal-overlay").classList.add("hidden");
      });
    });

    refreshBtn(".btn-modal-confirm", "取消", "btn-modal-confirm")?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
    refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel")?.addEventListener("click", () => q(".modal-overlay").classList.add("hidden"));
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
   * 訊息監聽
   * ==================================================== */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggle") { togglePanel(); sendResponse({ ok: true }); }
    return true;
  });

  /* ====================================================
   * 初始化
   * ==================================================== */
  loadData().then(() => {
    bindStaticEvents();
    applyStoredPosition();
    render();
  });

})();
