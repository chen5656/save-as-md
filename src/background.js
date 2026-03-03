// Markdown Vault — Background Service Worker
// Polls your Telegram bot and saves URLs as local Markdown files.

'use strict';

// Load media extraction modules (classic service worker — importScripts is synchronous)
importScripts(
  'content-router.js',
  'metadata.js',
  'vtt-parser.js',
  'youtube-handler.js',
  'media-handler.js',
  'rss-handler.js',
  'podcast-handler.js',
);

// ─── Constants ────────────────────────────────────────────────────────────────
const TELEGRAM_BASE = 'https://api.telegram.org/bot';
const ALARM_NAME = 'markdown-vault-poll';
const DEFAULT_POLL_INTERVAL = 300; // seconds
const MAX_RETRIES = 3;
const RETRY_DELAYS = [30, 120, 300]; // seconds between attempts
const DISCONNECT_THRESHOLD = 24 * 60 * 60 * 1000; // 24h in ms
const MIN_ARTICLE_LENGTH = 500; // chars; below this, use background tab fallback
const MAX_PAGE_SIZE = 5 * 1024 * 1024; // 5MB max for text page fetch

// ─── IndexedDB (for FileSystemDirectoryHandle) ────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('markdown-vault', 1);
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
  if (resp.status === 401) {
    const err = new Error('Bot token is invalid or revoked. Update your token in Settings.');
    err.retryable = false;
    throw err;
  }
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
    const err = new Error(`Telegram rate limit — retry after ${retryAfter}s`);
    err.retryable = true;
    throw err;
  }
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

function extractTweetId(url) {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function isXiaohongshuURL(input) {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    return host === 'xiaohongshu.com' || host === 'xhslink.com';
  } catch {
    return false;
  }
}

// ─── Sanitization Helpers ────────────────────────────────────────────────────
function sanitizeUrlForDisplay(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString();
  } catch { return url; }
}

