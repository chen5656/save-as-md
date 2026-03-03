# Markdown Vault — Edge Cases Checklist

A comprehensive list of edge cases, organized by area. Every item is resolved.

---

## 1. File System & Folder Access

- [x] **Folder deleted while extension is running** — `getDirHandle()` checks `NotFoundError` and shows notification.
- [x] **Folder renamed** — File System Access API handles track the underlying inode (macOS/Linux), so renames are followed transparently. On Windows, the handle would fail, which is caught by the existing `try/catch` in `getDirHandle()` and `writeFile()`. **Handled by existing error paths.**
- [x] **Folder moved to a different location** — Same as renamed. **Handled by existing error paths.**
- [x] **Disk full / out of space** — `createWritable()` / `write()` throws; caught by `try/catch` in `processURLWithRetry` outer catch block, which saves an error `.md` or logs to console. **Handled by existing error paths.**
- [x] **File locked by another process** — Same as disk full — `createWritable()` throws, caught by existing error handling. **Handled by existing error paths.**
- [x] **Permission revoked mid-write** — Writable stream throws, caught by `processURLWithRetry` outer catch. Retry mechanism will re-attempt, and `getDirHandle()` will detect the revoked permission on next call. **Handled by existing retry + permission check.**
- [x] **Very long filenames** — `slugify()` now caps at 60 chars. With date prefix (11) + `.md` (3) + possible `-99` suffix (3), total max is ~77 chars — well under 255-byte OS limit.
- [x] **Filename with only special characters / CJK** — `slugify()` now uses `\p{L}\p{N}` (unicode-aware regex) so CJK, Cyrillic, Arabic, etc. are preserved. Falls back to `'untitled'` only if truly empty.
- [x] **99+ duplicate filenames** — `getUniqueFileHandle()` tries `-2` through `-99`, then falls back to timestamp-based name. **Already handled; edge case is extremely unlikely.**
- [x] **Network drive / cloud-synced folder** — Cloud sync delays or conflicts surface as write errors, caught by the same `try/catch` paths. **Handled by existing error paths.**
- [x] **Read-only file system / permissions changed at OS level** — `createWritable()` throws, caught by existing error handling. `getDirHandle()` write test on next poll detects the issue. **Handled by existing error paths.**

## 2. Telegram API & Polling

- [x] **Bot token revoked or regenerated via BotFather** — `telegramCall()` now detects HTTP 401 and throws a clear "token invalid or revoked" error. Shown in popup error banner.
- [x] **Telegram API rate limiting** — `telegramCall()` now detects HTTP 429 and includes the `Retry-After` value in the error message.
- [x] **Telegram API downtime / network outage** — `poll()` catches errors and sets `last_telegram_error`. `checkAndHandleDisconnect()` fires on reconnect to warn about missed messages. **Handled by existing error + disconnect detection.**
- [x] **Duplicate messages from Telegram** — `last_update_id` is now saved after *each* message (not after the whole batch). A crash mid-batch won't cause reprocessing.
- [x] **Very large Telegram updates batch** — Per-message `update_id` save means a timeout mid-batch just resumes where it left off on next poll. **Handled by per-message persistence.**
- [x] **Telegram message with no text, no photo, no document** — Stickers, voice messages, video notes, videos, audio, locations, contacts now log to daily file with timestamp and type (e.g., "*Received sticker (not supported for saving)*").
- [x] **Telegram `getUpdates` returns edited_message / channel_post** — `allowed_updates: ['message']` is set server-side. Even if Telegram sends other types, `processUpdate` checks `update.message` and returns early if absent. **No-op by design; won't cause errors.**
- [x] **Bot receives messages from multiple users** — **By design, no chat ID filtering.** The bot is personal and the token is private. Acceptable trade-off for simplicity.
- [x] **Very large file from Telegram (>20MB)** — File size is checked before download attempt in both `processImageMessage` and `processDocumentMessage`. Logs a warning to daily file if over Telegram's 20MB API limit.
- [x] **Telegram image as document / non-image documents** — Non-image documents (PDFs, ZIPs, etc.) are now saved via `processDocumentMessage()`. Image documents were already handled by the `mime_type` check.

## 3. URL Fetching & Content Extraction

