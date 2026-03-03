# Markdown Vault — Requirements

## 1. Project Overview

A **fully decentralized, zero-backend Chrome extension** that lets users send any URL from any device to their home computer, automatically converting it to clean Markdown and saving it to a local folder.

**Target users:** AI enthusiasts who are comfortable with tools like Telegram bots but are not developers. Setup must be achievable in under 5 minutes with no code.

**Core philosophy:**
- The developer/maintainer provides **software only** — no server, no database, no hosted service
- Each user owns their own pipeline end-to-end
- Data never touches a third-party server except Telegram (used as a free, personal message queue)

---

## 2. How It Works

```
[Any device] → send URL to personal Telegram bot. ( if other things sent rather than url, append it to a [YYYY-MM-DD].md file )
                        ↓
         Telegram's servers (queue, up to 24 hours)
                        ↓
     [Home PC: Chrome Extension, polling every ~60s]
                        ↓
         Fetch page → Extract article → Convert to Markdown  (fetch page failed -> save error .md with url + error details)
                        ↓
              Save .md file to local folder
                        ↓
              Desktop notification: "Saved: <title>"
        
```

---

## 3. Architecture

### Decentralization Model

| Component | Owner | Notes |
|-----------|-------|-------|
| Telegram bot | Each user | Created via @BotFather, takes 2 minutes |
| Bot token | Each user | Stored only in extension's local storage |
| Message relay | Telegram's servers | Free, not the developer's servers |
| Chrome extension | Open source | Users install from Chrome Web Store or GitHub |
| Saved files | User's local computer | Any folder they choose |
| Database | None | — |
| Developer's server | None | — |

### Polling Mechanism

- Uses `chrome.alarms` API to wake the service worker every **300 seconds**
- On each wake: call Telegram `getUpdates` API with the stored `offset`
- The `offset` (last processed `update_id + 1`) is saved in `chrome.storage.local`
- After processing, update the offset so Telegram clears consumed messages from the queue
- Effective delivery time: **within ~1 minute** of sending a URL

### Content Pipeline (per URL)