function sanitizeTitle(title) {
  return (title || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFilename(title, pattern, date) {
  const slug = slugify(title);
  const d = date || dateString();
  switch (pattern) {
    case 'slug-YYYY-MM-DD': return `${slug}-${d}.md`;
    case 'slug':            return `${slug}.md`;
    case 'YYYY-MM-DD-slug':
    default:                return `${d}-${slug}.md`;
  }
}

// ─── X/Twitter oEmbed Fallback ───────────────────────────────────────────────
async function fetchTweetViaOEmbed(url) {
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
    const resp = await fetch(oembedUrl);
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.html) return null;

    // Parse the embed HTML to extract text content
    // oEmbed returns HTML like: <blockquote class="twitter-tweet"><p>tweet text</p>&mdash; Author (@handle) ...
    const htmlContent = data.html;

    // Extract text from the blockquote
    const textMatch = htmlContent.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const tweetText = textMatch
      ? textMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&mdash;/g, '—')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim()
      : '';

    const authorName = data.author_name || '';
    const authorUrl = data.author_url || '';
    const authorHandle = authorUrl ? authorUrl.split('/').pop() : '';

    const lines = [];
    if (authorName || authorHandle) {
      const who = authorName && authorHandle
        ? `${authorName} (@${authorHandle})`
        : authorHandle ? `@${authorHandle}` : authorName;
      lines.push(`**Author:** ${who}`);
    }
    lines.push(`**Post URL:** ${url}`);
    lines.push('');

    if (tweetText) {
      lines.push(tweetText);
      lines.push('');
    }

    // Extract any links from the tweet text
    const linkMatches = [...(tweetText.matchAll(/https?:\/\/[^\s]+/g) || [])];
    const links = linkMatches
      .map(m => m[0])
      .filter(l => {
        try {
          const host = new URL(l).hostname.toLowerCase().replace(/^www\./, '');
          return !(host === 'x.com' || host === 'twitter.com' || host === 't.co');
        } catch { return false; }
      });
    if (links.length) {
      lines.push('## Links');
      lines.push('');
      for (const link of links) lines.push(`- ${link}`);
      lines.push('');
    }

    lines.push('*Note: Images may not be available via oEmbed. Visit the original post to view media.*');

    const content = lines.join('\n').trim();
    const displayAuthor = authorHandle ? `@${authorHandle}` : authorName || 'X';
    const preview = tweetText ? tweetText.slice(0, 72) : '';
    const title = preview ? `${displayAuthor}: ${preview}` : `${displayAuthor} on X`;

    return { title, content, markdownReady: true };
  } catch (e) {
    console.warn('[markdown-vault] oEmbed fallback failed:', e);
    return null;
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
      url: 'pages/offscreen/offscreen.html',
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
      redirect: 'follow',
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

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const contentDisposition = resp.headers.get('content-disposition') || '';
    const isHTML = contentType.includes('text/html') || contentType.includes('application/xhtml');
    // Treat XML feed types as text so the RSS handler can parse them
    const isXmlFeed = contentType.includes('application/rss+xml') ||
      contentType.includes('application/atom+xml') ||
      contentType.includes('application/xml');

    // Non-HTML, non-text content (PDF, image, audio, video) — return as binary for handler dispatch
    if (!isHTML && !isXmlFeed && !contentType.includes('text/')) {
      const buffer = await resp.arrayBuffer();
      return { html: null, finalUrl: resp.url, contentType, contentDisposition, binaryData: buffer };
    }

    const html = await resp.text();
    // Guard against extremely large pages
    return {
      html: html.length > MAX_PAGE_SIZE ? html.slice(0, MAX_PAGE_SIZE) : html,
      finalUrl: resp.url,
      contentType,
      contentDisposition,
    };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error('Request timed out after 30s');
      err.retryable = true;
      throw err;
    }
    // Redirect loops are not retryable
    if (e.message?.includes('redirect')) {
      e.retryable = false;
      throw e;
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

    // X/Twitter posts are highly dynamic; wait for tweet content to render,
    // then extract from live DOM directly.
    if (isTwitterStatusURL(url)) {
      // Poll DOM until tweet content appears (X.com loads asynchronously after 'complete')
      const MAX_POLL_MS = 12000;
      const POLL_INTERVAL_MS = 500;
      const pollStart = Date.now();

      await new Promise((resolve) => {
        const check = async () => {
          if (Date.now() - pollStart > MAX_POLL_MS) { resolve(); return; }
          try {
            const probe = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const hasTweet = !!(
                  document.querySelector('article[data-testid="tweet"], article[role="article"]') &&
                  document.querySelector('div[data-testid="tweetText"]')
                );
                // Also detect X Notes / article pages (/i/article/ URL) or other article content
                const isArticlePage = /\/i\/article/.test(window.location.pathname);
                const hasArticle = isArticlePage
                  ? !!(document.querySelector('main, [role="main"], article, [role="article"]')?.textContent?.trim().length > 300)
                  : !!(
                    document.querySelector('div[data-testid="article-text"]') ||
                    document.querySelector('[data-testid="articleContent"]') ||
                    (document.querySelector('[data-testid="primaryColumn"]')?.textContent?.trim().length > 500)
                  );
                return hasTweet || hasArticle;
              },
            });
            if (probe[0]?.result) { resolve(); return; }
          } catch { /* tab not ready */ }
          setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
      });

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

      // X Notes / Article fallback — for status URLs whose SPA navigates to /i/article/
      const noteResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const clean = t =>
            (t || '')
              .replace(/\u00A0/g, ' ')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();

          const getTitle = () => clean(
            document.querySelector('meta[property="og:title"]')?.content ||
            document.querySelector('h1')?.innerText ||
            document.title.replace(/\s*[\/|]\s*X\s*$/, '').trim() ||
            ''
          );

          const isArticlePage = /\/i\/article\//.test(window.location.pathname);

          if (isArticlePage) {
            // X article reader — try progressively broader selectors
            const articleSelectors = [
              '[data-testid="article"]',
              '[role="article"]',
              'article',
              'main',
              '[role="main"]',
            ];
            for (const sel of articleSelectors) {
              const el = document.querySelector(sel);
              if (el) {
                const content = clean(el.innerText || el.textContent || '');
                if (content.length > 200) return { title: getTitle(), content, markdownReady: true };
              }
            }
            // Last resort: body text minus nav
            const body = document.body?.innerText || '';
            const content = clean(body);
            if (content.length > 300) return { title: getTitle(), content, markdownReady: true };
          } else {
            // Still on status page — try X Notes data-testid and primaryColumn
            for (const sel of ['div[data-testid="article-text"]', '[data-testid="articleContent"]', '[data-testid="primaryColumn"]']) {
              const el = document.querySelector(sel);
              if (el) {
                const content = clean(el.innerText || el.textContent || '');
                if (content.length > 200) return { title: getTitle(), content, markdownReady: true };
              }
            }
          }
          return null;
        },
      });
      const noteData = noteResults[0]?.result;
      if (noteData?.content) return noteData;
    }

    // Xiaohongshu (小红书) — JS-rendered; extract note content and CDN images from live DOM
    if (isXiaohongshuURL(url)) {
      const MAX_POLL_MS = 15000;
      const POLL_INTERVAL_MS = 800;
      const pollStart = Date.now();

      // Wait until note images or text content appear in the DOM
      await new Promise((resolve) => {
        const check = async () => {
          if (Date.now() - pollStart > MAX_POLL_MS) { resolve(); return; }
          try {
            const probe = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                const hasImages = Array.from(document.querySelectorAll('img'))
                  .some(img => /xhscdn|sns-img|ci\.xiaohongshu/.test(img.src || ''));
                const hasText = !!document.querySelector('#detail-desc, .note-content, .desc');
                return hasImages || hasText;
              },
            });
            if (probe[0]?.result) { resolve(); return; }
          } catch { /* tab not ready */ }
          setTimeout(check, POLL_INTERVAL_MS);
        };
        check();
      });

      const xhsResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const cleanText = t => (t || '').replace(/\s+/g, ' ').trim();

          const title = document.querySelector('meta[property="og:title"]')?.content
            || document.querySelector('#detail-title, .note-title, h1')?.innerText
            || document.title
            || '';

          const descEl = document.querySelector('#detail-desc, .note-content, .desc, .note-text');
          const description = descEl ? cleanText(descEl.innerText || descEl.textContent) : '';

          const authorEl = document.querySelector(
            '.author-name, .username, .user-name, .author-wrapper .name, .user-info .nickname'
          );
          const author = cleanText(authorEl?.innerText || authorEl?.textContent || '');

          // Collect XHS CDN images, deduplicated and filtered to content images
          const seen = new Set();
          const imageUrls = Array.from(document.querySelectorAll('img'))
            .map(img => img.src || img.getAttribute('src') || '')
            .filter(src => src && /xhscdn|sns-img|ci\.xiaohongshu/.test(src))
            .filter(src => {
              const key = src.split('!')[0]; // strip image-processing suffix
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });

          const hasVideo = !!document.querySelector('video, .player-container, .video-player, xg-video-container');
          return { title: cleanText(title), description, author, imageUrls, hasVideo };
        },
      });

      const xhsData = xhsResults[0]?.result;
      if (xhsData && (xhsData.description || xhsData.imageUrls?.length > 0)) {
        const lines = [];
        if (xhsData.author) lines.push(`**Author:** ${xhsData.author}`, '');
        if (xhsData.description) lines.push(xhsData.description, '');
        if (xhsData.hasVideo) {
          lines.push('> *This post contains a video that could not be saved. Visit the original URL to view it.*', '');
        }
        if (xhsData.imageUrls?.length > 0) {
          lines.push('## Images', '');
          xhsData.imageUrls.forEach((src, idx) => lines.push(`![Image ${idx + 1}](${src})`));
          lines.push('');
        }
        const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        return {
          title: xhsData.title || 'Xiaohongshu Post',
          content,
          markdownReady: true,
          imageUrls: xhsData.imageUrls || [],
        };
      }
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

    const readabilityResult = results[0]?.result || null;
    if (readabilityResult) return readabilityResult;

    // Readability fallback: try common article selectors for JS-heavy sites
    // (e.g. Next.js/React apps where Readability can't find article structure)
    const selectorResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const candidates = [
          'main article',
          'article',
          '[role="main"] article',
          '[role="main"]',
          '.post-content',
          '.article-content',
          '.entry-content',
          '.prose',
          '.content',
          'main',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 200) {
            return { title: document.title, content: el.innerHTML };
          }
        }
        return null;
      },
    });

    return selectorResults[0]?.result || null;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => { });
  }
}

