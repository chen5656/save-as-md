# Markdown Vault — Agent Quick-Start

> Chrome Extension (MV3) that polls a Telegram bot and saves URLs as clean local Markdown files via the File System Access API. Zero backend, no build step.

## Setup

```bash
# No install step — load the unpacked extension directly
# 1. Open chrome://extensions, enable Developer mode
# 2. Click "Load unpacked" → select the `src` folder
# 3. Click extension icon → "Start Setup" → paste Telegram bot token → choose save folder
```

## Key Commands

| Action | How |
|--------|-----|
| Reload extension after edits | chrome://extensions → click the reload icon |
| Check service worker logs | chrome://extensions → "Service Worker" → Inspect |
| Check offscreen/popup logs | Right-click extension icon → Inspect Popup |
| Run a manual poll | Popup → "Poll Now" button |
| Test URL save | Popup → paste zone (paste a URL) |

## Architecture

```
background.js          # Service worker — all core logic
content-router.js      # classifyUrl(url, contentType?) → type string
metadata.js            # extractMetadata(html, url) — regex, no DOM
vtt-parser.js          # YouTube/VTT transcript parsing
youtube-handler.js     # handleYouTube(url, dirHandle, settings)
media-handler.js       # handlePdf(), handleDirectMedia(), handleDirectImage()
rss-handler.js         # handleRss(url, dirHandle, settings, xmlText?)
podcast-handler.js     # handlePodcast(url, html, dirHandle, settings)
pages/offscreen/       # DOMParser context (Readability + Turndown)
pages/popup/           # Extension popup UI
pages/settings/        # Settings page
libs/                  # Bundled: Readability.js, turndown.js, turndown-plugin-gfm.js
```

## Configuration

All stored in `chrome.storage.local` — set via the Settings page or background messages:

- `bot_token` — Telegram bot token (required)
- `poll_interval` — seconds between polls (default: 300)
- `include_frontmatter` — YAML frontmatter in .md files (boolean)
- `use_gfm` — GitHub-Flavored Markdown (boolean)
- `file_naming_pattern` — `'YYYY-MM-DD-slug'` | `'slug-YYYY-MM-DD'` | `'slug'`
- `context_menu_enabled` — right-click "Save to Markdown Vault" (boolean)

IndexedDB key `save_dir_handle` — stores the `FileSystemDirectoryHandle`.

## Critical Constraints

- **Classic service worker** (not ESM). All module imports use `importScripts()` at the top of `background.js`. Do NOT use `import`/`export` syntax in any file loaded by the SW.
- **No build step**. Do not introduce npm, bundlers, or transpilers.
- **No external APIs**. No LLMs, no yt-dlp, no third-party services beyond Telegram.
- All handler files (`*-handler.js`, `content-router.js`, etc.) expose globals — they are concatenated into the SW scope via `importScripts()`.

## Agent Boundaries

- DO NOT run `rm -rf` or destructive filesystem commands without explicit user approval.
- DO NOT commit or push to `main` without explicit user approval.
- DO NOT introduce `import`/`export` ESM syntax — the service worker is classic (non-module).
- DO NOT add npm dependencies, build steps, or bundlers.
- DO NOT modify `libs/` bundled files — they are vendored, not managed by npm.
- Prefer reversible changes. Ask before deleting any file.

## Health Check

```bash
# Verify no ESM syntax crept in (would break the classic SW)
grep -r "^import\|^export" ./*.js --include="*.js"
# Expected output: no matches (empty)
```

After editing, reload the extension at `chrome://extensions` and check the Service Worker console for errors.

## Useful Context

- Entry point: `background.js`
- Offscreen messaging: `pages/offscreen/offscreen.js` (handles `parse_html`, `convert_html`, `parse_rss`)
- Message API (popup → SW): see "Message Types" table in `README.md`
- Storage keys reference: see "Storage Keys" table in `README.md`
- GitHub: https://github.com/chen5656/markdown_vault