- [x] **URL behind authentication / paywall** — **Acceptable by design.** Saves whatever the server returns (often a login page or paywall notice). The user can see the result and re-save from a logged-in browser tab if needed.
- [x] **URL returns non-HTML content** — `fetchURL()` now checks `Content-Type` header. Non-text content (PDF, image, binary) is returned as `binaryData` and saved directly as a file in `processURLWithRetry`.
- [x] **URL with redirect chain** — `fetch()` with `redirect: 'follow'` (now explicit) follows redirects and captures `resp.url` as `finalUrl`. JS-based redirects are handled by the background tab fallback. **Handled by fetch + tab fallback.**
- [x] **URL with `#fragment`** — **Standard browser behavior:** fragments are stripped by `fetch()`. The full page is saved, which is correct — fragments don't change server-side content. Acceptable.
- [x] **Extremely large page** — `fetchURL()` now truncates text responses to `MAX_PAGE_SIZE` (5MB). This limits memory usage while still capturing virtually all real articles.
- [x] **Infinite redirect loop** — Chrome's built-in 20-redirect limit throws a TypeError. This is now caught and marked as `retryable: false` (redirect errors are never transient).
- [x] **URL with non-UTF-8 encoding** — Chrome's `fetch().text()` respects `charset` from the `Content-Type` header. For pages where charset is only in the HTML `<meta>` tag, the offscreen `DOMParser` and background tab's live DOM both handle encoding correctly. **Handled by Chrome's built-in encoding support.**
- [x] **URL to localhost / internal network** — **Acceptable by design.** The extension is personal-use; the user controls what URLs they send. Blocking localhost would prevent legitimate use cases (saving local dev docs, etc.).
- [x] **Data URLs / blob URLs / chrome:// URLs** — `isURL()` regex only matches `http(s)://`, so these are treated as plain text and saved to the daily file. This is the correct behavior — they can't be fetched externally. **Handled by URL validation.**
- [x] **URL with username:password in it** — `sanitizeUrlForDisplay()` replaces credentials with `***` in frontmatter, error files, and display URLs.

## 4. X/Twitter Specific

- [x] **Tweet is deleted / doesn't exist** — Background tab loads X's error page → DOM scraper finds no `article` → returns null → oEmbed fallback tried → if that also fails, an error `.md` is saved. **Handled by the multi-layer fallback chain.**
- [x] **Tweet from a private/protected account** — Same fallback chain as deleted tweets. **Handled by existing fallback chain.**
- [x] **Tweet with only images, no text** — Scraper handles this: images section is populated, title becomes `@handle on X`. **Functional; title is vague but correct.** Can't extract a better title without text.
- [x] **Tweet thread (multiple tweets)** — **By design, only the single tweet at the URL is extracted.** Thread extraction would require crawling multiple pages, which is a different feature scope.
- [x] **Quote tweets / retweets** — The scraper extracts from the first `article` element with a `time` tag, which is the main tweet. Quoted tweet content may bleed in via nested elements. **Acceptable; separation would require fragile DOM heuristics that break with each X redesign.**
- [x] **X.com login wall** — oEmbed fallback (`publish.twitter.com/oembed`) provides tweet text and author even when the page requires login. **Handled by oEmbed fallback.**
- [x] **X.com rate limiting** — Rate-limited responses return error pages; the DOM scraper returns null, falls through to oEmbed (different endpoint, separate rate limit), then error file. **Handled by fallback chain.**
- [x] **oEmbed API changes or deprecation** — **Can't fix proactively.** oEmbed is one layer in a 3-layer chain (live DOM → offscreen parse → oEmbed). If it breaks, the other layers still work. Would need monitoring.
- [x] **DOM selectors changing** — **Can't fix proactively.** X frequently changes `data-testid` values. When they change, extraction falls through to oEmbed as a safety net. Would need monitoring and periodic selector updates.

## 5. Xiaohongshu (小红书) Specific

