# Chrome MV3 Service Worker Memory & Permission Loss

## Problem

The Markdown Vault Chrome extension began showing "Folder Access Needed" prompts every 1-2 minutes, requiring the user to re-grant folder access repeatedly. The previous version of the extension ran for 10+ minutes without any such prompt.

## Root Cause

Large inline functions passed to `chrome.scripting.executeScript({ func: ... })` are **parsed and held in memory as part of the Service Worker (SW)**. When ~350 lines of X/Twitter GraphQL extraction code (including a Bearer token string, large JSON feature-flag objects, and multiple API call logic) were added inline, the SW's memory footprint grew significantly.

Chrome MV3 aggressively manages SW lifecycle:
- SWs are terminated after ~30 seconds of inactivity
- SWs are terminated **sooner** when memory pressure is higher
- A larger SW script = higher baseline memory = more aggressive termination

When the SW is terminated and restarted:
- `FileSystemDirectoryHandle` objects stored in IndexedDB lose their permission grants
- `queryPermission()` returns `'prompt'` instead of `'granted'`
- The extension must ask the user to re-grant folder access

The backup version (without the large GraphQL code) had a small enough SW footprint that Chrome rarely terminated it during normal use, so permissions persisted.

## How We Confirmed It

A binary-search approach on the backup version:
1. Added small utility functions (~20 lines) → **no issue**
2. Added the full GraphQL extraction block (~350 lines inline) → **permission loss returned**

This definitively proved the inline code size was the trigger.

## The Fix

Replaced `chrome.scripting.executeScript({ func: <large function> })` with `{ files: ['extractor.js'] }`.

**Before (runs in SW process):**
```js
const results = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: async () => {
    // ~275 lines of GraphQL API calls, Bearer tokens, JSON configs...
    return { title, content };
  }
});
const data = results?.[0]?.result;
```

**After (runs in tab process):**
```js
// Step 1: Inject file — code runs in the web page's process, not the SW
await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  files: ['x-article-extractor.js'],  // sets window.__mvArticleResult
});

// Step 2: Read the result back with a tiny inline function
const results = await chrome.scripting.executeScript({
  target: { tabId: tab.id },
  func: () => window.__mvArticleResult,
});
const data = results?.[0]?.result;
```

Four files were extracted:

| File | Lines | Purpose |
|------|-------|---------|
| `x-article-extractor.js` | 271 | X/Twitter Article & Note Tweet via GraphQL API |
| `x-tweet-extractor.js` | 151 | X/Twitter Tweet DOM extraction |
| `x-article-dom-extractor.js` | 43 | Article DOM fallback extraction |
| `xhs-extractor.js` | 33 | Xiaohongshu content extraction |

Result: `background.js` went from ~2301 lines to ~1819 lines (−21%).

## What to Avoid

### 1. No large inline functions in `executeScript({ func: })`

Any function passed via `func:` is serialized and parsed as part of the SW bundle. Keep inline functions to **< 20 lines**. If the logic is larger, put it in a separate `.js` file and use `files:`.

### 2. No large string literals in the SW

Bearer tokens, JSON blobs, base64 data, long templates — these all inflate SW memory. Move them to:
- Separate `.js` files injected via `files:`
- `chrome.storage` (read on demand)
- External JSON files loaded via `fetch(chrome.runtime.getURL(...))`

### 3. No unnecessary global state in the SW

Every variable at module scope persists for the SW's lifetime. Prefer local variables inside event handlers. Clean up references when done.

### 4. Keep the SW as lean as possible

The SW should be an **orchestrator** — it receives events, dispatches work to content scripts or offscreen documents, and stores results. Heavy computation and large data structures belong elsewhere.

### 5. Test with SW lifecycle in mind

After any significant code addition to `background.js`:
- Open `chrome://serviceworker-internals/`
- Verify the SW terminates and restarts cleanly
- Confirm `FileSystemDirectoryHandle` permissions survive a restart cycle
- Monitor memory usage in Chrome Task Manager (Shift+Esc)

## General Rule

> If a function is too big to read in one screen, it's too big to inline in `executeScript({ func: })`.