1. Fetch the URL with `credentials: 'include'` (extension bypasses CORS and shares the browser's cookie jar — handles most cookie-based paywalls automatically); if Readability extracts no meaningful content, fall back to opening a background tab and injecting a content script to read the live DOM
2. Extract article content with **Mozilla Readability.js**
3. Convert cleaned HTML to Markdown with **Turndown.js** (GitHub-flavored Markdown)
4. Write `.md` file to the user's chosen local folder via **File System Access API**
5. append it to a [YYYY-MM-DD].md file (if file not exist, create it)
6. Show a Chrome desktop notification confirming the save

### Retry Mechanism

Failed fetches are retried with **exponential backoff** before giving up:

- **Max attempts:** 3 (initial + 2 retries)
- **Backoff delays:** 30s → 120s → 300s
- **Retryable errors:** network timeout, connection refused, 5xx server errors
- **Non-retryable errors:** 404, 403, 401 — fail immediately, save error `.md`
- **Retry state** is persisted in `chrome.storage.local` so retries survive service worker sleep cycles; each pending retry is stored as `{ url, attempt, next_retry_at }`
- On each alarm wake, the extension checks for any pending retries whose `next_retry_at` has passed and processes them alongside new messages
- After all 3 attempts fail, save an error `.md` and notify the user

### extension ui

1. refresh now button
2. option buttons to switch between polling every 60s, 180s, 300s, 1800s, 3600s
3. stop button. (stop polling forever until user clicks start button - default start)


---

## 4. Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension framework | Chrome Extension Manifest V3 |
| Background scheduling | `chrome.alarms` API |
| Local persistence | `chrome.storage.local` |
| Message relay | Telegram Bot API (long-polling, no webhook) |
| Article extraction | Mozilla Readability.js |
| HTML → Markdown | Turndown.js |
| Local file saving | File System Access API |
| Notifications | Chrome Notifications API |

No npm server, no Node.js backend, no database, no cloud deployment.

---

## 5. Features

### 5.1 Onboarding Wizard (first-run)

A guided setup flow inside the extension:

1. **Step 1 — Create your Telegram bot**
   - Shows inline instructions: "Open Telegram → message @BotFather → type /newbot → follow prompts → copy your token"
   - Input field: paste bot token
   - "Verify" button: calls `getMe` on Telegram API to confirm token is valid, shows bot username on success

2. **Step 2 — Choose save folder**
   - Button: "Choose Folder" → opens OS folder picker via File System Access API
   - Shows selected folder path
   - Confirms write permission is granted

3. **Step 3 — Done**
   - Summary: "Your bot is active. Send any URL to @YourBotName from any device."
   - Link to test by sending a URL immediately

### 5.2 URL Saving

- Extension polls Telegram every 60 seconds
- Any message sent to the user's bot that contains a URL is processed
- if other things sent rather than url, append it to a [YYYY-MM-DD].md file (if file not exist, create it)
- if image is sent, save it to a folder named [YYYY-MM-DD] and append it to a [YYYY-MM-DD].md file
- Same URL sent twice: saved twice (deduplication is out of scope for v1)
- File naming convention: `YYYY-MM-DD-page-title-slug.md`
- File includes YAML frontmatter:
  ```yaml
  ---
  title: "Page Title"
  url: https://original-url.com
  saved_at: 2026-02-27T14:32:00Z
  source: markdown-vault
  ---
  ```

### 5.3 Offline & Disconnect Handling

#### Normal disconnect (< 24 hours)

- Telegram queues all messages on their servers for up to 24 hours
- When the extension reconnects (browser opens / internet restores), it polls and processes all queued messages in order
- No data loss, no user notification needed — silent recovery

#### Extended disconnect (≥ 24 hours)

When the extension detects it has been offline for 24 hours or more:

- **Show a prominent warning notification** in the extension popup and as a Chrome notification:

  ```
  ⚠️ Disconnected for [X hours / X days]

  Offline period: Feb 24, 2026 09:15 AM — Feb 27, 2026 10:42 AM

  URLs sent to your bot during this window may not have been saved.
  Telegram only queues messages for 24 hours. Any links sent during
  this period should be re-sent to your bot.
  ```

- Display the **exact datetime range** (start = last successful poll timestamp, end = current reconnect timestamp)
- Display the **total duration** in human-readable form (e.g., "3 days 1 hour 27 minutes")
- The warning is dismissible and also accessible from the extension popup under a "Connection History" section
- After the user acknowledges, continue polling normally (change, no matter user acknowledges or not, it will continue polling normally)

#### Tracking disconnect state

- `chrome.storage.local` stores:
  - `last_successful_poll`: ISO timestamp of last successful Telegram API response
  - `last_update_id`: offset for Telegram queue
  - `connection_warnings`: array of past disconnect events (for history view)
  - `pending_retries`: array of `{ url, attempt, next_retry_at }` for URLs awaiting retry

### 5.4 Extension Status Indicator

- Extension icon badge shows connection state:
  - Green dot: polling normally
  - Grey dot: browser just opened, not yet polled
  - Red dot + count: error state or pending warning (e.g., extended disconnect)
- Clicking the extension icon shows a popup with:
  - Bot name and status
  - Last successful poll time
  - Recent saves (last 5 files)
  - Connection history (past disconnect warnings)
  - Settings link

### 5.5 Settings Page

- Change Telegram bot token
- Change save folder
- Toggle Markdown flavors (GitHub-flavored vs plain)
- Toggle frontmatter on/off
- File naming pattern (configurable)
- Polling interval (60s default, adjustable to 60–300s)
- Clear connection history

---

## 6. File Output Format

### Filename

```
YYYY-MM-DD-page-title-slug.md
```

Example: `2026-02-27-understanding-llm-attention-mechanisms.md`

### File Content

```markdown
---
title: "Understanding LLM Attention Mechanisms"
url: https://example.com/article
saved_at: 2026-02-27T14:32:00Z
source: telegram
---

# Understanding LLM Attention Mechanisms

[Cleaned article body in GitHub-flavored Markdown]
```

---

## 7. Distribution

- **Primary:** Chrome Web Store (easy install, auto-update)
- **Secondary:** GitHub releases as a `.zip` for manual install (for users who prefer not to use the store)
- License: Open source (MIT)
- No telemetry, no analytics, no tracking

---

## 8. Out of Scope (v1)

- iMessage integration (no public bot API)
- Slack integration (requires workspace, more complex auth)
- Full-page capture (Readability article extraction only)
- Deduplication of identical URLs
- Semantic search or vector storage
- Mobile app
- Multi-folder routing (all saves go to one folder)
- Backend or shared server of any kind

---

## 9. Edge Cases & Decisions

| Scenario | Behavior |
|----------|----------|
| URL that fails to fetch (timeout, 5xx) | Retry up to 3 times with exponential backoff (30s → 120s → 300s); save error `.md` after all attempts fail |
| URL that fails to fetch (404, 403, 401) | Non-retryable — save error `.md` with url + error details immediately |
| Page with no extractable article | Save raw converted HTML as fallback |
| File already exists with same name | Append `-2`, `-3` to avoid overwrite |
| File System Access permission revoked | Show error in popup, prompt user to re-grant |
| Telegram token invalid/revoked | Show error badge, prompt user to re-enter token |
| Offline > 24 hours | Show disconnect warning with exact datetime range and duration |
| Browser closed | No polling; messages queue on Telegram (up to 24 hours) |
| Paywalled site (cookie-based auth) | Fetch with `credentials: 'include'` — extension shares the browser's cookie jar, so works automatically if user is logged in on this PC |
| Paywalled site (JS-rendered / anti-bot) | If Readability extracts no meaningful content from the raw fetch, open the URL in a background tab, wait for full render, inject a content script to run Readability.js on the live DOM, then close the tab |
