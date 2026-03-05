// Markdown Vault — HTML Metadata Extraction
// Regex-based og:, twitter:, JSON-LD extraction — no DOM required, runs in service worker.

'use strict';

function decodeHtmlEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Parse all <meta> tags into a flat map of { property/name → content }
function parseMetaTags(html) {
  const tags = {};
  // Match opening/self-closing meta tags (handles multiline attributes)
  const metaRe = /<meta\s([^>]*?)(?:\s*\/?)>/gis;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1];
    // Extract property or name attribute (first wins)
    const propM = /(?:^|\s)(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const contentM = /(?:^|\s)content\s*=\s*["']([^"']*?)["']/i.exec(attrs);
    if (propM && contentM) {
      const key = propM[1].toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(tags, key)) {
        tags[key] = decodeHtmlEntities(contentM[1]);
      }
    }
  }
  return tags;
}

function getPageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeHtmlEntities(m[1].replace(/\s+/g, ' ').trim()) : null;
}

// Recursively collect JSON-LD candidates with @type + name/description
function collectJsonLdCandidates(data, out) {
  if (!data) return;
  if (Array.isArray(data)) {
    for (const item of data) collectJsonLdCandidates(item, out);
    return;
  }
  if (typeof data !== 'object') return;

  if (Array.isArray(data['@graph'])) {
    collectJsonLdCandidates(data['@graph'], out);
  }

  const rawType = data['@type'];
  let type = null;
  if (typeof rawType === 'string') type = rawType.toLowerCase();
  else if (Array.isArray(rawType)) {
    const found = rawType.find(t => typeof t === 'string');
    if (found) type = found.toLowerCase();
  }

  if (type) {
    const title = data.name || data.headline || data.title || null;
    const description = data.description || data.summary || null;
    if (title || description) {
      out.push({
        type,
        title: typeof title === 'string' ? title.trim() : null,
        description: typeof description === 'string' ? description.trim() : null,
      });
    }
  }
}

function extractJsonLd(html) {
  const candidates = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      collectJsonLdCandidates(data, candidates);
    } catch { /* malformed JSON-LD, skip */ }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0));
  return candidates[0];
}

/**
 * Extract og:, twitter:, JSON-LD, and <title> metadata from raw HTML.
 * Returns { title, description, siteName, imageUrl, author, published, type }
 */
function extractMetadata(html, url) {
  if (!html) return { title: null, description: null, siteName: null, imageUrl: null, author: null, published: null, type: null };

  const meta   = parseMetaTags(html);
  const jsonLd = extractJsonLd(html);

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch {}

  const title = (
    meta['og:title'] ||
    meta['twitter:title'] ||
    jsonLd?.title ||
    getPageTitle(html) ||
    null
  );

  const description = (
    meta['og:description'] ||
    meta['description'] ||
    meta['twitter:description'] ||
    jsonLd?.description ||
    null
  );

  return {
    title:       title       ? title.trim()       : null,
    description: description ? description.trim() : null,
    siteName:    meta['og:site_name'] || meta['application-name'] || hostname || null,
    imageUrl:    meta['og:image'] || meta['twitter:image'] || null,
    author:      meta['article:author'] || meta['author'] || null,
    published:   meta['article:published_time'] || meta['date'] || null,
    type:        meta['og:type'] || jsonLd?.type || null,
  };
}
