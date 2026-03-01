# Save as MD

A fully decentralized, zero-backend Chrome extension that saves web pages as clean Markdown files. Send any URL to your personal Telegram bot from any device → it gets fetched, extracted, and saved to a local folder on your home computer.

## How It Works

```
Any device → send URL to your Telegram bot
                    ↓
       Telegram's servers (queues up to 24h)
                    ↓
   Home PC: Chrome Extension polls every ~5 min
                    ↓
   Fetch page → Readability extraction → Markdown
                    ↓
         Save .md file to your local folder
                    ↓
      Desktop notification: "Saved: <title>"
```

**Non-URL messages** are appended to a daily `YYYY-MM-DD.md` file.
**Images** are downloaded to a `YYYY-MM-DD/` subfolder and referenced in the daily file.

## Philosophy

- **You own everything** — your bot, your token, your files
- **No backend** — zero servers, zero databases, zero cloud
- **Telegram is just a free queue** — not a third-party service with your data
- **Open source** — MIT licensed, no telemetry, no analytics

## Quick Setup (< 5 minutes)

1. **Install** from Chrome Web Store (or load unpacked from GitHub releases)
2. **Create a Telegram bot**: Message `@BotFather` → `/newbot` → copy your token
3. **Paste token** in the extension wizard → click Verify
4. **Choose a folder** where your `.md` files will be saved
5. **Done** — send any URL to your bot from your phone

## Features

### Core
- Saves URLs as clean Markdown with YAML frontmatter
- Appends non-URL messages to a daily digest file
- Downloads images and references them in the daily file
- File naming: `YYYY-MM-DD-page-title-slug.md`

### Reliability
- Retries failed fetches up to 3 times with exponential backoff (30s → 120s → 300s)
- Non-retryable errors (404, 403, 401) immediately save an error `.md`
- Retry state survives service worker sleep cycles
- Detects extended disconnects (≥ 24h) and shows a warning with exact time range

### Content Extraction
- Fetches with `credentials: include` — shares your browser's cookie jar for paywalled sites
- Uses Mozilla Readability.js for article extraction
- Falls back to a background browser tab for JavaScript-rendered pages
- Converts to GitHub-Flavored Markdown with Turndown.js

### Extension UI
- **Popup**: bot status, last poll time, recent saves, interval controls, stop/start
- **Polling intervals**: 1m, 3m, 5m (default), 30m, 1h
- **Badge**: green (active), grey (stopped), red (error/disconnect warning)
- **Settings page**: change token, folder, GFM toggle, frontmatter toggle, file naming pattern

## File Format

**Individual saved pages:**
```
YYYY-MM-DD-page-title-slug.md
```

Content:
```markdown
---
title: "Page Title"
url: https://original-url.com
saved_at: 2026-02-27T14:32:00Z
source: save-as-md
---

# Page Title

[Cleaned article body in GitHub-Flavored Markdown]
```

**Daily digest** (`YYYY-MM-DD.md`) — for non-URL messages and image references:
```markdown
**10:30 AM** — Check this out later

![Image](./2026-02-27/1234567890.jpg)

**2:15 PM** — Meeting notes: discussed Q1 roadmap
```

## Architecture

| Component | Technology |
|-----------|-----------|
| Extension framework | Chrome Extension Manifest V3 |
| Background scheduling | `chrome.alarms` (wakes every N minutes) |
| Persistence | `chrome.storage.local` + IndexedDB (for folder handle) |
| Message relay | Telegram Bot API, long-polling (`getUpdates`) |
| Article extraction | Mozilla Readability.js |
| HTML → Markdown | Turndown.js + turndown-plugin-gfm |
| DOM parsing | Chrome Offscreen Document API |
| Local file saving | File System Access API |
| Notifications | Chrome Notifications API |

### Why an Offscreen Document?

`DOMParser` is not available in Chrome's service workers (MV3). The extension creates a Chrome [Offscreen Document](https://developer.chrome.com/docs/extensions/reference/offscreen/) to parse HTML using `DOMParser`, run Readability, and convert to Markdown — then passes results back to the service worker.

### Storage Keys (`chrome.storage.local`)

| Key | Type | Description |
|-----|------|-------------|
| `bot_token` | string | Telegram bot token |
| `bot_username` | string | Bot's @username from getMe |
| `setup_complete` | boolean | Whether onboarding is done |
| `last_update_id` | number | Telegram offset (prevents re-processing) |
| `last_successful_poll` | ISO string | Timestamp of last successful API call |
| `pending_retries` | array | `{ url, attempt, next_retry_at }` |
| `connection_warnings` | array | Past disconnect events |
| `recent_saves` | array | Last 20 saved files (for popup display) |
| `is_polling_active` | boolean | Whether polling alarm is running |
| `poll_interval` | number | Seconds between polls |
| `include_frontmatter` | boolean | Add YAML header to files |
| `use_gfm` | boolean | GitHub-Flavored Markdown mode |
| `file_naming_pattern` | string | `YYYY-MM-DD-slug` (default) |
| `has_disconnect_warning` | boolean | Unacknowledged disconnect exists |
| `fs_permission_needed` | boolean | Folder access permission revoked |
| `last_telegram_error` | string | Last Telegram API error message |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Fetch timeout or 5xx error | Retry up to 3× with exponential backoff |
| 404 / 403 / 401 | Immediate failure; saves error `.md` |
| No extractable article content | Background tab fallback; then raw HTML strip |
| File name collision | Appends `-2`, `-3`, etc. |
| FS permission revoked | Badge shows error; popup prompts to re-grant |
| Invalid/revoked Telegram token | Error badge; popup prompts to re-enter |
| Offline < 24h | Silent recovery; Telegram queues messages |
| Offline ≥ 24h | Warning notification with exact time range and duration |
| Paywalled page (cookie auth) | Fetched with `credentials: include` — uses your browser session |
| JS-rendered page | Background tab opened, JS executes, content extracted from live DOM |

## Out of Scope (v1)

- iMessage, Slack, or other messaging integrations
- Full-page capture (article extraction only via Readability)
- Deduplication of identical URLs
- Multi-folder routing
- Semantic search or vector storage
- Mobile app
- Any backend, database, or server

## Development

Load unpacked in Chrome:
1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select this folder

No build step required. All dependencies are bundled in `libs/`.

### Dependencies (bundled, no CDN)

- [`@mozilla/readability`](https://github.com/mozilla/readability) 0.5.0 — article extraction
- [`turndown`](https://github.com/mixmark-io/turndown) 7.2.0 — HTML → Markdown
- [`turndown-plugin-gfm`](https://github.com/mixmark-io/turndown-plugin-gfm) 1.0.2 — GFM tables & strikethrough

## License

MIT
