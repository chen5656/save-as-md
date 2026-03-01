// Save as MD — Background Service Worker
// Polls your Telegram bot and saves URLs as local Markdown files.

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const TELEGRAM_BASE = 'https://api.telegram.org/bot';
const ALARM_NAME = 'save-as-md-poll';
const DEFAULT_POLL_INTERVAL = 300; // seconds
const MAX_RETRIES = 3;
const RETRY_DELAYS = [30, 120, 300]; // seconds between attempts
const DISCONNECT_THRESHOLD = 24 * 60 * 60 * 1000; // 24h in ms
const MIN_ARTICLE_LENGTH = 500; // chars; below this, use background tab fallback

// ─── IndexedDB (for FileSystemDirectoryHandle) ────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('save-as-md', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = e => resolve(e.target.result ?? null);
    req.onerror = e => reject(e.target.error);
  });
}

// ─── Chrome Storage Helpers ───────────────────────────────────────────────────
async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(obj) {
  return chrome.storage.local.set(obj);
}

// ─── Telegram API ─────────────────────────────────────────────────────────────
async function telegramCall(token, method, params = {}) {
  const resp = await fetch(`${TELEGRAM_BASE}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} calling Telegram ${method}`);
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram error: ${data.description}`);
  return data.result;
}

async function getMe(token) {
  return telegramCall(token, 'getMe');
}

async function getUpdates(token, offset) {
  return telegramCall(token, 'getUpdates', {
    offset,
    timeout: 0,
    allowed_updates: ['message'],
  });
}

async function getTelegramFileInfo(token, fileId) {
  return telegramCall(token, 'getFile', { file_id: fileId });
}

// ─── URL Detection ────────────────────────────────────────────────────────────
function extractURLsFromMessage(message) {
  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  const urls = [];

  for (const entity of entities) {
    if (entity.type === 'url') {
      urls.push(text.slice(entity.offset, entity.offset + entity.length));
    } else if (entity.type === 'text_link') {
      urls.push(entity.url);
    }
  }

  // Fallback: regex match
  if (urls.length === 0) {
    const matches = text.match(/https?:\/\/[^\s<>"]+/g) || [];
    urls.push(...matches);
  }

  return [...new Set(urls)];
}

function isURL(text) {
  return /^https?:\/\/[^\s]+/.test(text.trim());
}

function isTwitterHostname(hostname) {
  const host = (hostname || '').toLowerCase().replace(/^www\./, '');
  return host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com');
}

function isTwitterStatusURL(input) {
  try {
    const u = new URL(input);
    return isTwitterHostname(u.hostname) && /\/status\/\d+/.test(u.pathname);
  } catch {
    return false;
  }
}

// ─── Offscreen Document ───────────────────────────────────────────────────────
async function ensureOffscreen() {
  // hasDocument() added in Chrome 116
  if (typeof chrome.offscreen.hasDocument === 'function') {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Parse HTML with Readability for article extraction',
    });
  } catch (e) {
    // Ignore "already exists" errors
    if (!e.message?.includes('single offscreen') && !e.message?.includes('already')) {
      throw e;
    }
  }
}

async function offscreenMessage(payload) {
  await ensureOffscreen();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Offscreen timeout')), 30000);

    chrome.runtime.sendMessage(
      { target: 'offscreen', ...payload },
      response => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'Offscreen operation failed'));
        }
      }
    );
  });
}

// Parse full page HTML: run Readability + Turndown
async function parseHtmlViaOffscreen(html, url, useGFM) {
  return offscreenMessage({ type: 'parse_html', html, url, useGFM });
}

// Convert already-extracted article HTML to Markdown (skip Readability)
async function convertHtmlToMarkdown(title, html, url, useGFM) {
  return offscreenMessage({ type: 'convert_html', title, html, url, useGFM });
}

// ─── Content Fetch ────────────────────────────────────────────────────────────
async function fetchURL(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });

    clearTimeout(timer);

    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      err.status = resp.status;
      err.retryable = resp.status >= 500;
      throw err;
    }

    const html = await resp.text();
    return { html, finalUrl: resp.url };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error('Request timed out after 30s');
      err.retryable = true;
      throw err;
    }
    if (!e.status) e.retryable = true; // network error
    throw e;
  }
}

// ─── Background Tab Fallback ──────────────────────────────────────────────────
async function fetchWithBackgroundTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab load timeout'));
      }, 30000);

      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // X/Twitter posts are highly dynamic; extract from live DOM directly to avoid
    // unrelated overlays polluting Readability output.
    if (isTwitterStatusURL(url)) {
      const xResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const clean = value =>
            (value || '')
              .replace(/\u00A0/g, ' ')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();

          const uniq = values => [...new Set(values.filter(Boolean))];

          const toAbs = value => {
            if (!value) return '';
            try {
              return new URL(value, window.location.href).toString();
            } catch {
              return '';
            }
          };

          const normalizeImageUrl = src => {
            try {
              const u = new URL(src);
              u.searchParams.set('name', 'orig');
              return u.toString();
            } catch {
              return src;
            }
          };

          const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"], article[role="article"]'));
          const tweetArticle = articles.find(a => a.querySelector('time')) || articles[0] || null;
          if (!tweetArticle) return null;

          const text = Array.from(tweetArticle.querySelectorAll('div[data-testid="tweetText"]'))
            .map(el => clean(el.innerText || el.textContent))
            .filter(Boolean)
            .join('\n\n');

          const nameBlock = tweetArticle.querySelector('div[data-testid="User-Name"]');
          const spanValues = nameBlock
            ? Array.from(nameBlock.querySelectorAll('span'))
                .map(el => clean(el.innerText || el.textContent))
                .filter(Boolean)
            : [];

          const authorName = spanValues.find(v => !v.startsWith('@') && !v.includes('·')) || '';
          let authorHandle = (spanValues.find(v => v.startsWith('@')) || '').replace(/^@/, '');

          if (!authorHandle) {
            const profileLink = Array.from(tweetArticle.querySelectorAll('a[href^="/"]'))
              .map(a => toAbs(a.getAttribute('href')))
              .find(href => {
                try {
                  const p = new URL(href).pathname;
                  return /^\/[A-Za-z0-9_]{1,15}$/.test(p);
                } catch {
                  return false;
                }
              });
            if (profileLink) {
              authorHandle = new URL(profileLink).pathname.replace(/^\/+/, '');
            }
          }

          const timeEl = tweetArticle.querySelector('time');
          const postedAt = timeEl?.getAttribute('datetime') || '';
          const permalink = toAbs(timeEl?.closest('a[href*="/status/"]')?.getAttribute('href') || window.location.href);
          const normalizedPermalink = permalink.replace(/\/+$/, '');

          const rawLinks = Array.from(tweetArticle.querySelectorAll('a[href]')).map(a => {
            const href = a.getAttribute('href');
            if (!href) return '';

            const title = (a.getAttribute('title') || '').trim();
            if (/^https?:\/\//i.test(title)) return title;

            const absoluteHref = toAbs(href);
            const linkText = clean(a.innerText || a.textContent);
            if (/^https?:\/\/t\.co\//i.test(absoluteHref) && /\.[a-z]{2,}/i.test(linkText)) {
              const candidate = /^https?:\/\//i.test(linkText) ? linkText : `https://${linkText}`;
              if (/^https?:\/\/[^\s]+$/i.test(candidate)) return candidate;
            }

            return absoluteHref;
          });

          const links = uniq(rawLinks)
            .map(link => link.replace(/\/+$/, ''))
            .filter(Boolean)
            .filter(link => {
              if (link === normalizedPermalink) return false;
              try {
                const host = new URL(link).hostname.toLowerCase().replace(/^www\./, '');
                return !(host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com'));
              } catch {
                return false;
              }
            });

          const images = uniq(
            Array.from(tweetArticle.querySelectorAll('img[src]'))
              .map(img => toAbs(img.getAttribute('src') || img.src))
              .filter(src => /pbs\.twimg\.com\/(media|ext_tw_video_thumb)\//.test(src))
              .map(src => normalizeImageUrl(src))
          );

          const lines = [];

          if (authorName || authorHandle) {
            const who =
              authorName && authorHandle ? `${authorName} (@${authorHandle})`
              : authorHandle ? `@${authorHandle}`
              : authorName;
            lines.push(`**Author:** ${who}`);
          }
          if (postedAt) lines.push(`**Posted:** ${postedAt}`);
          if (permalink) lines.push(`**Post URL:** ${permalink}`);
          if (lines.length) lines.push('');

          if (text) {
            lines.push(text);
            lines.push('');
          }

          if (links.length) {
            lines.push('## Links');
            lines.push('');
            for (const link of links) lines.push(`- ${link}`);
            lines.push('');
          }

          if (images.length) {
            lines.push('## Images');
            lines.push('');
            images.forEach((src, idx) => lines.push(`![Post image ${idx + 1}](${src})`));
            lines.push('');
          }

          const contentMarkdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
          if (!contentMarkdown) return null;

          const displayAuthor = authorHandle ? `@${authorHandle}` : authorName || 'X';
          const preview = text ? clean(text).slice(0, 72) : '';
          const title = preview ? `${displayAuthor}: ${preview}` : `${displayAuthor} on X`;

          return { title, content: contentMarkdown, markdownReady: true };
        },
      });

      const xPost = xResults[0]?.result || null;
      if (xPost?.content) return xPost;
    }

    // Inject Readability
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['libs/Readability.js'],
    });

    // Extract content from live DOM
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const reader = new Readability(document.cloneNode(true));
          const article = reader.parse();
          if (!article) return null;
          return {
            title: article.title,
            content: article.content,
            excerpt: article.excerpt,
            byline: article.byline,
            siteName: article.siteName,
          };
        } catch (e) {
          return null;
        }
      },
    });

    return results[0]?.result || null;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ─── File System ──────────────────────────────────────────────────────────────