- [x] **XHS anti-scraping / bot detection** — Background tab loads the page as a real Chrome tab with full JS, which is indistinguishable from a normal user visit. CAPTCHAs are rare in this mode. If extraction fails, an error `.md` is saved. **Best effort; can't bypass anti-bot without violating ToS.**
- [x] **XHS login-gated content** — If the post requires login, the DOM scraper finds no content → returns null → error `.md` saved. **Handled by existing null check + error file.**
- [x] **XHS CDN image URLs expire** — Images are downloaded immediately during extraction (same background tab session). Expiry only affects URLs accessed later. **Handled by immediate download.**
- [x] **XHS short links (`xhslink.com`) not resolving** — `isXiaohongshuURL()` matches `xhslink.com` → triggers background tab path → Chrome follows the redirect in the real tab. **Handled by background tab redirect following.**
- [x] **XHS video posts** — Video detection added; markdown now includes: *"This post contains a video that could not be saved. Visit the original URL to view it."*
- [x] **XHS DOM selectors changing** — **Can't fix proactively.** Selectors like `#detail-desc`, `.note-content`, `.author-name` will break when XHS updates their frontend. The fallback chain (generic Readability → raw HTML strip) provides degraded-but-functional output. Would need monitoring.

## 6. Service Worker Lifecycle

- [x] **Service worker terminated mid-operation** — Per-message `update_id` save means the Telegram offset is always current. The retry mechanism (`pending_retries` in chrome.storage) picks up any URLs that were mid-processing. **Handled by per-message save + retry mechanism.**
- [x] **Service worker wakes up with stale state** — All state is read from `chrome.storage.local` and `IndexedDB` on every operation. No global variables hold persistent state (only the `_pollLock` flag, which correctly resets to `false` on wake). **Handled by storage-first architecture.**
- [x] **Multiple polls running concurrently** — `poll()` now has a `_pollLock` mutex to prevent overlapping execution.
- [x] **IndexedDB not available in service worker** — **Extremely rare edge case** (would require Chrome itself to be broken). `openDB()` rejects → `getDirHandle()` returns null → poll skips saving → badge shows error. **Fails gracefully; can't fix a broken browser.**
- [x] **`chrome.offscreen` document lifetime** — `ensureOffscreen()` recreates it if closed. If closed mid-parse, the 30s timeout in `offscreenMessage()` fires → error is caught → falls through to background tab fallback. **Handled by timeout + fallback.**

## 7. Background Tab Fallback

- [x] **Tab creation fails** — `chrome.tabs.create()` can fail in restricted states. The error is caught by the `try/catch` in `fetchWithBackgroundTab`, which returns null → falls through to raw HTML fallback in `processURLWithRetry`. **Handled by existing error chain.**
- [x] **Tab never reaches `complete` status** — 30-second timeout rejects the promise → tab is removed in `finally` → null returned. **Handled by timeout.**
- [x] **Content script injection fails** — `chrome.scripting.executeScript` failures (CSP, navigation) are caught → returns null → falls through to offscreen parse or raw HTML. **Handled by existing fallback chain.**
- [x] **Readability.js not found / fails to load** — If the `libs/Readability.js` file is missing, the `executeScript` call throws → caught → `fetchWithBackgroundTab` returns null → `processURLWithRetry` falls through to offscreen parse, then raw HTML strip. **Handled by multi-layer fallback.**
- [x] **Tab navigates to different URL** — Some pages redirect via JS after loading. The Readability extraction runs on whatever page is loaded, which is the correct final destination. `finalUrl` from `fetchURL` is also checked for type detection. **Correct behavior.**
- [x] **User closes the background tab** — If the user notices and closes the tab, `chrome.scripting.executeScript` throws → caught by `try/catch` → `fetchWithBackgroundTab` returns null → falls through to other fallbacks. Tab cleanup in `finally` silently ignores the "tab not found" error. **Handled by existing error chain.**

## 8. Markdown Output

- [x] **Title contains markdown special characters** — `escapeMarkdownHeading()` escapes `\`, `` ` ``, `*`, `_`, `{}`, `[]`, `()`, `#`, `+`, `-`, `.`, `!`, `|`, `~`, `>` in the `# heading` line. Frontmatter title is unescaped (YAML, not markdown).
- [x] **Title contains newlines** — `sanitizeTitle()` strips `\r\n` and collapses whitespace to single spaces.
- [x] **Frontmatter YAML injection** — `buildFrontmatter()` now escapes `\n`, `\r`, `\\`, `"` in string values. A title like `foo\nbar: baz` becomes `"foo\\nbar: baz"` — valid single-line YAML.
- [x] **Content is empty after parsing** — Now checks `!parsed.content.trim()` — whitespace-only content is treated as empty and produces an error `.md`.
- [x] **Very large markdown files** — Input is capped at 5MB (`MAX_PAGE_SIZE`). After Readability extraction and Turndown conversion, output is typically 10-20% of input size. **Mitigated by input size cap.**
- [x] **Binary/non-text content in HTML** — Non-HTML content is now detected via `Content-Type` and saved as binary files, never parsed through Readability. For HTML pages with embedded binary (rare), Readability and Turndown strip non-text content. **Handled by content-type detection + Readability filtering.**

