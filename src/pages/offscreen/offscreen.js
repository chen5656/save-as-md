// Markdown Vault — Offscreen Document
// Handles DOM parsing (DOMParser not available in service workers).
// Receives HTML from the service worker, runs Readability, converts with Turndown.

'use strict';

function makeTurndown(useGFM) {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    hr: '---',
    bulletListMarker: '-',
    strongDelimiter: '**',
    emDelimiter: '*',
  });

  if (useGFM && typeof turndownPluginGfm !== 'undefined') {
    td.use(turndownPluginGfm.gfm);
  }

  // Strip noise elements before conversion
  td.remove(['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'header']);
  return td;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted at this offscreen document
  if (message.target !== 'offscreen') return false;

  if (message.type === 'parse_html') {
    // Full pipeline: raw page HTML → Readability → Turndown → Markdown
    try {
      const { html, url, useGFM } = message;

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Set <base> so relative URLs resolve correctly
      const base = doc.createElement('base');
      base.href = url;
      if (doc.head) doc.head.prepend(base);

      const reader = new Readability(doc, { charThreshold: 100, keepClasses: false });
      const article = reader.parse();

      if (!article || !article.content) {
        sendResponse({ success: false, error: 'Readability found no article content' });
        return true;
      }

      const td = makeTurndown(useGFM);
      const markdown = td.turndown(article.content);

      sendResponse({
        success: true,
        title: article.title || '',
        excerpt: article.excerpt || '',
        byline: article.byline || '',
        siteName: article.siteName || '',
        content: markdown,
        length: markdown.length,
      });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }

    return true;
  }

  if (message.type === 'convert_html') {
    // Turndown only — for already-extracted article HTML (e.g. from background tab Readability)
    try {
      const { title, html, url, useGFM } = message;
      const td = makeTurndown(useGFM);
      const markdown = td.turndown(html || '');

      sendResponse({ success: true, title: title || '', content: markdown, length: markdown.length });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }

    return true;
  }

  if (message.type === 'parse_rss') {
    // Parse RSS 2.0 or Atom XML using DOMParser (not available in service workers)
    try {
      const { xml, url } = message;
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'application/xml');

      // Check for parse errors
      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        // Try text/xml as fallback
        const doc2 = parser.parseFromString(xml, 'text/xml');
        const pe2 = doc2.querySelector('parsererror');
        if (pe2) {
          sendResponse({ success: false, error: 'XML parse error: ' + pe2.textContent });
          return true;
        }
      }

      const workingDoc = parseError
        ? parser.parseFromString(xml, 'text/xml')
        : doc;

      const isAtom = !!workingDoc.querySelector('feed');
      const result = isAtom
        ? parseAtomFeed(workingDoc, url)
        : parseRssFeed(workingDoc, url);

      sendResponse({ success: true, ...result });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }

    return true;
  }

  return false;
});

// ─── RSS 2.0 Parser ───────────────────────────────────────────────────────────

function parseRssFeed(doc, feedUrl) {
  const channel = doc.querySelector('channel');
  const feedTitle       = getText(channel, 'title');
  const feedDescription = getText(channel, 'description');
  const feedLink        = getText(channel, 'link');

  const items = Array.from(doc.querySelectorAll('item')).map(item => {
    const title       = getText(item, 'title');
    const link        = getText(item, 'link');
    const description = getText(item, 'description');
    const pubDate     = getText(item, 'pubDate');
    const guid        = getText(item, 'guid');

    // Enclosure (audio/video file)
    const enclosure = item.querySelector('enclosure');
    const enclosureUrl  = enclosure?.getAttribute('url') || null;
    const enclosureType = enclosure?.getAttribute('type') || null;

    // Podcasting 2.0 transcript
    const transcriptEl = item.querySelector('transcript') ||
      item.querySelector('[nodeName="podcast:transcript"]') ||
      findNsElement(item, 'podcast', 'transcript');

    const transcriptUrl  = transcriptEl?.getAttribute('url') || null;
    const transcriptType = transcriptEl?.getAttribute('type') || null;

    return { title, link: link || guid, description, pubDate, enclosureUrl, enclosureType, transcriptUrl, transcriptType };
  });

  return { feedTitle, feedDescription, feedLink, items };
}

// ─── Atom Parser ──────────────────────────────────────────────────────────────

function parseAtomFeed(doc, feedUrl) {
  const feed = doc.querySelector('feed');
  const feedTitle       = getText(feed, 'title');
  const feedDescription = getText(feed, 'subtitle') || getText(feed, 'summary');
  const feedLink        = getLinkHref(feed, 'alternate') || getLinkHref(feed, null);

  const items = Array.from(doc.querySelectorAll('entry')).map(entry => {
    const title       = getText(entry, 'title');
    const link        = getLinkHref(entry, 'alternate') || getLinkHref(entry, null);
    const description = getText(entry, 'summary') || getText(entry, 'content');
    const pubDate     = getText(entry, 'published') || getText(entry, 'updated');

    // Podcasting 2.0 transcript
    const transcriptEl = findNsElement(entry, 'podcast', 'transcript');
    const transcriptUrl  = transcriptEl?.getAttribute('url') || null;
    const transcriptType = transcriptEl?.getAttribute('type') || null;

    return { title, link, description, pubDate, enclosureUrl: null, enclosureType: null, transcriptUrl, transcriptType };
  });

  return { feedTitle, feedDescription, feedLink, items };
}

// ─── XML helpers ──────────────────────────────────────────────────────────────

function getText(parent, tagName) {
  if (!parent) return null;
  const el = parent.querySelector(tagName);
  if (!el) return null;
  // Use textContent; for CDATA sections this is already decoded
  return el.textContent?.trim() || null;
}

function getLinkHref(parent, rel) {
  if (!parent) return null;
  const links = Array.from(parent.querySelectorAll('link'));
  for (const link of links) {
    const linkRel = link.getAttribute('rel');
    if (rel === null || linkRel === rel || (!linkRel && rel === 'alternate')) {
      const href = link.getAttribute('href') || link.textContent?.trim();
      if (href) return href;
    }
  }
  return null;
}

function findNsElement(parent, prefix, localName) {
  if (!parent) return null;
  // Try common Podcasting 2.0 namespace patterns
  const candidates = [
    `${prefix}\\:${localName}`,
    `${prefix}:${localName}`,
    localName,
  ];
  for (const selector of candidates) {
    try {
      const el = parent.querySelector(selector);
      if (el) return el;
    } catch { /* invalid selector, skip */ }
  }
  // Manual search through children for namespace-prefixed elements
  const all = parent.getElementsByTagNameNS('*', localName);
  if (all.length > 0) return all[0];
  return null;
}