async function getDirHandle() {
  const handle = await idbGet('save_dir_handle');
  if (!handle) return null;

  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return handle;

  // Can't requestPermission() from service worker — signal popup
  await setStorage({ fs_permission_needed: true });
  await updateBadge();
  return null;
}

function slugify(text) {
  return (text || 'untitled')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function dateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function getUniqueFileHandle(dirHandle, filename) {
  const ext = filename.endsWith('.md') ? '.md' : '';
  const base = ext ? filename.slice(0, -3) : filename;

  // Try base name first
  try {
    await dirHandle.getFileHandle(filename, { create: false });
    // File exists — try numbered variants
    for (let i = 2; i <= 99; i++) {
      const candidate = `${base}-${i}${ext}`;
      try {
        await dirHandle.getFileHandle(candidate, { create: false });
      } catch {
        return dirHandle.getFileHandle(candidate, { create: true });
      }
    }
  } catch {
    // File doesn't exist — use original name
    return dirHandle.getFileHandle(filename, { create: true });
  }

  return dirHandle.getFileHandle(`${base}-${Date.now()}${ext}`, { create: true });
}

async function writeFile(fileHandle, content) {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function readFile(fileHandle) {
  const file = await fileHandle.getFile();
  return file.text();
}

async function saveMarkdownFile(dirHandle, filename, content) {
  const fileHandle = await getUniqueFileHandle(dirHandle, filename);
  await writeFile(fileHandle, content);
  return fileHandle.name;
}

async function appendToDaily(dirHandle, content, date) {
  const filename = `${date}.md`;
  let existing = '';

  try {
    const fh = await dirHandle.getFileHandle(filename, { create: false });
    existing = await readFile(fh);
  } catch {
    // File doesn't exist yet
  }

  const separator = existing ? '\n\n---\n\n' : '';
  const newContent = existing + separator + content;

  const fh = await dirHandle.getFileHandle(filename, { create: true });
  await writeFile(fh, newContent);
}

async function saveImageToFolder(dirHandle, date, filename, arrayBuffer) {
  // Create date subfolder
  let dayDir;
  try {
    dayDir = await dirHandle.getDirectoryHandle(date, { create: true });
  } catch {
    dayDir = dirHandle; // fallback: save in root
  }

  const fh = await dayDir.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(arrayBuffer);
  await writable.close();
  return `${date}/${filename}`;
}

// ─── Markdown Building ────────────────────────────────────────────────────────
function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    const val = typeof v === 'string' ? `"${v.replace(/"/g, '\\"')}"` : v;
    lines.push(`${k}: ${val}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function buildArticleMarkdown({ title, url, savedAt, markdown, includeFrontmatter }) {
  const fm = includeFrontmatter
    ? buildFrontmatter({ title, url, saved_at: savedAt, source: 'save-as-md' })
    : '';
  return `${fm}# ${title}\n\n${markdown}\n`;
}

function buildErrorMarkdown({ url, error, savedAt, includeFrontmatter }) {
  const fm = includeFrontmatter
    ? buildFrontmatter({ url, saved_at: savedAt, source: 'save-as-md', status: 'error' })
    : '';
  return `${fm}# Save Error\n\nFailed to save: ${url}\n\n**Error:** ${error}\n\n**Time:** ${savedAt}\n`;
}

// ─── Recent Saves ─────────────────────────────────────────────────────────────
async function addRecentSave(info) {
  const { recent_saves = [] } = await getStorage(['recent_saves']);
  recent_saves.unshift(info);
  if (recent_saves.length > 20) recent_saves.length = 20;
  await setStorage({ recent_saves });
}

// ─── Connection Warnings ──────────────────────────────────────────────────────
async function checkAndHandleDisconnect() {
  const { last_successful_poll } = await getStorage(['last_successful_poll']);
  if (!last_successful_poll) return;

  const lastPoll = new Date(last_successful_poll).getTime();
  const now = Date.now();
  const gap = now - lastPoll;

  if (gap >= DISCONNECT_THRESHOLD) {
    const startDt = new Date(last_successful_poll);
    const endDt = new Date();
    const durationMs = gap;

    const hours = Math.floor(durationMs / 3600000);
    const minutes = Math.floor((durationMs % 3600000) / 60000);
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;

    let durationStr;
    if (days > 0) {
      durationStr = `${days} day${days > 1 ? 's' : ''} ${remHours} hour${remHours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
    } else {
      durationStr = `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }

    const warning = {
      id: Date.now(),
      start: startDt.toISOString(),
      end: endDt.toISOString(),
      duration: durationStr,
      acknowledged: false,
    };

    const { connection_warnings = [] } = await getStorage(['connection_warnings']);
    connection_warnings.unshift(warning);
    if (connection_warnings.length > 50) connection_warnings.length = 50;
    await setStorage({ connection_warnings, has_disconnect_warning: true });

    // Chrome notification
    chrome.notifications.create(`disconnect-${warning.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '⚠️ Save as MD — Disconnected',
      message: `Offline for ${durationStr}.\nURLs sent during ${formatDateTime(startDt)} — ${formatDateTime(endDt)} may not have been saved.`,
      priority: 2,
    });

    await updateBadge();
  }
}

function formatDateTime(date) {
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ─── Badge Management ─────────────────────────────────────────────────────────
async function updateBadge() {
  const {
    is_polling_active,
    setup_complete,
    has_disconnect_warning,
    fs_permission_needed,
    last_telegram_error,
  } = await getStorage([
    'is_polling_active', 'setup_complete', 'has_disconnect_warning',
    'fs_permission_needed', 'last_telegram_error',
  ]);

  if (!setup_complete) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
    return;
  }

  if (fs_permission_needed || last_telegram_error || has_disconnect_warning) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#E53935' });
    return;
  }

  if (!is_polling_active) {
    chrome.action.setBadgeText({ text: '■' });
    chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E' });
    return;
  }

  // Normal / polling
  chrome.action.setBadgeText({ text: '' });
}

// ─── Retry Mechanism ──────────────────────────────────────────────────────────
async function schedulePendingRetry(url, attempt, messageCtx) {
  const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
  const { pending_retries = [] } = await getStorage(['pending_retries']);

  // Remove existing entry for same URL
  const filtered = pending_retries.filter(r => r.url !== url);
  filtered.push({
    url,
    attempt,
    next_retry_at: Date.now() + delay * 1000,
    messageCtx,
  });

  await setStorage({ pending_retries: filtered });
}

async function processPendingRetries() {
  const { pending_retries = [] } = await getStorage(['pending_retries']);
  if (!pending_retries.length) return;

  const now = Date.now();
  const due = pending_retries.filter(r => r.next_retry_at <= now);
  if (!due.length) return;

  const remaining = pending_retries.filter(r => r.next_retry_at > now);
  await setStorage({ pending_retries: remaining });

  const settings = await getSettings();

  for (const retry of due) {
    await processURLWithRetry(retry.url, retry.attempt, retry.messageCtx, settings);
  }
}

async function clearPendingRetry(url) {
  const { pending_retries = [] } = await getStorage(['pending_retries']);
  await setStorage({ pending_retries: pending_retries.filter(r => r.url !== url) });
}

// ─── Settings Helper ──────────────────────────────────────────────────────────
async function getSettings() {
  return getStorage([
    'bot_token', 'include_frontmatter', 'use_gfm', 'file_naming_pattern',
    'poll_interval', 'bot_username',
  ]);
}

// ─── URL Processing ───────────────────────────────────────────────────────────
async function processURLWithRetry(url, attemptIndex, messageCtx, settings) {
  const dirHandle = await getDirHandle();
  if (!dirHandle) {
    console.warn('[save-as-md] No directory handle — skipping URL save');
    return;
  }

  const { bot_token, include_frontmatter = true, use_gfm = true } = settings;
  const savedAt = new Date().toISOString();

  try {
    // Step 1: Fetch the page
    let html, finalUrl;
    try {
      ({ html, finalUrl } = await fetchURL(url));
    } catch (fetchErr) {
      const isRetryable = fetchErr.retryable;
      const status = fetchErr.status;
      const isNonRetryable = status === 401 || status === 403 || status === 404;

      if (isNonRetryable || !isRetryable) {
        // Save error file immediately
        const errorMd = buildErrorMarkdown({
          url, error: fetchErr.message, savedAt, includeFrontmatter: include_frontmatter,
        });
        const filename = `${dateString()}-error-${slugify(url.replace(/https?:\/\//, '').slice(0, 40))}.md`;
        const saved = await saveMarkdownFile(dirHandle, filename, errorMd);
        chrome.notifications.create({
          type: 'basic', iconUrl: 'icons/icon48.png',
          title: 'Save as MD — Save Failed',
          message: `Could not save: ${url}\nError: ${fetchErr.message}`,
        });
        return;
      }

      // Retryable error
      const nextAttempt = attemptIndex + 1;
      if (nextAttempt < MAX_RETRIES) {
        await schedulePendingRetry(url, nextAttempt, messageCtx);
        return;
      }

      // All retries exhausted
      const errorMd = buildErrorMarkdown({
        url, error: `${fetchErr.message} (after ${MAX_RETRIES} attempts)`,
        savedAt, includeFrontmatter: include_frontmatter,
      });
      const filename = `${dateString()}-error-${slugify(url.replace(/https?:\/\//, '').slice(0, 40))}.md`;
      await saveMarkdownFile(dirHandle, filename, errorMd);
      chrome.notifications.create({
        type: 'basic', iconUrl: 'icons/icon48.png',
        title: 'Save as MD — Save Failed (all retries)',
        message: `Failed to save ${url} after ${MAX_RETRIES} attempts.\nLast error: ${fetchErr.message}`,
      });
      return;
    }

    const useLiveDomFirst = isTwitterStatusURL(finalUrl || url);

    // Step 2: Parse HTML → Readability → Markdown
    let parsed = null;
    if (!useLiveDomFirst) {
      try {
        parsed = await parseHtmlViaOffscreen(html, finalUrl || url, use_gfm);
      } catch (parseErr) {
        console.warn('[save-as-md] Offscreen parse failed:', parseErr);
      }
    }

    // Step 3: If insufficient content, try background tab (JS-rendered pages)
    if (useLiveDomFirst || !parsed || !parsed.content || parsed.content.length < MIN_ARTICLE_LENGTH) {
      console.log('[save-as-md] Falling back to background tab for:', url);
      try {
        const tabResult = await fetchWithBackgroundTab(url);
        if (tabResult?.content) {
          if (tabResult.markdownReady) {
            parsed = {
              title: tabResult.title || parsed?.title || url,
              content: tabResult.content,
              success: true,
            };
          } else {
            // tabResult.content is Readability-extracted HTML — convert to Markdown
            try {
              const mdResult = await convertHtmlToMarkdown(
                tabResult.title || url,
                tabResult.content,
                url,
                use_gfm
              );
              if (mdResult?.success && mdResult.content) {
                parsed = { ...mdResult, title: tabResult.title || parsed?.title || url };
              }
            } catch {
              // Last resort: strip tags manually
              const stripped = tabResult.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              parsed = { title: tabResult.title || url, content: stripped, success: true };
            }
          }
        }
      } catch (tabErr) {
        console.warn('[save-as-md] Background tab failed:', tabErr);
        // Raw HTML fallback
        if (html) {
          const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 8000);
          parsed = {
            title: url,
            content: `*Article extraction failed. Partial raw content:*\n\n${stripped}`,
            success: true,
          };
        }
      }
    }

    // If X/Twitter live DOM extraction fails, attempt the generic parser before erroring out.
    if ((!parsed || !parsed.content) && useLiveDomFirst) {
      try {
        parsed = await parseHtmlViaOffscreen(html, finalUrl || url, use_gfm);
      } catch (parseErr) {
        console.warn('[save-as-md] Offscreen fallback parse failed:', parseErr);
      }
    }

    if (!parsed?.content) {
      const errorMd = buildErrorMarkdown({
        url, error: 'Could not extract any readable content from this page',
        savedAt, includeFrontmatter: include_frontmatter,
      });
      const filename = `${dateString()}-error-${slugify(url.replace(/https?:\/\//, '').slice(0, 40))}.md`;
      await saveMarkdownFile(dirHandle, filename, errorMd);
      return;
    }

    const title = parsed.title || new URL(url).hostname;
    const markdown = buildArticleMarkdown({
      title,
      url,
      savedAt,
      markdown: parsed.content,
      includeFrontmatter: include_frontmatter,
    });

    const filename = `${dateString()}-${slugify(title)}.md`;
    const savedName = await saveMarkdownFile(dirHandle, filename, markdown);

    // Notify
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: 'Saved as Markdown',
      message: `"${title.slice(0, 60)}" → ${savedName}`,
    });

    await addRecentSave({ title, filename: savedName, url, saved_at: savedAt });
    await clearPendingRetry(url);

  } catch (err) {
    console.error('[save-as-md] Unexpected error processing URL:', url, err);

    const nextAttempt = attemptIndex + 1;
    if (nextAttempt < MAX_RETRIES && err.retryable !== false) {
      await schedulePendingRetry(url, nextAttempt, messageCtx);
    } else {
      const dirH = await getDirHandle();
      if (dirH) {
        const errorMd = buildErrorMarkdown({
          url, error: err.message, savedAt, includeFrontmatter: true,
        });
        const filename = `${dateString()}-error-${slugify(url.slice(0, 40))}.md`;
        await saveMarkdownFile(dirH, filename, errorMd).catch(() => {});
      }
    }
  }
}

// ─── Text Message Processing ──────────────────────────────────────────────────
async function processTextMessage(text, date, dirHandle, includeFrontmatter) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const entry = `**${timestamp}** — ${text}`;
  await appendToDaily(dirHandle, entry, date);
}