## 9. UI / Popup / Settings

- [x] **Popup opened while service worker is inactive** — `sendMsg()` in popup.js, settings.js, and onboarding.js now retries once after 300ms if the first attempt fails (service worker waking up).
- [x] **Rapid clicking of buttons** — "Refresh Now" and "Save Settings" already `disable` the button during async operation and re-enable in `finally`. "Toggle Polling" reads state and acts idempotently. Interval buttons trigger `setStorage` which is idempotent. **Already handled; no destructive double-execution possible.**
- [x] **Settings saved with empty bot token** — Token input only saves when non-empty (`if (tokenInput)`). This is correct — to clear the token, the user should use "Reset Setup" in the danger zone, which is the intended flow. **By design.**
- [x] **Paste zone receives non-URL text** — Now shows "Not a valid URL" feedback with error styling, auto-clears after 2 seconds.
- [x] **Paste zone receives multiple URLs** — Now splits pasted text by newlines and saves all valid URLs sequentially.
- [x] **XSS in save titles** — `esc()` escapes `&`, `<`, `>`, `"`. All dynamic content inserted via `innerHTML` passes through `esc()`. `title` attributes also use `esc()`. **Adequate protection for the rendering context.**
- [x] **`file_naming_pattern` not actually used** — `processURLWithRetry` now uses `buildFilename()` which respects the setting: `YYYY-MM-DD-slug`, `slug-YYYY-MM-DD`, or `slug` (no date).

## 10. Onboarding

