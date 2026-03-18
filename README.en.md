# ✨ Gemini Folder Wizard (my-gemini-bookmark)

> 📂 Turn your Gemini conversations into your personal knowledge base

> A privacy-first bookmark tool built to solve the chaos of unmanageable Gemini conversations

[繁體中文](README.md) | **English**

---

## 🧠 Why I Built This

After months of using [Gemini](https://gemini.google.com), I hit a very practical wall:

> ❗ Conversations kept piling up, but there was no way to organize or find them later

Common pain points:
* Can't find important past conversations
* No way to categorize by topic (Project / Tech / Notes / Ideas)
* No structure to build a personal knowledge tree
* Always having to search or re-ask the same questions

So I built this tool with one simple goal:

> ✅ **Make Gemini conversations manageable — like a file explorer**

---

## 🎯 Design Philosophy

This project is more than just "bookmarks." It's built around three core principles:

* ☁️ **Cross-device sync**: Deep integration with Chrome's native bookmarks API. Just sign into your Google account and your entire folder tree syncs automatically.
* 🧩 **Structured management**: Multi-level nested folders to build your own knowledge tree.
* ⚡ **Non-intrusive integration**: Doesn't touch Gemini's UI or depend on internal DOM elements.

---

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Features

* ☁️ **Native Bookmark Sync**: Fully powered by Chrome's `bookmarks` API for stable Google account sync.
* 📁 **Multi-level Folders**: Unlimited nested subfolder support.
* 🎯 **One-Click Quick Bookmark**: Select a folder, then hit "Bookmark" to save instantly — no extra dialogs.
* 🏷️ **Tokenized Tag System**:
  * In the edit modal, type a tag and press `Enter` or `,` to create a colorful pill tag.
  * Tags are stored using the **Title Hack** — appended as `#tagname` in the bookmark title.
  * Tag colors are auto-assigned via string hashing for deterministic, consistent colors on first use.
  * Previously used tags appear as quick-add suggestions when the edit modal opens.
* 🎨 **Tag Color Settings**:
  * In the settings page, customize each tag's color.
  * Click 🎲 **Random** to auto-generate a quality-filtered random color, or use the color picker for precision.
  * Hit **💾 Save All Tag Colors** to apply and sync changes to the bookmark list.
* 📐 **Modern Typography**: Google Sans / PingFang TC font stack with Anti-aliasing. UI font sizes unified to 14–16px for effortless reading.
* 🔍 **Real-time Search**: Instantly filter bookmarks by title, folder name, or `#tag`.
* 🖱️ **Drag & Drop Sorting**:
  * Freely reorder folders and bookmarks vertically.
  * Drag into another folder to make it a subfolder.
  * Drag to the top status bar to move back to the root level.
* 🤖 **Smart Title Extraction**: Multi-level fallback to auto-detect the most accurate Gemini conversation title.
* ↔️ **Panel Side Switch**: Toggle the panel between the left and right side of the screen.
* ⚙️ **Accordion Settings Page**: Settings are organized in collapsible sections: Choose Sync Folder, Create New Folder, and Tag Color Settings.
* 🛡️ **Shadow DOM Isolation**: Doesn't inject into Gemini's page DOM — no version coupling.

---

## Installation (Developer Mode)

1. Clone this repository

   ```bash
   git clone https://github.com/bybrm/my-gemini-bookmark.git
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (top-right toggle)

4. Click **"Load unpacked"** and select the `my-gemini-bookmark` folder

5. Go to [gemini.google.com](https://gemini.google.com) and click the ✨ icon in the toolbar

---

## How to Use

### 📌 Initial Setup
On first launch, the panel will prompt you to **select a sync folder**.
Choose an existing Chrome bookmark folder as your knowledge base root, or type a name at the bottom to create a new one. All operations will be scoped to that folder.

### 🏷️ Using Tags

1. Hover over any bookmark in the list and click ✏️ **Edit**.
2. In the "Tags" input field, type a tag and press `Enter` or `,` to convert it to a colored pill.
3. Click ✕ on a pill to remove it; click a suggested historical tag to re-add it.
4. Click **Save** — tags are appended as `#tagname` to the bookmark title.

### ⌨️ Quick Reference

| Action | Description |
| --- | --- |
| **Click ✨ toolbar icon** | Open / Close the floating panel |
| **Click a folder name** | Set it as the **active target** (highlighted) and expand its contents |
| **Click the top status bar** | Deselect subfolder, reset target to **root** |
| **"Bookmark this conversation" button** | One-click save to the **active** folder (defaults to root if none selected) |
| **Folder ＋ button** | (Visible on hover) Force-bookmark to that specific folder regardless of selection |
| **Drag items** | Top/bottom 30%: reorder · Middle 40%: move into subfolder · Drag to status bar: move to root |
| **⚙️ Settings button** | Open settings to reselect the sync folder or manage tag colors |

---

## Technical Architecture

```
my-gemini-bookmark/
├── manifest.json    # Manifest V3
├── background.js    # Service Worker (bookmarks API proxy, tagColorMap storage, event broadcast)
├── content.js       # Shadow DOM panel + proxy messaging + Tokenized Tag Input
├── panel.css        # Panel styles (injected into Shadow Root, Accordion UI, Tag Pill animations)
└── icons/           # Extension icons
```

**Key Technical Details:**
* **Chrome Bookmarks API Bridge**: MV3 content scripts can't access the bookmarks API directly. This project implements a proxy pattern — `content.js` sends actions to `background.js`, which executes them and broadcasts events to keep all tabs in sync.
* **Title Hack**: Tags are stored as `#tagname` appended to the bookmark title — no external database needed, fully compatible with Chrome's native sync.
* **Tag Color Map**: Stored in `chrome.storage.sync`. If no color is set, a stable color is auto-assigned from the palette via string hashing.
* Chrome Extension Manifest V3
* Shadow DOM style isolation with Event Delegation

---

## Permissions

| Permission | Purpose |
| --- | --- |
| `bookmarks` | **Core**: Read/write Chrome bookmarks for cloud sync |
| `storage` | Store panel position, tag colors, and root folder ID |
| `tabs` | Read current tab URL for background script broadcasts |
| `activeTab` | Access the current Gemini tab to extract the title |
| `host_permissions: gemini.google.com` | Restrict Content Script to the Gemini domain only |

---

## License

MIT © [bybrm](https://github.com/bybrm)