// ─── Image Message Processing ─────────────────────────────────────────────────
async function processImageMessage(message, token, date, dirHandle, includeFrontmatter) {
  try {
    // Get the largest photo variant
    const photos = message.photo;
    let fileId, mimeExt = 'jpg';

    if (photos && photos.length > 0) {
      fileId = photos[photos.length - 1].file_id;
    } else if (message.document?.mime_type?.startsWith('image/')) {
      fileId = message.document.file_id;
      mimeExt = message.document.mime_type.split('/')[1] || 'jpg';
    } else {
      return;
    }

    const fileInfo = await getTelegramFileInfo(token, fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const imageResp = await fetch(fileUrl);

    if (!imageResp.ok) throw new Error(`Failed to download image: HTTP ${imageResp.status}`);

    const arrayBuffer = await imageResp.arrayBuffer();
    const ext = fileInfo.file_path.split('.').pop() || mimeExt;
    const imgFilename = `${Date.now()}.${ext}`;

    const savedPath = await saveImageToFolder(dirHandle, date, imgFilename, arrayBuffer);

    const caption = message.caption ? `\n\n${message.caption}` : '';
    const entry = `![Image](./${savedPath})${caption}`;
    await appendToDaily(dirHandle, entry, date);
  } catch (err) {
    console.error('[save-as-md] Image processing error:', err);
    const entry = `*Failed to save image: ${err.message}*`;
    await appendToDaily(dirHandle, entry, date);
  }
}

// ─── Main Message Dispatcher ──────────────────────────────────────────────────
async function processUpdate(update, token, settings) {
  const message = update.message;
  if (!message) return;

  const date = dateString();
  const { include_frontmatter = true } = settings;

  // Detect URLs in message
  const urls = extractURLsFromMessage(message);

  if (urls.length > 0) {
    // Process each URL (most messages have 1)
    for (const url of urls) {
      await processURLWithRetry(url, 0, { message_id: message.message_id, chat_id: message.chat.id }, settings);
    }
  } else if (message.photo || message.document?.mime_type?.startsWith('image/')) {
    // Image message
    const dirHandle = await getDirHandle();
    if (dirHandle) {
      await processImageMessage(message, token, date, dirHandle, include_frontmatter);
    }
  } else if (message.text || message.caption) {
    // Plain text — append to daily file
    const text = message.text || message.caption;
    const dirHandle = await getDirHandle();
    if (dirHandle) {
      await processTextMessage(text, date, dirHandle, include_frontmatter);
    }
  }
}

// ─── Main Poll ────────────────────────────────────────────────────────────────
async function poll() {
  const { bot_token, setup_complete, is_polling_active } = await getStorage([
    'bot_token', 'setup_complete', 'is_polling_active',
  ]);

  if (!setup_complete || !bot_token) return;
  if (is_polling_active === false) return;

  let { last_update_id = 0 } = await getStorage(['last_update_id']);

  try {
    // Check for extended disconnect first
    await checkAndHandleDisconnect();

    const updates = await getUpdates(bot_token, last_update_id);
    const settings = await getSettings();

    // Clear any previous Telegram error
    await setStorage({ last_telegram_error: null });

    if (updates && updates.length > 0) {
      for (const update of updates) {
        await processUpdate(update, bot_token, settings);
        last_update_id = update.update_id + 1;
      }
      await setStorage({ last_update_id });
    }

    // Update last successful poll time
    await setStorage({ last_successful_poll: new Date().toISOString() });
    await updateBadge();

  } catch (err) {
    console.error('[save-as-md] Poll error:', err);
    await setStorage({ last_telegram_error: err.message });
    await updateBadge();
  }

  // Also process any pending retries
  await processPendingRetries();
}

// ─── Alarm Management ─────────────────────────────────────────────────────────
async function setupAlarm(intervalSeconds) {
  await chrome.alarms.clear(ALARM_NAME);
  const periodInMinutes = Math.max(1, intervalSeconds / 60);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
  await setStorage({ poll_interval: intervalSeconds });
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async details => {
  const { setup_complete } = await getStorage(['setup_complete']);

  if (!setup_complete) {
    // Open onboarding tab
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }

  // Set defaults
  const defaults = {
    is_polling_active: true,
    poll_interval: DEFAULT_POLL_INTERVAL,
    include_frontmatter: true,
    use_gfm: true,
    file_naming_pattern: 'YYYY-MM-DD-slug',
    recent_saves: [],
    connection_warnings: [],
    pending_retries: [],
    last_update_id: 0,
    has_disconnect_warning: false,
    fs_permission_needed: false,
    last_telegram_error: null,
  };

  // Only set keys that don't exist yet
  const existing = await getStorage(Object.keys(defaults));
  const toSet = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (existing[k] === undefined) toSet[k] = v;
  }
  if (Object.keys(toSet).length) await setStorage(toSet);

  // Set up alarm
  const { poll_interval = DEFAULT_POLL_INTERVAL } = await getStorage(['poll_interval']);
  await setupAlarm(poll_interval);

  await updateBadge();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    await poll();
  }
});

