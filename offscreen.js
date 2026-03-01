// Save as MD — Offscreen Document
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

  return false;
});
