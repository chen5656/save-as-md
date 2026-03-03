# Markdown Vault

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![Platform](https://img.shields.io/badge/platform-Chrome%20MV3-green) ![No Build](https://img.shields.io/badge/build-none-lightgrey)

> **Send any URL to your Telegram bot — it gets saved as clean Markdown on your computer.** Zero backend, no build step, your data stays local.

---

## Overview

Markdown Vault is a Chrome Extension (Manifest V3) that turns your Telegram bot into a personal read-later inbox. Send a URL from any device; the extension polls Telegram on a schedule, fetches the page, extracts readable content with Mozilla Readability, converts it to Markdown with Turndown, and writes the file directly to a local folder via the File System Access API. No server. No cloud sync. No account.

## Features

- **Telegram-driven capture** — send URLs from any device to your bot; the extension polls and processes them automatically
- **Clean Markdown output** — Mozilla Readability + Turndown strip boilerplate; YAML frontmatter optional
- **Rich content support** — YouTube captions, podcast transcripts (Podcasting 2.0), RSS feeds (up to 50 items), PDFs, audio/video, and direct images
- **JS-rendered page fallback** — if Readability fails, injects a script into a background tab and retries common CSS selectors
- **Local-first paste zone** — paste a URL, screenshot, or plain text directly in the popup to save on the spot
- **Right-click context menu** — "Save to Markdown Vault" on any page or link (toggleable in Settings)
- **Daily log** — non-URL Telegram messages and Telegram images append to a `YYYY-MM-DD.md` daily file
- **Retry logic** — up to 3 retries with exponential back-off (30 s → 120 s → 300 s); state survives service worker restarts

## Installation

No build step. Load the extension directly from source.

```bash
# 1. Clone the repo
git clone https://github.com/chen5656/markdown_vault.git
cd markdown_vault
```

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `src` folder
4. Click the extension icon → **Start Setup**
5. Paste your Telegram bot token and pick a local save folder

**Creating a Telegram bot:** message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token.

## Usage

**Saving a URL from your phone:**
```
Send any URL in a Telegram message to your bot
→ extension polls on schedule (default: every 5 min)
→ .md file appears in your chosen folder
```

**Saving from the browser (popup paste zone):**
- Open the extension popup and paste a URL, image, or text — saves immediately, no confirm button needed.

**Right-click save:**
- Right-click any page or link → **Save to Markdown Vault**

**Manual poll:**
- Open popup → click **Poll Now**

## Configuration

All settings are stored in `chrome.storage.local` and managed via the Settings page.

| Key | Default | Description |
|-----|---------|-------------|
| `poll_interval` | `300` | Seconds between Telegram polls |
| `include_frontmatter` | `true` | Add YAML frontmatter to saved files |
| `use_gfm` | `true` | GitHub-Flavored Markdown (tables, strikethrough) |
| `file_naming_pattern` | `YYYY-MM-DD-slug` | Output filename format |
| `context_menu_enabled` | `true` | Show right-click "Save to Markdown Vault" item |

## File Output

| Content type | Output |
|-------------|--------|
| Web article | `YYYY-MM-DD-slug.md` |
| YouTube | `YYYY-MM-DD-slug.md` with captions transcript |
| RSS feed | `YYYY-MM-DD-slug.md` with up to 50 items |
| PDF / audio / video | `YYYY-MM-DD/<filename>` + companion `YYYY-MM-DD-slug.md` metadata |
| Telegram image | `YYYY-MM-DD/<date>-<timestamp>.<ext>` |
| Telegram text | appended to `YYYY-MM-DD.md` |

## For AI Agents

This project ships an [`AGENT.md`](./AGENT.md) file — a compact quick-start guide optimised for AI coding assistants (Claude Code, Cursor, Windsurf, etc.).

To onboard your agent:

```
Read the file AGENT.md for setup instructions and project conventions.
```

It covers: architecture map, setup, key constraints (classic SW — no ESM, no npm), configuration reference, safety boundaries, and a health-check command.

## Contributing

1. Fork the repo and create a branch from `main`
2. Keep the no-build, no-npm constraint — all dependencies must be bundled in `libs/`
3. Do not use ESM `import`/`export` — the service worker is a classic (non-module) SW
4. Open a PR with a clear description of what changed and why

## License

No license file present — all rights reserved by the author. Contact the repository owner for usage permissions.