// ─── File System ──────────────────────────────────────────────────────────────
async function getDirHandle() {
  const handle = await idbGet('save_dir_handle');
  if (!handle) return null;

  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    // Can't requestPermission() from service worker — signal popup
    await setStorage({ fs_permission_needed: true, folder_status: 'permission_needed' });
    await updateBadge();
    return null;
  }

  // Verify the folder still exists on disk — the handle can be permission-granted
  // but the underlying directory may have been deleted by the user.
  try {
    const iter = handle.values();
    await iter.next();
  } catch (e) {
    if (e.name === 'NotFoundError') {
      await setStorage({ fs_permission_needed: true, folder_status: 'missing' });
      await updateBadge();
      chrome.notifications.create({
        type: 'basic', iconUrl: 'docs/icon_64.png',
        title: 'Markdown Vault — Save Folder Missing',
        message: 'Your save folder no longer exists. Open Settings and select a new folder.',
      });
      return null;
    }
    throw e;
  }

  await setStorage({ fs_permission_needed: false, folder_status: 'ok' });
  return handle;
}

function slugify(text, maxLen = 60) {
  return (text || 'untitled')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // Keep unicode letters & numbers (CJK, etc.)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'untitled';
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

// Download a list of image URLs into a named subfolder; returns array of saved filenames (null on failure)
async function downloadImagesToFolder(dirHandle, folderName, imageUrls) {
  let subDir;
  try {
    subDir = await dirHandle.getDirectoryHandle(folderName, { create: true });
  } catch {
    console.warn('[markdown-vault] Cannot create image folder:', folderName);
    return imageUrls.map(() => null);
  }

  const paths = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const remoteUrl = imageUrls[i];
    try {
      const resp = await fetch(remoteUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();

      // Derive extension from Content-Type header, fallback to URL path
      let ext = 'jpg';
      const imgContentType = (resp.headers.get('content-type') || '').split(';')[0].trim();
      if (imgContentType.startsWith('image/')) {
        const ctExt = imgContentType.split('/')[1];
        if (ctExt === 'jpeg') ext = 'jpg';
        else if (ctExt === 'svg+xml') ext = 'svg';
        else if (ctExt) ext = ctExt;
      } else {
        try {
          const urlPath = new URL(remoteUrl).pathname;
          const parts = urlPath.split('.');
          if (parts.length > 1) ext = parts.pop().split('?')[0].toLowerCase() || 'jpg';
        } catch { /* use default */ }
      }

      const imgFilename = `${String(i + 1).padStart(2, '0')}.${ext}`;
      const fh = await subDir.getFileHandle(imgFilename, { create: true });
      const writable = await fh.createWritable();
      await writable.write(buffer);
      await writable.close();
      paths.push(imgFilename);
    } catch (err) {
      console.warn(`[markdown-vault] Failed to download image ${i + 1} (${remoteUrl}):`, err);
      paths.push(null);
    }
  }
  return paths;
}

// ─── Markdown Building ────────────────────────────────────────────────────────
function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') {
      const escaped = v
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');
      lines.push(`${k}: "${escaped}"`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function escapeMarkdownHeading(text) {
  // Escape chars that could create unintended markdown formatting in a heading line
  return (text || '').replace(/([\\`*_{}[\]()#+\-.!|~>])/g, '\\$&');
}

function buildArticleMarkdown({ title, url, savedAt, markdown, includeFrontmatter }) {
  const cleanTitle = sanitizeTitle(title);
  const displayUrl = sanitizeUrlForDisplay(url);
  const fm = includeFrontmatter
    ? buildFrontmatter({ title: cleanTitle, url: displayUrl, saved_at: savedAt, source: 'markdown-vault' })
    : '';
  return `${fm}# ${escapeMarkdownHeading(cleanTitle)}\n\n${markdown}\n`;
}

function buildErrorMarkdown({ url, error, savedAt, includeFrontmatter }) {
  const displayUrl = sanitizeUrlForDisplay(url);
  const fm = includeFrontmatter
    ? buildFrontmatter({ url: displayUrl, saved_at: savedAt, source: 'markdown-vault', status: 'error' })
    : '';
  return `${fm}# Save Error\n\nFailed to save: ${displayUrl}\n\n**Error:** ${error}\n\n**Time:** ${savedAt}\n`;
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
      iconUrl: 'docs/icon_64.png',
      title: '⚠️ Markdown Vault — Disconnected',
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

// ─── Notification + save helpers (shared by all handlers) ────────────────────
async function notifyAndRecord(title, filename, url, savedAt) {
  chrome.notifications.create({
    type: 'basic', iconUrl: 'docs/icon_64.png',
    title: 'Saved as Markdown',
    message: `"${title.slice(0, 60)}" → ${filename}`,
  });
  await addRecentSave({ title, filename, url, saved_at: savedAt });
}

// ─── URL Processing ───────────────────────────────────────────────────────────
async function processURLWithRetry(url, attemptIndex, messageCtx, settings) {
  const dirHandle = await getDirHandle();
  if (!dirHandle) {
    console.warn('[markdown-vault] No directory handle — skipping URL save');
    return;
  }

  const { bot_token, include_frontmatter = true, use_gfm = true } = settings;
  const savedAt = new Date().toISOString();

  try {
    // ── Pre-fetch routing: YouTube (does its own fetch) ──────────────────────
    const preType = classifyUrl(url);
    if (preType === 'youtube') {
      console.log('[markdown-vault] YouTube detected:', url);
      const result = await handleYouTube(url, dirHandle, settings);
      await notifyAndRecord(result.title, result.filename, url, savedAt);
      await clearPendingRetry(url);
      return;
    }

    // Step 1: Fetch the page
    let html, finalUrl, binaryData, contentType, contentDisposition;
    try {
      ({ html, finalUrl, binaryData, contentType, contentDisposition } = await fetchURL(url));
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
          type: 'basic', iconUrl: 'docs/icon_64.png',
          title: 'Markdown Vault — Save Failed',
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
        type: 'basic', iconUrl: 'docs/icon_64.png',
        title: 'Markdown Vault — Save Failed (all retries)',
        message: `Failed to save ${url} after ${MAX_RETRIES} attempts.\nLast error: ${fetchErr.message}`,
      });
      return;
    }

    // Step 1b: Route based on content type (binary or XML)
    const effectiveUrl = finalUrl || url;
    const postType = classifyUrl(effectiveUrl, contentType);

    // RSS feeds (returned as text/html via fetchURL after our XML content-type fix)
    if (postType === 'rss' || (html && (contentType || '').match(/rss|atom|feed/))) {
      console.log('[markdown-vault] RSS feed detected:', effectiveUrl);
      const result = await handleRss(effectiveUrl, dirHandle, settings, html);
      await notifyAndRecord(result.title, result.filename, url, savedAt);
      await clearPendingRetry(url);
      return;
    }

    if (binaryData) {
      const fetchResult = { binaryData, contentType, contentDisposition };

      if (postType === 'pdf') {
        console.log('[markdown-vault] PDF detected:', effectiveUrl);
        const result = await handlePdf(effectiveUrl, dirHandle, settings, fetchResult);
        await notifyAndRecord(result.title, result.filename, url, savedAt);
        await clearPendingRetry(url);
        return;
      }

      if (postType === 'direct-audio') {
        console.log('[markdown-vault] Audio file detected:', effectiveUrl);
        const result = await handleDirectMedia(effectiveUrl, dirHandle, settings, fetchResult, 'audio');
        await notifyAndRecord(result.title, result.filename, url, savedAt);
        await clearPendingRetry(url);
        return;
      }

      if (postType === 'direct-video') {
        console.log('[markdown-vault] Video file detected:', effectiveUrl);
        const result = await handleDirectMedia(effectiveUrl, dirHandle, settings, fetchResult, 'video');
        await notifyAndRecord(result.title, result.filename, url, savedAt);
        await clearPendingRetry(url);
        return;
      }

      if (postType === 'direct-image') {
        console.log('[markdown-vault] Image URL detected:', effectiveUrl);
        const result = await handleDirectImage(effectiveUrl, dirHandle, settings, fetchResult);
        await clearPendingRetry(url);
        return;
      }

      // Unknown binary — save file to date subfolder + create companion .md
      let ext = 'bin';
      if (contentType) {
        const ctParts = contentType.split('/');
        if (ctParts.length === 2) ext = ctParts[1].split(';')[0].trim();
        if (ext === 'jpeg') ext = 'jpg';
        if (ext === 'svg+xml') ext = 'svg';
      }
      try {
        const urlPath = new URL(url).pathname;
        const urlExt = urlPath.split('.').pop()?.toLowerCase();
        if (urlExt && urlExt.length <= 5 && /^[a-z0-9]+$/.test(urlExt)) ext = urlExt;
      } catch { /* use content-type ext */ }

      const date = dateString();
      const basename = slugify(new URL(url).pathname.split('/').pop()?.replace(/\.[^.]+$/, '') || 'download');
      const binaryFilename = `${date}-${basename}.${ext}`;
      const savedPath = await (async () => {
        let dayDir;
        try {
          dayDir = await dirHandle.getDirectoryHandle(date, { create: true });
        } catch {
          dayDir = dirHandle;
        }
        const fh = await dayDir.getFileHandle(binaryFilename, { create: true });
        const w = await fh.createWritable();
        await w.write(binaryData);
        await w.close();
        return `${date}/${binaryFilename}`;
      })();

      // Companion .md with metadata
      const sizeMB = (binaryData.byteLength / 1024 / 1024).toFixed(2);
      const fmFields = {
        title: basename,
        url: sanitizeUrlForDisplay(url),
        saved_at: savedAt,
        source: 'markdown-vault',
        type: ext,
        file: `./${savedPath}`,
        size_mb: sizeMB,
      };
      const { include_frontmatter = true, file_naming_pattern } = settings;
      const fm = include_frontmatter ? buildFrontmatter(fmFields) : '';
      const mdContent = (
        `${fm}# ${escapeMarkdownHeading(basename)}\n\n` +
        `> File saved to \`./${savedPath}\` (${sizeMB} MB)\n\n` +
        `Source: ${sanitizeUrlForDisplay(url)}\n`
      );
      const mdFilename = buildFilename(basename, file_naming_pattern);
      const savedMdName = await saveMarkdownFile(dirHandle, mdFilename, mdContent);

      chrome.notifications.create({
        type: 'basic', iconUrl: 'docs/icon_64.png',
        title: 'Saved File',
        message: `Downloaded: ${binaryFilename}`,
      });
      await addRecentSave({ title: basename, filename: savedMdName, url, saved_at: savedAt });
      await clearPendingRetry(url);
      return;
    }

    // Podcast pages: handle before generic HTML parsing
    if (postType === 'podcast') {
      console.log('[markdown-vault] Podcast page detected:', effectiveUrl);
      const result = await handlePodcast(effectiveUrl, html, dirHandle, settings);
      await notifyAndRecord(result.title, result.filename, url, savedAt);
      await clearPendingRetry(url);
      return;
    }

    const useLiveDomFirst = isTwitterStatusURL(finalUrl || url) || isXiaohongshuURL(finalUrl || url);

    // Step 2: Parse HTML → Readability → Markdown
    let parsed = null;
    if (!useLiveDomFirst) {
      try {
        parsed = await parseHtmlViaOffscreen(html, finalUrl || url, use_gfm);
      } catch (parseErr) {
        console.warn('[markdown-vault] Offscreen parse failed:', parseErr);
      }
    }

    // Step 3: If insufficient content, try background tab (JS-rendered pages)
    if (useLiveDomFirst || !parsed || !parsed.content || parsed.content.length < MIN_ARTICLE_LENGTH) {
      console.log('[markdown-vault] Falling back to background tab for:', url);
      try {
        const tabResult = await fetchWithBackgroundTab(url);
        if (tabResult?.content) {
          if (tabResult.markdownReady) {
            parsed = {
              title: tabResult.title || parsed?.title || url,
              content: tabResult.content,
              success: true,
              imageUrls: tabResult.imageUrls || [],
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
        console.warn('[markdown-vault] Background tab failed:', tabErr);
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
        console.warn('[markdown-vault] Offscreen fallback parse failed:', parseErr);
      }
    }

    // Last resort for X/Twitter: try oEmbed API
    if ((!parsed || !parsed.content) && isTwitterStatusURL(url)) {
      console.log('[markdown-vault] Trying oEmbed fallback for:', url);
      const oembedResult = await fetchTweetViaOEmbed(url);
      if (oembedResult?.content) {
        parsed = {
          title: oembedResult.title,
          content: oembedResult.content,
          success: true,
        };
      }
    }

    if (!parsed?.content || !parsed.content.trim()) {
      const errorMd = buildErrorMarkdown({
        url, error: 'Could not extract any readable content from this page',
        savedAt, includeFrontmatter: include_frontmatter,
      });
      const filename = `${dateString()}-error-${slugify(url.replace(/https?:\/\//, '').slice(0, 40))}.md`;
      await saveMarkdownFile(dirHandle, filename, errorMd);
      return;
    }

    const title = sanitizeTitle(parsed.title || new URL(url).hostname);
    const mdFilename = buildFilename(title, settings.file_naming_pattern);

    // Resolve unique file handle first so we know the final name before writing
    const fileHandle = await getUniqueFileHandle(dirHandle, mdFilename);
    const savedName = fileHandle.name;

    // Download XHS images into a folder named after the saved MD file
    let articleContent = parsed.content;
    const imageUrlsToDownload = parsed.imageUrls || [];
    if (imageUrlsToDownload.length > 0) {
      const folderName = savedName.replace(/\.md$/, '');
      try {
        const localPaths = await downloadImagesToFolder(dirHandle, folderName, imageUrlsToDownload);
        imageUrlsToDownload.forEach((remoteUrl, i) => {
          if (localPaths[i]) {
            articleContent = articleContent.split(remoteUrl).join(`./${folderName}/${localPaths[i]}`);
          }
        });
      } catch (imgErr) {
        console.warn('[markdown-vault] Failed to download XHS images:', imgErr);
        // Keep remote URLs — content unchanged
      }
    }

    const markdown = buildArticleMarkdown({
      title,
      url,
      savedAt,
      markdown: articleContent,
      includeFrontmatter: include_frontmatter,
    });

    await writeFile(fileHandle, markdown);

    // Notify
    chrome.notifications.create({
      type: 'basic', iconUrl: 'docs/icon_64.png',
      title: 'Saved as Markdown',
      message: `"${title.slice(0, 60)}" → ${savedName}`,
    });

    await addRecentSave({ title, filename: savedName, url, saved_at: savedAt });
    await clearPendingRetry(url);

  } catch (err) {
    console.error('[markdown-vault] Unexpected error processing URL:', url, err);

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
        await saveMarkdownFile(dirH, filename, errorMd).catch(() => { });
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
      if (message.document.file_size && message.document.file_size > 20 * 1024 * 1024) {
        const sizeMB = Math.round(message.document.file_size / 1024 / 1024);
        const entry = `*Image too large to download (${sizeMB}MB — Telegram limit is 20MB)*`;
        await appendToDaily(dirHandle, entry, date);
        return;
      }
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
    const imgFilename = `${date}-${Date.now()}.${ext}`;

    const savedPath = await saveImageToFolder(dirHandle, date, imgFilename, arrayBuffer);

    const caption = message.caption ? `\n\n${message.caption}` : '';
    const entry = `![Image](./${savedPath})${caption}`;
    await appendToDaily(dirHandle, entry, date);
  } catch (err) {
    console.error('[markdown-vault] Image processing error:', err);
    const entry = `*Failed to save image: ${err.message}*`;
    await appendToDaily(dirHandle, entry, date);
  }
}

// ─── Document Message Processing ─────────────────────────────────────────────
async function processDocumentMessage(message, token, date, dirHandle) {
  try {
    const doc = message.document;
    if (!doc?.file_id) return;

    // Check Telegram's 20MB download limit
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const entry = `*Received document "${doc.file_name || 'unnamed'}" (${sizeMB}MB) — too large to download (Telegram limit is 20MB)*`;
      await appendToDaily(dirHandle, entry, date);
      return;
    }

    const fileInfo = await getTelegramFileInfo(token, doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const resp = await fetch(fileUrl);
    if (!resp.ok) throw new Error(`Failed to download document: HTTP ${resp.status}`);

    const buffer = await resp.arrayBuffer();
    const filename = doc.file_name || `${Date.now()}.${(doc.file_name || fileInfo.file_path || '').split('.').pop() || 'bin'}`;

    // Save to date subfolder
    let dayDir;
    try {
      dayDir = await dirHandle.getDirectoryHandle(date, { create: true });
    } catch {
      dayDir = dirHandle;
    }

    const fh = await dayDir.getFileHandle(filename, { create: true });
    const writable = await fh.createWritable();
    await writable.write(buffer);
    await writable.close();

    const caption = message.caption ? `\n\n${message.caption}` : '';
    const entry = `**Document saved:** [${filename}](./${date}/${filename})${caption}`;
    await appendToDaily(dirHandle, entry, date);
  } catch (err) {
    console.error('[markdown-vault] Document processing error:', err);
    const entry = `*Failed to save document: ${err.message}*`;
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
  } else if (message.document) {
    // Non-image document (PDF, etc.) — save the file directly
    const dirHandle = await getDirHandle();
    if (dirHandle) {
      await processDocumentMessage(message, token, date, dirHandle);
    }
  } else if (message.text || message.caption) {
    // Plain text — append to daily file
    const text = message.text || message.caption;
    const dirHandle = await getDirHandle();
    if (dirHandle) {
      await processTextMessage(text, date, dirHandle, include_frontmatter);
    }
  } else if (message.sticker || message.voice || message.video_note || message.video || message.audio || message.location || message.contact) {
    // Unsupported message types — log to daily file
    const msgType = message.sticker ? 'sticker' : message.voice ? 'voice message' :
      message.video_note ? 'video note' : message.video ? 'video' :
      message.audio ? 'audio' : message.location ? 'location' : 'contact';
    const dirHandle = await getDirHandle();
    if (dirHandle) {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const entry = `**${timestamp}** — *Received ${msgType} (not supported for saving)*`;
      await appendToDaily(dirHandle, entry, date);
    }
  }
}

// ─── Main Poll ────────────────────────────────────────────────────────────────
let _pollLock = false;

async function poll() {
  if (_pollLock) return;
  _pollLock = true;
  try {

  const { bot_token, setup_complete, is_polling_active } = await getStorage([
    'bot_token', 'setup_complete', 'is_polling_active',
  ]);

  if (!setup_complete || !bot_token) return;
  if (is_polling_active === false) return;

  // Verify the save folder is accessible before hitting Telegram API.
  // If the folder is missing or permission was revoked, enter broken mode
  // and skip polling until the user fixes the folder in Settings.
  const folderHandle = await getDirHandle();
  if (!folderHandle) {
    await updateBadge();
    return;
  }

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
        // Save after each message to prevent duplicates on crash
        await setStorage({ last_update_id });
      }
    }

    // Update last successful poll time
    await setStorage({ last_successful_poll: new Date().toISOString() });
    await updateBadge();

  } catch (err) {
    console.error('[markdown-vault] Poll error:', err);
    await setStorage({ last_telegram_error: err.message });
    await updateBadge();
  }

  // Also process any pending retries
  await processPendingRetries();

  } finally { _pollLock = false; }
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

// ─── Context Menu ─────────────────────────────────────────────────────────────
async function setupContextMenu() {
  await chrome.contextMenus.removeAll();
  const { context_menu_enabled = true } = await getStorage(['context_menu_enabled']);
  if (!context_menu_enabled) return;
  chrome.contextMenus.create({
    id: 'save-to-vault',
    title: 'Save to Markdown Vault',
    contexts: ['link', 'page'],
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.pageUrl;
  if (!url || !/^https?:\/\//.test(url)) return;
  const settings = await getSettings();
  await processURLWithRetry(url, 0, { manual: true, from: 'context_menu' }, settings);
});

// ─── Event Listeners ──────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  await setupContextMenu();
});

chrome.runtime.onInstalled.addListener(async details => {
  const { setup_complete } = await getStorage(['setup_complete']);

  // Only auto-open onboarding on a fresh install, not on extension updates.
  // On updates, setup_complete is preserved in storage; auto-opening onboarding
  // would force the user to redo setup unnecessarily.
  if (details.reason === 'install' && !setup_complete) {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/onboarding/onboarding.html') });
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
    folder_status: 'unknown',
    last_telegram_error: null,
    context_menu_enabled: true,
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

  // On update, proactively check if the stored directory handle still has
  // permission (it may be revoked after extension reload/update). This ensures
  // the badge and popup reflect the correct state immediately rather than only
  // after the first URL is processed.
  if (details.reason === 'update' && setup_complete) {
    await getDirHandle();
  }

  await setupContextMenu();
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
          'folder_status', 'last_telegram_error', 'pending_retries', 'last_update_id',
          'include_frontmatter', 'use_gfm', 'file_naming_pattern', 'context_menu_enabled',
        ]);
        // Don't expose raw token — just whether one is set
        const hasToken = !!state.bot_token;
        delete state.bot_token;
        // Include next scheduled poll time
        const alarm = await chrome.alarms.get(ALARM_NAME);
        const next_poll_time = alarm?.scheduledTime || null;
        return { ...state, has_token: hasToken, next_poll_time };
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
        if (settings.context_menu_enabled !== undefined) toSave.context_menu_enabled = settings.context_menu_enabled;
        await setStorage(toSave);
        if (settings.context_menu_enabled !== undefined) await setupContextMenu();
        await updateBadge();
        return { success: true };
      }

      case 'request_fs_permission': {
        // Can't do this from service worker — popup/onboarding must handle it
        return { error: 'Must be called from popup context' };
      }

      case 'fs_permission_granted': {
        await setStorage({ fs_permission_needed: false, folder_status: 'ok' });
        await updateBadge();
        return { success: true };
      }

      case 'save_url': {
        const settings = await getSettings();
        await processURLWithRetry(message.url, 0, { manual: true }, settings);
        return { success: true };
      }

      case 'save_clipboard_image': {
        const dirHandle = await getDirHandle();
        if (!dirHandle) throw new Error('No save folder configured');
        const { dataUrl, mimeType } = message;
        const ext = (mimeType || 'image/png').split('/')[1]?.split('+')[0] || 'png';
        const d = dateString();
        const imgFilename = `${d}-${Date.now()}.${ext}`;
        const base64 = dataUrl.split(',')[1] || '';
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const savedPath = await saveImageToFolder(dirHandle, d, imgFilename, bytes.buffer);
        await appendToDaily(dirHandle, `![Clipboard image](./${savedPath})`, d);
        await addRecentSave({ title: 'Clipboard image', filename: imgFilename, url: 'clipboard', saved_at: new Date().toISOString() });
        return { success: true };
      }

      case 'save_clipboard_text': {
        const dirHandle = await getDirHandle();
        if (!dirHandle) throw new Error('No save folder configured');
        const d = dateString();
        await appendToDaily(dirHandle, message.text, d);
        await addRecentSave({ title: message.text.slice(0, 60), filename: `${d}.md`, url: 'clipboard', saved_at: new Date().toISOString() });
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
  if (setup_complete) {
    // Proactively check FS permission on browser startup — the stored directory
    // handle loses its granted permission after the browser restarts. Checking
    // here ensures the badge and popup show the correct state immediately,
    // rather than only after the first URL is received from Telegram.
    await getDirHandle();

    if (is_polling_active !== false) {
      await setupAlarm(poll_interval);
      await poll();
    }
  }
  await updateBadge();
});