// ─── Message Handler (from popup/settings/onboarding) ────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Skip messages targeted at offscreen
  if (message.target === 'offscreen') return false;

  const handle = async () => {
    switch (message.type) {
      case 'poll_now': {
        await poll();
        return { success: true };
      }

      case 'set_interval': {
        await setupAlarm(message.intervalSeconds);
        const { is_polling_active } = await getStorage(['is_polling_active']);
        if (is_polling_active === false) {
          // Re-enable polling if stopped
          await setStorage({ is_polling_active: true });
        }
        return { success: true };
      }

      case 'stop_polling': {
        await chrome.alarms.clear(ALARM_NAME);
        await setStorage({ is_polling_active: false });
        await updateBadge();
        return { success: true };
      }

      case 'start_polling': {
        const { poll_interval = DEFAULT_POLL_INTERVAL } = await getStorage(['poll_interval']);
        await setupAlarm(poll_interval);
        await setStorage({ is_polling_active: true });
        await updateBadge();
        return { success: true };
      }

      case 'get_state': {
        const state = await getStorage([
          'bot_token', 'bot_username', 'last_successful_poll', 'recent_saves',
          'connection_warnings', 'is_polling_active', 'poll_interval',
          'setup_complete', 'has_disconnect_warning', 'fs_permission_needed',
          'last_telegram_error', 'pending_retries', 'last_update_id',
          'include_frontmatter', 'use_gfm', 'file_naming_pattern',
        ]);
        // Don't expose raw token — just whether one is set
        const hasToken = !!state.bot_token;
        delete state.bot_token;
        return { ...state, has_token: hasToken };
      }

      case 'dismiss_warning': {
        const { connection_warnings = [] } = await getStorage(['connection_warnings']);
        const updated = connection_warnings.map(w =>
          w.id === message.warningId ? { ...w, acknowledged: true } : w
        );
        const hasUnacked = updated.some(w => !w.acknowledged);
        await setStorage({ connection_warnings: updated, has_disconnect_warning: hasUnacked });
        await updateBadge();
        return { success: true };
      }

      case 'clear_history': {
        await setStorage({ connection_warnings: [], has_disconnect_warning: false });
        await updateBadge();
        return { success: true };
      }

      case 'save_settings': {
        const { settings } = message;
        const toSave = {};
        if (settings.bot_token !== undefined) toSave.bot_token = settings.bot_token;
        if (settings.bot_username !== undefined) toSave.bot_username = settings.bot_username;
        if (settings.include_frontmatter !== undefined) toSave.include_frontmatter = settings.include_frontmatter;
        if (settings.use_gfm !== undefined) toSave.use_gfm = settings.use_gfm;
        if (settings.file_naming_pattern !== undefined) toSave.file_naming_pattern = settings.file_naming_pattern;
        if (settings.poll_interval !== undefined) {
          toSave.poll_interval = settings.poll_interval;
          const { is_polling_active } = await getStorage(['is_polling_active']);
          if (is_polling_active !== false) {
            await setupAlarm(settings.poll_interval);
          }
        }
        if (settings.last_update_id !== undefined) toSave.last_update_id = settings.last_update_id;
        if (settings.setup_complete !== undefined) toSave.setup_complete = settings.setup_complete;
        await setStorage(toSave);
        await updateBadge();
        return { success: true };
      }

      case 'request_fs_permission': {
        // Can't do this from service worker — popup/onboarding must handle it
        return { error: 'Must be called from popup context' };
      }

      case 'fs_permission_granted': {
        await setStorage({ fs_permission_needed: false });
        await updateBadge();
        return { success: true };
      }

      case 'verify_token': {
        try {
          const bot = await getMe(message.token);
          await setStorage({
            bot_token: message.token,
            bot_username: bot.username,
            last_telegram_error: null,
          });
          return { success: true, username: bot.username };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      default:
        return { error: `Unknown message type: ${message.type}` };
    }
  };

  handle().then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true; // async sendResponse
});

// Kick off first poll when service worker wakes after browser start
chrome.runtime.onStartup.addListener(async () => {
  const { setup_complete, is_polling_active, poll_interval = DEFAULT_POLL_INTERVAL } = await getStorage([
    'setup_complete', 'is_polling_active', 'poll_interval',
  ]);
  if (setup_complete && is_polling_active !== false) {
    await setupAlarm(poll_interval);
    await poll();
  }
  await updateBadge();
});
