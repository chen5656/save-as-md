// Markdown Vault — Media Handler
// Handles PDF, direct audio/video URLs, and standalone image URLs.
// Downloads binary files to date subfolders and creates companion Markdown stubs.

'use strict';

const PDF_MAX_SIZE   = 50  * 1024 * 1024; // 50 MB
const MEDIA_MAX_SIZE = 200 * 1024 * 1024; // 200 MB
const IMAGE_MAX_SIZE = 20  * 1024 * 1024; // 20 MB

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').pop() || '';
    const decoded = decodeURIComponent(last);
    return decoded || null;
  } catch { return null; }
}

function getFilenameFromContentDisposition(header) {
  if (!header) return null;
  // Handles both filename= and filename*=UTF-8''...
  const m = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i.exec(header);
  return m ? decodeURIComponent(m[1].trim()).replace(/^["']|["']$/g, '') : null;
}

async function saveBinaryToDateFolder(dirHandle, date, filename, arrayBuffer) {
  let dayDir;
  try {
    dayDir = await dirHandle.getDirectoryHandle(date, { create: true });
  } catch {
    dayDir = dirHandle; // fallback to root
  }
  const fh = await dayDir.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(arrayBuffer);
  await writable.close();
  return `${date}/${filename}`;
}

// ─── PDF Handler ──────────────────────────────────────────────────────────────

async function handlePdf(url, dirHandle, settings, fetchResult) {
  const { include_frontmatter = true, file_naming_pattern } = settings;
  const savedAt = new Date().toISOString();
  const date    = dateString();

  const { binaryData, contentDisposition, html } = fetchResult;

  if (binaryData && binaryData.byteLength > PDF_MAX_SIZE) {
    const sizeMB = Math.round(binaryData.byteLength / 1024 / 1024);
    throw new Error(`PDF too large to save (${sizeMB} MB — limit is ${PDF_MAX_SIZE / 1024 / 1024} MB)`);
  }

  // Try to get title from HTML redirect page metadata, then fall back to filename
  let title = null;
  if (html) {
    const meta = extractMetadata(html, url);
    title = meta.title || null;
  }

  const rawFilename = getFilenameFromContentDisposition(contentDisposition) || getFilenameFromUrl(url);
  const fileSlug    = slugify((rawFilename?.replace(/\.pdf$/i, '') || title || 'document').slice(0, 60));
  const pdfFilename = `${fileSlug}.pdf`;

  if (!title) title = rawFilename?.replace(/\.pdf$/i, '') || 'PDF Document';

  const savedPath = await saveBinaryToDateFolder(dirHandle, date, pdfFilename, binaryData);

  const fmFields = {
    title:    sanitizeTitle(title),
    url:      sanitizeUrlForDisplay(url),
    saved_at: savedAt,
    source:   'markdown-vault',
    type:     'pdf',
    file:     `./${savedPath}`,
  };
  const fm = include_frontmatter ? buildFrontmatter(fmFields) : '';
  const cleanTitle = sanitizeTitle(title);
  const content = (
    `${fm}# ${escapeMarkdownHeading(cleanTitle)}\n\n` +
    `> PDF saved to \`./${savedPath}\`\n\n` +
    `Source: ${sanitizeUrlForDisplay(url)}\n`
  );

  const mdFilename = buildFilename(cleanTitle, file_naming_pattern);
  const savedName  = await saveMarkdownFile(dirHandle, mdFilename, content);

  return { title: cleanTitle, filename: savedName };
}

// ─── Direct Audio / Video Handler ────────────────────────────────────────────

async function handleDirectMedia(url, dirHandle, settings, fetchResult, mediaKind) {
  const { include_frontmatter = true, file_naming_pattern } = settings;
  const savedAt = new Date().toISOString();
  const date    = dateString();

  const { binaryData, contentDisposition, contentType } = fetchResult;

  if (binaryData && binaryData.byteLength > MEDIA_MAX_SIZE) {
    const sizeMB = Math.round(binaryData.byteLength / 1024 / 1024);
    throw new Error(`${mediaKind} file too large (${sizeMB} MB — limit is ${MEDIA_MAX_SIZE / 1024 / 1024} MB)`);
  }

  // Determine file extension
  const rawFilename = getFilenameFromContentDisposition(contentDisposition) || getFilenameFromUrl(url);
  let ext = '';
  if (rawFilename) {
    const dot = rawFilename.lastIndexOf('.');
    if (dot >= 0) ext = rawFilename.slice(dot + 1).toLowerCase();
  }
  if (!ext && contentType) {
    const ct = contentType.toLowerCase().split(';')[0].trim();
    if (ct === 'audio/mpeg')       ext = 'mp3';
    else if (ct.includes('/'))     ext = ct.split('/')[1].replace(/\+.*$/, '');
  }
  if (!ext) ext = mediaKind === 'audio' ? 'mp3' : 'mp4';

  const baseName    = rawFilename?.replace(/\.[^.]+$/, '') || `${mediaKind}-file`;
  const fileSlug    = slugify(baseName.slice(0, 60));
  const mediaFilename = `${fileSlug}.${ext}`;

  const savedPath = await saveBinaryToDateFolder(dirHandle, date, mediaFilename, binaryData);

  const title      = baseName;
  const cleanTitle = sanitizeTitle(title);
  const typeLabel  = mediaKind === 'audio' ? 'Audio' : 'Video';

  const fmFields = {
    title:    cleanTitle,
    url:      sanitizeUrlForDisplay(url),
    saved_at: savedAt,
    source:   'markdown-vault',
    type:     mediaKind,
    file:     `./${savedPath}`,
  };
  const fm = include_frontmatter ? buildFrontmatter(fmFields) : '';
  const content = (
    `${fm}# ${escapeMarkdownHeading(cleanTitle)}\n\n` +
    `> ${typeLabel} file saved to \`./${savedPath}\`\n` +
    `>\n` +
    `> No transcript available (no LLM transcription configured).\n\n` +
    `Source: ${sanitizeUrlForDisplay(url)}\n`
  );

  const mdFilename = buildFilename(cleanTitle, file_naming_pattern);
  const savedName  = await saveMarkdownFile(dirHandle, mdFilename, content);

  return { title: cleanTitle, filename: savedName };
}

// ─── Image URL Handler ────────────────────────────────────────────────────────

async function handleDirectImage(url, dirHandle, settings, fetchResult) {
  const { binaryData, contentType } = fetchResult;
  const date    = dateString();

  if (binaryData && binaryData.byteLength > IMAGE_MAX_SIZE) {
    const sizeMB = Math.round(binaryData.byteLength / 1024 / 1024);
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const entry = `**${timestamp}** — Image too large to save (${sizeMB} MB): ${sanitizeUrlForDisplay(url)}`;
    await appendToDaily(dirHandle, entry, date);
    return { title: 'Image', filename: `${date}.md` };
  }

  // Determine extension
  let ext = 'jpg';
  if (contentType) {
    const ct = contentType.toLowerCase().split(';')[0].trim();
    if (ct.startsWith('image/')) {
      const ctExt = ct.split('/')[1];
      if      (ctExt === 'jpeg')     ext = 'jpg';
      else if (ctExt === 'svg+xml') ext = 'svg';
      else if (ctExt)               ext = ctExt;
    }
  }
  try {
    const urlExt = new URL(url).pathname.split('.').pop()?.toLowerCase();
    if (urlExt && /^[a-z]{2,5}$/.test(urlExt)) ext = urlExt;
  } catch {}

  const imgFilename = `${Date.now()}.${ext}`;
  const savedPath   = await saveImageToFolder(dirHandle, date, imgFilename, binaryData);

  const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const entry = `**${timestamp}** — Image from URL: ${sanitizeUrlForDisplay(url)}\n\n![Image](./${savedPath})`;
  await appendToDaily(dirHandle, entry, date);

  return { title: 'Image', filename: `${date}.md` };
}