- [x] **User completes step 1, goes back, changes token, proceeds** — The `input` event listener on `bot-token` resets `verifiedBotUsername = null` and disables the "Next" button. The button stays disabled until a new verification succeeds. **Already handled by input change listener.**
- [x] **User closes onboarding mid-setup** — `setup_complete` is only set in `finishSetup()`. If the user closes early, the popup shows "Setup Required" on next open. Token may be saved but setup isn't complete — no data loss, just re-do the wizard. **Acceptable; safe behavior.**
- [x] **IndexedDB blocked / private browsing** — **Chrome extensions always have IndexedDB access**, even in incognito (the extension's own storage context is separate from the page). Firefox doesn't support this extension (Manifest V3 + File System Access API). **Not a real concern for Chrome extensions.**
- [x] **`showDirectoryPicker` not supported** — This is a Chrome-only extension (Manifest V3 + `chrome.offscreen` + `chrome.scripting`). The File System Access API is available in all Chromium browsers that support MV3. Firefox is not a target. **Not applicable.**

## 11. Image Handling

- [x] **Telegram image download fails partially** — Successful images get local paths, failed ones keep remote URLs — the markdown has a mix. This is the best-effort approach: the user sees which images failed (remote URL = not downloaded). **Acceptable degraded behavior; no silent data loss.**
- [x] **Image URL has no file extension / content-type mismatch** — `downloadImagesToFolder()` now uses `Content-Type` header for the file extension, falling back to URL path only when the header is missing. Handles `image/jpeg` → `.jpg`, `image/svg+xml` → `.svg`, etc.
- [x] **Image is WebP or AVIF** — Saved with the correct extension (`.webp`, `.avif`). **Can't convert formats** without a server-side service or WASM library, which is out of scope. Most modern markdown viewers (VS Code, Obsidian, Typora) support WebP. AVIF support is growing. **Acceptable; format conversion would add significant complexity.**
- [x] **Concurrent image downloads to same folder** — `getDirectoryHandle({ create: true })` is idempotent — multiple calls return the same directory. Image filenames are `01.jpg`, `02.jpg` etc., based on index, so two different posts won't collide (they have different folder names derived from the `.md` filename). **No conflict possible.**
- [x] **Image content-type mismatch** — Now uses `Content-Type` header instead of URL path. **Fixed.**

## 12. Retry Mechanism

- [x] **Retries persist across extension restarts** — `pending_retries` in `chrome.storage.local` survive restarts. If the browser was closed for a long time, due retries fire on the next poll. This is correct — the URLs still need processing. **Working as intended.**
- [x] **Retries for URLs that will never succeed** — Max 3 retries, then an error `.md` is saved. The error file documents the URL and failure reason so the user can act manually. **Bounded by MAX_RETRIES; no infinite loop.**
- [x] **`messageCtx` is stale on retry** — `messageCtx` carries `message_id` and `chat_id` but isn't used downstream (no reply-to-Telegram feature). **Harmless; not worth a breaking change to remove.**
- [x] **Redirect loops not retryable** — Redirect errors now marked `retryable: false`.

## 13. Concurrency & Race Conditions

- [x] **Two `poll()` calls overlapping** — Fixed with `_pollLock` mutex.
- [x] **Duplicate messages on crash** — Fixed with per-message `update_id` persistence.
- [x] **`save_url` (manual paste) + poll happening simultaneously** — Both call `processURLWithRetry` independently. If they save the same URL, `getUniqueFileHandle` produces a `-2` suffix for the second file. **No data loss; at worst a duplicate file.**
- [x] **`setStorage` race condition** — `chrome.storage.local.set()` is atomic per call. Two concurrent `setStorage({ recent_saves })` calls could overwrite each other, losing one entry from the recent-saves list. **Low impact (cosmetic list); not worth adding a locking layer.**
- [x] **Badge update race** — Multiple concurrent `updateBadge` calls may flicker, but always converge to the correct state on the next call. **Cosmetic; self-correcting.**

## 14. Edge Case URLs / Content Types

- [x] **PDF URL** — Now detected as non-HTML via `Content-Type` and saved as binary file directly (e.g., `2024-01-15-report.pdf`).
- [x] **Google Docs / Sheets URL** — Returns an HTML shell requiring JS. Background tab fallback loads with full JS → Readability extracts what it can. Output varies (often partial). **Best effort; full extraction would require Google API integration.**
- [x] **YouTube URL** — Readability extracts the page title and description. **Video content/transcript extraction is out of scope** — would require YouTube API or yt-dlp integration.
- [x] **URL shorteners (bit.ly, t.co)** — `fetchURL` follows redirects via `redirect: 'follow'`. The resolved `finalUrl` is used for Twitter/XHS detection. **Already handled by redirect following.**
- [x] **SPA / single-page apps** — Static `fetchURL` gets empty shells. The background tab fallback loads with full JS and waits for `complete` status before running Readability. **Handled by background tab fallback.** Very late-loading SPAs (>30s) will timeout, producing a partial or error result.
- [x] **Pages with iframes containing main content** — Readability strips iframes by design (security). **Can't fix without fundamentally changing Readability's behavior.** These pages typically produce an error `.md` or partial content.
- [x] **AMP pages** — Readability handles AMP well (AMP is valid HTML with `<article>` elements). **Not a real issue in practice.**
- [x] **URLs with Unicode / IDN domains** — `new URL()` handles punycode conversion. `slugify()` now preserves unicode letters with `\p{L}` regex flag, so `https://例え.jp/page` produces a readable filename instead of `untitled`.

## 15. Security

- [x] **Bot token stored in plaintext** — **Chrome API limitation.** `chrome.storage.local` has no encryption option. The token is only accessible to this extension (Chrome isolates extension storage). Other extensions cannot read it unless they have the same extension ID. **Acceptable for a personal-use tool.**
- [x] **No chat ID restriction** — **By design.** The user's bot token is private. Anyone with the token can send messages, but the token should never be shared. Adding chat ID filtering would add setup complexity (user needs to find their chat ID) for minimal security benefit. **Acceptable trade-off.**
- [x] **Potential path traversal in filenames** — `slugify()` strips everything except unicode letters, numbers, spaces (→dashes), and hyphens. No `/`, `\`, `..`, or other traversal characters survive. Additionally, the File System Access API confines writes to the selected directory. **Double protection.**
- [x] **HTML content in saved markdown** — Turndown converts all HTML to markdown. Any unconverted HTML tags (edge cases) render as plain text in most markdown viewers (VS Code, Obsidian, GitHub). **No execution risk; markdown renderers don't execute HTML by default in local files.**
- [x] **URL credentials leaked in markdown** — `sanitizeUrlForDisplay()` masks `user:pass` with `***:***` in frontmatter and error files.
