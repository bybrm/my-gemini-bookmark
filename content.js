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
          <input class="modal-input" type="text" style="display:none"/>
          <div class="modal-tags-container hidden">
            <div class="modal-tags-list"></div>
            <input class="modal-tag-input" type="text" placeholder="輸入標籤 (按 Enter)"/>
          </div>
          <div class="suggested-tags-wrapper hidden"></div>
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
        <div class="setup-title">資料夾精靈設定</div>
        <div class="setup-desc" style="margin-bottom: 20px;">
          請選擇或建立同步資料夾，並設定標籤顏色配置
        </div>

        <details class="setup-accordion" open>
          <summary>📁 選擇同步資料夾</summary>
          <div class="accordion-content">
            <div class="setup-folder-list"></div>
          </div>
        </details>
        
        <details class="setup-accordion">
          <summary>➕ 建立新資料夾</summary>
          <div class="accordion-content">
            <div class="setup-create-row" style="margin-top: 8px;">
              <input class="setup-new-input" type="text" placeholder="新資料夾名稱…" maxlength="50"/>
              <button class="btn-create-root">建立</button>
            </div>
          </div>
        </details>
        
        <details class="setup-accordion">
          <summary>🎨 標籤顏色設定</summary>
          <div class="accordion-content">
            <div class="setup-tags-container"></div>
          </div>
        </details>
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
  /** @type {string|null} 目前選中的資料夾 ID */
  let selectedFolderId = null;
  /** @type {Object} 標籤顏色映射表 { "#標籤": "索引或#hex" } */
  let tagColorMap = {};

  // 1. 精緻對色色盤 (仿 Bootstrap Pastel)
  const TAG_PALETTE = [
    { bg: "#cce5ff", text: "#004085" }, // Primary (淺藍)
    { bg: "#e2e3e5", text: "#383d41" }, // Secondary (灰)
    { bg: "#d4edda", text: "#155724" }, // Success (綠)
    { bg: "#f8d7da", text: "#721c24" }, // Danger (紅)
    { bg: "#fff3cd", text: "#856404" }, // Warning (黃)
    { bg: "#d1ecf1", text: "#0c5460" }, // Info (青)
    { bg: "#eaddf6", text: "#4a148c" }, // Purple (紫)
    { bg: "#fce4ec", text: "#880e4f" }  // Pink (粉)
  ];

  // 2. 取色輔助函式
  function getTagStyle(tagWithHash) {
    if (tagColorMap && tagColorMap[tagWithHash]) {
      const val = tagColorMap[tagWithHash];
      if (/^\d+$/.test(val) && TAG_PALETTE[parseInt(val, 10)]) {
        return TAG_PALETTE[parseInt(val, 10)];
      }
      return { bg: val, text: "#ffffff" }; 
    }

    // 當找不到定義時，使用文字 Hash 自動產生穩定的預設色
    let hash = 0;
    for (let i = 0; i < tagWithHash.length; i++) {
       hash = tagWithHash.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % TAG_PALETTE.length;
    return TAG_PALETTE[index];
  }

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
   * Chrome Bookmarks API Bridge (Proxy to background.js)
   * ==================================================== */
  const bm = new Proxy({}, {
    get: (target, method) => {
      return (...args) => {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ action: "bm_api", method, args }, (response) => {
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }
            if (response && response.error) {
              return reject(new Error(response.error));
            }
            resolve(response ? response.result : undefined);
          });
        });
      };
    }
  });

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
    const setupPage = q(".setup-page");
    setupPage.classList.remove("hidden");
    q(".main-panel").classList.add("hidden");

    // 若原本已有根資料夾，隱藏大 Icon 並加上明顯的「返回」按鈕
    const setupTitleEl = q(".setup-title");
    const setupIconEl = q(".setup-icon");
    
    if (rootFolderId) {
      if (setupIconEl) setupIconEl.style.display = "none";
      if (!q(".btn-setup-back-wrap")) {
        const wrap = document.createElement("div");
        wrap.className = "btn-setup-back-wrap";
        wrap.style.cssText = "display: flex; justify-content: flex-start; width: 100%; margin-bottom: 20px;";
        
        const backBtn = document.createElement("button");
        backBtn.className = "btn-setup-back";
        backBtn.innerHTML = "<span>←</span> <span>返回書籤清單</span>";
        backBtn.style.cssText = "display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; font-size: 13.5px; font-weight: 500; color: #ffffff; background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25); border-radius: 6px; cursor: pointer; transition: all 0.2s;";
        backBtn.onmouseover = () => backBtn.style.background = "rgba(255,255,255,0.25)";
        backBtn.onmouseout = () => backBtn.style.background = "rgba(255,255,255,0.15)";
        
        backBtn.addEventListener("click", () => showMainPanel());
        wrap.appendChild(backBtn);
        setupTitleEl.parentNode.insertBefore(wrap, setupTitleEl);
      }
    } else {
      if (setupIconEl) setupIconEl.style.display = "block";
      const wrap = q(".btn-setup-back-wrap");
      if (wrap) wrap.remove();
    }

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

    // ============================================
    // 標籤顏色設定區塊 (附加到 setup-tags-container)
    // ============================================
    const tagsContainer = q(".setup-tags-container");
    tagsContainer.innerHTML = `
      <div class="tag-settings-list" style="margin-top: 8px; max-height: 180px; overflow-y: auto; display: grid; gap: 8px;">載入中...</div>
      <button class="btn-create-root btn-save-colors" style="margin-top: 14px; width: 100%;">💾 儲存所有標籤顏色</button>
    `;

    // 收集現存所有的不重複標籤
    const allTags = new Set();
    const extractTags = (nodes) => {
      nodes.forEach(n => {
        if (n.url) {
          (n.title.match(/#[^\s]+/g) || []).forEach(t => allTags.add(t));
        }
        if (n.children) extractTags(n.children);
      });
    };
    extractTags(topLevel);

    const tagListEl = q(".tag-settings-list");
    tagListEl.innerHTML = "";
    
    if (allTags.size === 0) {
      tagListEl.innerHTML = `<div style="color:var(--text-muted); font-size:12px;">尚無任何標籤</div>`;
    } else {
      Array.from(allTags).forEach(tag => {
        const row = document.createElement("div");
        row.style.display = "flex"; row.style.alignItems = "center"; row.style.justifyContent = "space-between";
        const style = getTagStyle(tag);
        
        row.innerHTML = `
          <span style="font-size: 13.5px; font-weight: 500; font-family: var(--font); color: var(--text-primary); letter-spacing: 0.3px; max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(tag)}</span>
          <div style="display:flex; align-items:center; gap:6px;">
            <button class="btn-random-color" data-tag="${tag}" title="隨機產生顏色"
              style="background:var(--item-hover); border:1px solid var(--panel-border); border-radius:6px;
                     color:var(--text-secondary); cursor:pointer; font-size:14px; padding:2px 6px;
                     line-height:1.6; transition:all 0.2s;">🎲</button>
            <input type="color" class="tag-color-input" data-tag="${tag}" value="${style.bg}"
              style="border:none; border-radius:4px; padding:0; width:36px; height:28px; cursor:pointer; background:transparent;"/>
          </div>
        `;
        tagListEl.appendChild(row);
        
        // 綁定隨機按鈕：產生隨機顏色並同步更新 color picker
        row.querySelector(".btn-random-color").addEventListener("click", () => {
          const hue = Math.floor(Math.random() * 360);
          const sat = Math.floor(50 + Math.random() * 30); // 50-80%
          const lig = Math.floor(30 + Math.random() * 25); // 30-55%
          // 轉換 HSL → HEX
          const h = hue / 360, s = sat / 100, l = lig / 100;
          const q2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p2 = 2 * l - q2;
          const toHex = (t) => {
            const c = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
            let val;
            if (c < 1/6) val = p2 + (q2 - p2) * 6 * c;
            else if (c < 1/2) val = q2;
            else if (c < 2/3) val = p2 + (q2 - p2) * (2/3 - c) * 6;
            else val = p2;
            return Math.round(val * 255).toString(16).padStart(2, "0");
          };
          const hex = `#${toHex(h + 1/3)}${toHex(h)}${toHex(h - 1/3)}`;
          row.querySelector(".tag-color-input").value = hex;
        });
      });
    }

    q(".btn-save-colors").addEventListener("click", () => {
      let changed = false;
      tagListEl.querySelectorAll(".tag-color-input").forEach(input => {
        const tag = input.dataset.tag;
        // 只有被手動改變過的才覆寫
        if (input.value !== input.getAttribute("value")) {
          if (!tagColorMap) tagColorMap = {};
          tagColorMap[tag] = input.value;
          changed = true;
        }
      });
      if (changed) {
        chrome.runtime.sendMessage({ action: "setTagColorMap", map: tagColorMap }, () => {
          showToast("顏色儲存成功 ✓");
          if (rootFolderId) renderFromBookmarks();
        });
      } else {
        showToast("沒有變更");
      }
    });
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
      const syncStatusEl = q(".sync-status");
      if (syncStatusEl) {
        q(".sync-folder-name").textContent = rootNode.title;
        // 如果選中根目錄 (或預設), 加上 selected
        if (selectedFolderId === null) selectedFolderId = rootFolderId;
        syncStatusEl.classList.toggle("selected", selectedFolderId === rootFolderId);
      }

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

    const isSelected = node.id === selectedFolderId;
    return `
      <div class="folder-item" data-node-id="${node.id}" data-depth="${depth}" draggable="true">
        <div class="folder-header ${isSelected ? 'selected' : ''}" data-node-id="${node.id}" style="padding-left:${isSelected ? indent - 3 : indent}px">
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
   * 渲染單一書籤節點 (支援 Title Hack 標籤)
   * @param {Object} node - Chrome 書籤節點（有 url）
   * @param {string} parentId - 父資料夾 ID
   * @param {number} indent - 左縮排 px
   */
  function renderBookmarkNode(node, parentId, indent = 28) {
    const rawTitle = node.title || node.url || "";
    // 擷取所有開頭為 # 且中間無空白的標籤
    const tags = rawTitle.match(/#[^\s]+/g) || [];
    // 過濾掉標籤後的原始乾淨標題
    const cleanTitle = rawTitle.replace(/#[^\s]+/g, "").trim() || rawTitle;

    const tagsHtml = tags.length > 0 ? 
      `<div class="bookmark-tags-wrapper">
         ${tags.map(t => {
           const style = getTagStyle(t);
           return `<span class="bookmark-tag" data-tag="${t}" style="background-color: ${style.bg}; color: ${style.text}; font-weight: 500;">${esc(t)}</span>`;
         }).join("")}
       </div>` : "";

    return `
      <div class="bookmark-item"
           data-node-id="${node.id}"
           data-parent-id="${parentId}"
           data-raw-title="${esc(rawTitle)}"
           data-url="${esc(node.url || "")}"
           title="${esc(node.url || "")}"
           draggable="true"
           style="padding:6px 8px 6px ${indent}px; align-items:flex-start;">
        <span class="bookmark-favicon" style="margin-top:2px;">💬</span>
        <div style="flex:1; overflow:hidden;">
          <div class="bookmark-title">${esc(cleanTitle)}</div>
          ${tagsHtml}
        </div>
        <div class="bookmark-actions" style="margin-top:2px;">
          <button class="btn-icon btn-edit-bookmark" data-edit-trigger title="點此或雙擊標題編輯">✏️</button>
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
      if (selectedFolderId === nodeId) selectedFolderId = rootFolderId;
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
    const path = window.location.pathname;

    // 1. URL ID 尾碼比對（相容 /app/xxx 和 /gem/xxx/yyy）
    // Gemini 側邊欄 <a href="/app/ID"> 的 href 末段 ID 與 URL 末段相同
    try {
      const urlId = path.split("/").filter(Boolean).pop();
      if (urlId && urlId.length > 4) {
        const link = document.querySelector(`a[href*="${urlId}"]`);
        if (link) {
          const text = link.textContent?.trim();
          if (text && text.length > 1 && text.length < 200) return text;
        }
      }
    } catch (_) {}

    // 2. 側邊欄 .selected class（Gemini 新版 DOM，取代舊的 aria-selected）
    const selectedSels = [
      "a.selected",
      "[class*='conversation'][class*='selected']",
      "nav a.selected",
      "aside a.selected",
      "[role='listitem'] a.selected"
    ];
    for (const sel of selectedSels) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent?.trim();
          if (text && text.length > 1 && text.length < 200) return text;
        }
      } catch (_) {}
    }

    // 3. 舊版 aria-selected 選擇器（保留相容性）
    const ariaSels = [
      '[aria-selected="true"] .conversation-title',
      '[aria-selected="true"] span[dir="auto"]',
      '[aria-selected="true"] span',
      '[aria-current="page"] span[dir="auto"]',
      'a[aria-current="page"] span',
      'li[aria-selected="true"]'
    ];
    for (const sel of ariaSels) {
      try {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          const text = el.textContent?.trim();
          if (text && text.length > 1 && text.length < 200) return text;
        }
      } catch (_) {}
    }

    // 4. Document Title 清理
    const raw = document.title || "";
    const cleaned = raw
      .replace(/\s*[-|–—]\s*Google\s*Gemini\s*$/i, "")
      .replace(/\s*[-|–—]\s*Gemini\s*$/i, "")
      .replace(/^(Google\s*Gemini|Gemini)\s*[-|–—]\s*/i, "")
      .replace(/^(Google\s*Gemini|Gemini)$/i, "")
      .trim();
    if (cleaned && cleaned.length > 1) return cleaned;

    // 5. Fallback: 使用者的第一個提問（截取前50字）
    try {
      const userMsg = document.querySelector('[data-message-author-role="user"], message-content');
      if (userMsg && userMsg.textContent) {
        const text = userMsg.textContent.trim();
        if (text.length > 0) return text.length > 50 ? text.substring(0, 50) + "…" : text;
      }
    } catch (_) {}

    return raw || "未命名對話 (" + new Date().toLocaleString() + ")";
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
              // 跨層或同層排序：移到目標資料夾前/後
              const targetItem = header.closest(".folder-item");
              const siblings = [...targetItem.parentElement.querySelectorAll(":scope > .folder-item")];
              const targetIdx = siblings.indexOf(targetItem);
              
              // 動態取得目標的 parentId (如果是根目錄則用 rootFolderId)
              const parentFolderItem = targetItem.parentElement.closest(".folder-item");
              const targetParentId = parentFolderItem ? parentFolderItem.dataset.nodeId : rootFolderId;

              await bm.move(dragState.id, { 
                parentId: targetParentId,
                index: ratio < 0.3 ? targetIdx : targetIdx + 1 
              });
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

    // === 同步狀態列 (根目錄) 拖放 ===
    const syncStatus = shadow.querySelector(".sync-status");
    syncStatus?.addEventListener("dragover", (e) => {
      if (!dragState) return;
      e.preventDefault(); e.stopPropagation();
      clearDragFeedback("folders");
      syncStatus.classList.add("drag-over");
    });
    
    syncStatus?.addEventListener("dragleave", () => {
      syncStatus.classList.remove("drag-over");
    });
    
    syncStatus?.addEventListener("drop", async (e) => {
      e.preventDefault(); e.stopPropagation();
      syncStatus.classList.remove("drag-over");
      if (!dragState || dragState.id === rootFolderId) return;
      
      try {
        isOurOperation = true;
        await bm.move(dragState.id, { parentId: rootFolderId });
        await renderFromBookmarks();
      } catch (err) {
        console.error("[Gemini精靈] 移至根目錄失敗:", err);
      } finally {
        isOurOperation = false;
        dragState = null;
      }
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
    /**
     * 使用事件委派（event delegation）統一處理 header 所有按鈕點擊
     * 比個別 querySelector 綁定更穩定，不受 DOM 渲染時序影響
     */
    q(".panel-root")?.addEventListener("click", (e) => {
      if (e.target.closest(".btn-settings")) showSetupPage();
      if (e.target.closest(".btn-close"))    closePanel();
      if (e.target.closest(".btn-position")) togglePosition();
    });
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
      
      const targetFolderId = selectedFolderId || rootFolderId;
      bookmarkCurrentTab(targetFolderId);
    });

    // 點擊同步狀態列 -> 選擇根目錄
    const syncStatus = q(".sync-status");
    if (syncStatus) {
      const oldSync = syncStatus.cloneNode(true);
      syncStatus.parentNode.replaceChild(oldSync, syncStatus);
      oldSync.addEventListener("click", () => {
        selectedFolderId = rootFolderId;
        renderFromBookmarks();
      });
    }
  }

  /** 動態事件（每次 renderTree 後呼叫）*/
  function bindDynamicEvents() {
    // 編輯書籤事件（點擊 ✏️ 按鈕 或 雙擊標題）
    const openEditForItem = (item) => {
      const id = item?.dataset.nodeId;
      const rawTitle = item?.dataset.rawTitle;
      if (id) showEditBookmarkModal(id, rawTitle || "");
    };

    shadow.querySelectorAll(".btn-edit-bookmark").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditForItem(btn.closest(".bookmark-item"));
      });
    });

    // 雙擊書籤標題直接開啟編輯（更直覺的 UX）
    shadow.querySelectorAll(".bookmark-item .bookmark-title").forEach((titleEl) => {
      titleEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        openEditForItem(titleEl.closest(".bookmark-item"));
      });
    });

    // 點選標籤過濾
    shadow.querySelectorAll(".bookmark-tag").forEach((tagEl) => {
      tagEl.addEventListener("click", (e) => {
        e.stopPropagation();
        const searchInput = q(".search-input");
        if (searchInput) {
          searchInput.value = tagEl.dataset.tag;
          searchQuery = tagEl.dataset.tag.toLowerCase(); 
          renderFromBookmarks();
        }
      });
    });

    // 點擊資料夾 (選取 + 展開/收合)
    shadow.querySelectorAll(".folder-header").forEach((header) => {
      header.addEventListener("click", (e) => {
        if (e.target.closest(".folder-actions")) return;
        const id = header.dataset.nodeId;
        if (!id) return;
        
        if (e.target.classList.contains("folder-toggle")) {
          expandedNodes.has(id) ? expandedNodes.delete(id) : expandedNodes.add(id);
        } else {
          selectedFolderId = id;
          expandedNodes.add(id);
        }
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

  /**
   * 彈出對話框：編輯書籤標題與現代化標籤
   */
  function showEditBookmarkModal(nodeId, rawTitle) {
    const modal = q(".modal-overlay");
    const container = q(".modal-tags-container");
    
    // 1. 初始化資料：取出尚未包含 # 的純標籤文字
    let tempTags = (rawTitle.match(/#[^\s]+/g) || []).map(t => t.substring(1));
    const cleanTitle = rawTitle.replace(/#[^\s]+/g, "").trim() || rawTitle;

    q(".modal-title").textContent = "編輯書籤";
    
    const body = q(".modal-body");
    body.innerHTML = `
      <label class="modal-label">對話標題</label>
      <input class="modal-input edit-bm-title" type="text" placeholder="對話標題" value="${esc(cleanTitle)}" />
      
      <label class="modal-label" style="margin-top: 16px;">標籤 (以空格分隔)</label>
      <div class="tag-input-container">
        <div class="tag-pills-area"></div>
        <input class="tag-ghost-input" type="text" placeholder="輸入標籤 (按 Enter 建立)"/>
      </div>
    `;

    const titleInput = body.querySelector(".edit-bm-title");
    const tagsListEl = body.querySelector(".tag-pills-area");
    const tagInput = body.querySelector(".tag-ghost-input");
    const inputContainer = body.querySelector(".tag-input-container");
    
    // 隱藏原本模版中的舊生輸入框與容器，避免畫面重複
    const originalInput = q(".modal-input");
    if (originalInput && originalInput !== titleInput) {
      originalInput.style.display = "none";
    }
    
    inputContainer.addEventListener("click", () => tagInput.focus());
    const suggestedTagsWrapper = q(".suggested-tags-wrapper");
    // 不要打開舊版的 container (modal-tags-container)
    if (container) container.classList.add("hidden");

    // 2. 負責渲染藥丸的函式
    const renderModalTags = () => {
      tagsListEl.innerHTML = tempTags.map((tag, idx) => {
        const style = getTagStyle("#" + tag);
        return `
          <div class="tag-pill" style="background:${style.bg}; color:${style.text};">
            ${esc(tag)}
            <span class="btn-remove-tag" data-idx="${idx}">✕</span>
          </div>
        `;
      }).join("");

      // 綁定 ✕ 刪除按鈕
      tagsListEl.querySelectorAll(".btn-remove-tag").forEach(btn => {
        btn.addEventListener("click", (e) => {
          const index = parseInt(e.target.dataset.idx, 10);
          tempTags.splice(index, 1);
          renderModalTags();
        });
      });

      // 渲染推薦標籤 (從 tagColorMap 中過濾掉已經在這個書籤的)
      if (tagColorMap && Object.keys(tagColorMap).length > 0) {
        const availableTags = Object.keys(tagColorMap)
          .map(k => k.replace(/^#/, ""))
          .filter(t => !tempTags.includes(t));
        
        if (availableTags.length > 0) {
          suggestedTagsWrapper.innerHTML = `
            <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 6px;">歷史標籤</div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              ${availableTags.map(tag => {
                const style = getTagStyle("#" + tag);
                return `<span class="suggested-tag-pill" data-tag="${esc(tag)}" style="background:${style.bg}; color:${style.text}; font-size: 11px; padding: 2px 6px; border-radius: 10px; cursor: pointer; transition: opacity 0.2s;">+ ${esc(tag)}</span>`;
              }).join("")}
            </div>
          `;
          suggestedTagsWrapper.classList.remove("hidden");
          
          suggestedTagsWrapper.querySelectorAll(".suggested-tag-pill").forEach(pill => {
            pill.addEventListener("click", (e) => {
              const tagToAdd = e.target.dataset.tag;
              if (tagToAdd && !tempTags.includes(tagToAdd)) {
                tempTags.push(tagToAdd);
                renderModalTags();
              }
            });
          });
        } else {
          suggestedTagsWrapper.classList.add("hidden");
        }
      } else {
        suggestedTagsWrapper.classList.add("hidden");
      }
    };
    renderModalTags();

    // 3. 監聽 Tag Input 的 Enter 與 逗號
    const onTagKeydown = (e) => {
      // 避免中文輸入法組字時干擾，檢查 isComposing
      if (e.isComposing) return;
      
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        // 取得內容，去除空白並強制濾掉最前面的 #
        let newTag = e.target.value.trim().replace(/^#+/, "");
        if (newTag && !tempTags.includes(newTag)) {
          tempTags.push(newTag);
          e.target.value = "";
          renderModalTags();
        }
      }
      // 防錯機制：如果使用者打出 #，自動阻止
      if (e.key === "#") { e.preventDefault(); }
    };
    
    // 每次呼叫時先清除上次的 listener 避免重複綁定
    const newTagInput = tagInput.cloneNode(true);
    tagInput.parentNode.replaceChild(newTagInput, tagInput);
    const currentTagInput = body.querySelector(".tag-ghost-input");
    currentTagInput.addEventListener("keydown", onTagKeydown);
    // 貼上文字時的防錯（過濾 #）
    currentTagInput.addEventListener("input", (e) => {
      if (e.target.value.includes("#")) {
        e.target.value = e.target.value.replace(/#/g, "");
      }
    });

    modal.classList.remove("hidden");
    titleInput.focus();

    return new Promise((resolve) => {
      const confirmBtn = refreshBtn(".btn-modal-confirm", "儲存", "btn-modal-confirm");
      const cancelBtn = refreshBtn(".btn-modal-cancel", "取消", "btn-modal-cancel");

      const closeAction = () => {
        modal.classList.add("hidden");
        container.classList.add("hidden");
        suggestedTagsWrapper.classList.add("hidden");
        resolve(null);
      };

      const doSave = async () => {
        let finalTitle = titleInput.value.trim();
        
        // 【新增防呆】：如果使用者把字打在 input 裡卻忘記按 Enter 直接按儲存，自動視為有效標籤
        let pendingTag = currentTagInput.value.trim().replace(/^#+/, "");
        if (pendingTag && !tempTags.includes(pendingTag)) {
          tempTags.push(pendingTag);
        }
        
        // 4. 重組標籤與建立新色碼
        if (tempTags.length > 0) {
          const finalTagsWithHash = tempTags.map(t => "#" + t);
          finalTitle = `${finalTitle} ${finalTagsWithHash.join(" ")}`; 
          
          let mapUpdated = false;
          if (!tagColorMap) tagColorMap = {};
          
          finalTagsWithHash.forEach(t => {
            if (!tagColorMap[t]) {
              // 透過字串特徵獲得穩定的對應顏色索引
              let hash = 0;
              for (let i = 0; i < t.length; i++) {
                hash = t.charCodeAt(i) + ((hash << 5) - hash);
              }
              const index = Math.abs(hash) % TAG_PALETTE.length;
              tagColorMap[t] = index.toString();
              mapUpdated = true;
            }
          });
          if (mapUpdated) {
            chrome.runtime.sendMessage({ action: "setTagColorMap", map: tagColorMap });
          }
        }

        if (!finalTitle) return closeAction();

        try {
          isOurOperation = true;
          await bm.update(nodeId, { title: finalTitle });
          await renderFromBookmarks();
          showToast("更新成功 ✓");
        } catch (e) {
          showToast("更新失敗", true);
        } finally {
          isOurOperation = false;
        }
        closeAction();
      };

      confirmBtn?.addEventListener("click", doSave);
      cancelBtn?.addEventListener("click", closeAction);
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
   * 訊息監聽（來自 background.js）
   * ==================================================== */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "toggle") { 
      togglePanel(); 
      sendResponse({ ok: true }); 
    }
    
    if (request.action === "bm_changed") {
      if (!isOurOperation && rootFolderId && isPanelVisible) {
        renderFromBookmarks();
      }
    }
    return true;
  });

  /* ====================================================
   * 初始化
   * ==================================================== */
  async function init() {
    bindStaticEvents();
    applyStoredPosition();
    
    // 透過代理從 storage.sync 取得標籤顏色表
    tagColorMap = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getTagColorMap" }, (res) => {
        resolve(res?.result || {});
      });
    });

    await loadRootFolder();

    if (rootFolderId) {
      await showMainPanel();
    } else {
      await showSetupPage();
    }
  }

  init();
})();
