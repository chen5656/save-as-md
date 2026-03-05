// Markdown Vault — RSS / Atom Feed Handler
// Fetches and parses RSS 2.0, Atom, and JSON Feed formats.
// XML parsing is delegated to the offscreen document (DOMParser not in SW).

'use strict';

const RSS_MAX_ITEMS = 50;

async function handleRss(url, dirHandle, settings, xmlText) {
  const { include_frontmatter = true, file_naming_pattern } = settings;
  const savedAt = new Date().toISOString();

  // If xmlText wasn't already fetched (e.g. came back as binary), fetch fresh
  if (!xmlText) {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MarkdownVault/1.0)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!resp.ok) {
      throw Object.assign(
        new Error(`RSS fetch failed: HTTP ${resp.status}`),
        { retryable: resp.status >= 500 }
      );
    }
    xmlText = await resp.text();
  }

  // Parse via offscreen document (DOMParser for XML)
  let parsed;
  try {
    parsed = await offscreenMessage({ type: 'parse_rss', xml: xmlText, url });
  } catch (e) {
    throw new Error(`RSS parsing failed: ${e.message}`);
  }

  const { feedTitle, feedDescription, items = [] } = parsed;
  const title        = feedTitle || new URL(url).hostname;
  const limitedItems = items.slice(0, RSS_MAX_ITEMS);

  const fmFields = {
    title:      sanitizeTitle(title),
    url:        sanitizeUrlForDisplay(url),
    saved_at:   savedAt,
    source:     'markdown-vault',
    type:       'rss-feed',
    item_count: limitedItems.length,
  };
  const fm = include_frontmatter ? buildFrontmatter(fmFields) : '';

  const lines = [`# ${escapeMarkdownHeading(sanitizeTitle(title))}`, ''];
  if (feedDescription) lines.push(feedDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), '');
  lines.push('## Items', '');

  for (const item of limitedItems) {
    const itemTitle = item.title || '(Untitled)';
    const itemLink  = item.link  || '';
    const itemDate  = item.pubDate ? ` — ${item.pubDate.slice(0, 10)}` : '';
    const rawDesc   = item.description || '';
    // Strip HTML tags, truncate
    const itemDesc  = rawDesc
      ? '\n  ' + rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
      : '';

    if (itemLink) {
      lines.push(`- **[${itemTitle}](${itemLink})**${itemDate}${itemDesc}`, '');
    } else {
      lines.push(`- **${itemTitle}**${itemDate}${itemDesc}`, '');
    }
  }

  const content    = fm + lines.join('\n');
  const cleanTitle = sanitizeTitle(title);
  const filename   = buildFilename(cleanTitle, file_naming_pattern);
  const savedName  = await saveMarkdownFile(dirHandle, filename, content);

  return { title: cleanTitle, filename: savedName };
}
