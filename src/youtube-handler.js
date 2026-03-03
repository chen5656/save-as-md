// Markdown Vault — YouTube Handler
// Fetches YouTube watch pages, extracts caption tracks, builds Markdown transcripts.
// No API keys, no yt-dlp — uses ytInitialPlayerResponse from page HTML.

'use strict';

const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const YT_HEADERS = {
  'User-Agent': YT_UA,
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// ─── ytInitialPlayerResponse extraction ──────────────────────────────────────

function extractBalancedJson(source, startAt) {
  const start = source.indexOf('{', startAt);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = null;
  let escaping = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaping) { escaping = false; continue; }
      if (ch === '\\') { escaping = true; continue; }
      if (ch === quote) { inString = false; quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function extractInitialPlayerResponse(html) {
  const token = 'ytInitialPlayerResponse';
  const tokenIdx = html.indexOf(token);
  if (tokenIdx < 0) return null;
  const eqIdx = html.indexOf('=', tokenIdx);
  if (eqIdx < 0) return null;
  const text = extractBalancedJson(html, eqIdx);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// ─── Video details + caption tracks ──────────────────────────────────────────

function extractVideoDetails(playerResponse) {
  const vd = playerResponse?.videoDetails;
  if (!vd) return null;
  return {
    title:            typeof vd.title === 'string' ? vd.title : null,
    author:           typeof vd.author === 'string' ? vd.author : null,
    shortDescription: typeof vd.shortDescription === 'string' ? vd.shortDescription : null,
    lengthSeconds:    vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
    viewCount:        vd.viewCount ? Number(vd.viewCount) : null,
    videoId:          typeof vd.videoId === 'string' ? vd.videoId : null,
  };
}

function extractCaptionTracks(playerResponse) {
  const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer;
  if (!renderer) return [];

  const tracks = [];
  const manualTracks = Array.isArray(renderer.captionTracks) ? renderer.captionTracks : [];
  const autoTracks   = Array.isArray(renderer.automaticCaptions) ? renderer.automaticCaptions : [];

  for (const t of [...manualTracks, ...autoTracks]) {
    if (!t || typeof t !== 'object') continue;
    tracks.push({
      baseUrl:      typeof t.baseUrl === 'string' ? t.baseUrl : typeof t.url === 'string' ? t.url : null,
      languageCode: typeof t.languageCode === 'string' ? t.languageCode : '',
      kind:         typeof t.kind === 'string' ? t.kind : '',
      name:         t.name?.simpleText || t.name?.runs?.[0]?.text || '',
    });
  }
  return tracks;
}

function selectBestTrack(tracks) {
  if (!tracks.length) return null;
  const sorted = [...tracks].sort((a, b) => {
    // Manual captions (non-asr) before auto-generated
    const aIsAsr = a.kind === 'asr';
    const bIsAsr = b.kind === 'asr';
    if (aIsAsr && !bIsAsr) return 1;
    if (!aIsAsr && bIsAsr) return -1;
    // English before other languages
    const aIsEn = a.languageCode === 'en' || a.languageCode.startsWith('en-');
    const bIsEn = b.languageCode === 'en' || b.languageCode.startsWith('en-');
    if (aIsEn && !bIsEn) return -1;
    if (!aIsEn && bIsEn) return 1;
    return 0;
  });
  return sorted[0] || null;
}

// ─── Transcript download + parsing ───────────────────────────────────────────

function decodeXmlEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// YouTube JSON3 caption format: {events: [{segs: [{utf8: '...'}]}]}
function parseJson3Transcript(text) {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data?.events)) return null;
    const lines = [];
    for (const event of data.events) {
      if (!Array.isArray(event?.segs)) continue;
      const line = event.segs
        .map(s => typeof s.utf8 === 'string' ? s.utf8 : '')
        .join('')
        .trim();
      if (line && line !== '\n') lines.push(line);
    }
    return lines.join('\n').trim() || null;
  } catch { return null; }
}

// YouTube XML caption format: <text start="..." dur="...">...</text>
function parseXmlTranscript(text) {
  const pattern = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  const lines = [];
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const decoded = decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim();
    if (decoded) lines.push(decoded);
  }
  return lines.join('\n').trim() || null;
}

async function fetchCaptionTrack(baseUrl) {
  if (!baseUrl) return null;

  // Try JSON3 format first (richer, includes timing)
  let json3Url;
  try {
    const u = new URL(baseUrl);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.set('alt', 'json');
    json3Url = u.toString();
  } catch {
    json3Url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3&alt=json';
  }

  try {
    const resp = await fetch(json3Url, { headers: { 'User-Agent': YT_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (resp.ok) {
      const text = await resp.text();
      const result = parseJson3Transcript(text) || parseXmlTranscript(text);
      if (result) return result;
    }
  } catch { /* fall through */ }

  // Fallback: plain XML (no fmt= param)
  try {
    const xmlUrl = baseUrl.replace(/[&?]fmt=[^&]+/g, '');
    const resp = await fetch(xmlUrl, { headers: { 'User-Agent': YT_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!resp.ok) return null;
    const text = await resp.text();
    return parseJson3Transcript(text) || parseXmlTranscript(text);
  } catch { return null; }
}

// ─── Markdown building ────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleYouTube(url, dirHandle, settings) {
  // extractYouTubeVideoId is defined in content-router.js
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL');

  const savedAt = new Date().toISOString();
  const { include_frontmatter = true, file_naming_pattern } = settings;

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Fetch the watch page
  const resp = await fetch(watchUrl, { headers: YT_HEADERS });
  if (!resp.ok) {
    throw Object.assign(
      new Error(`YouTube page fetch failed: HTTP ${resp.status}`),
      { retryable: resp.status >= 500 }
    );
  }

  const html = await resp.text();
  const playerResponse = extractInitialPlayerResponse(html);

  const videoDetails = playerResponse ? extractVideoDetails(playerResponse) : null;
  const tracks       = playerResponse ? extractCaptionTracks(playerResponse) : [];
  const bestTrack    = selectBestTrack(tracks);

  const title       = videoDetails?.title       || `YouTube Video ${videoId}`;
  const author      = videoDetails?.author      || null;
  const description = videoDetails?.shortDescription || null;
  const duration    = videoDetails?.lengthSeconds || null;
  const viewCount   = videoDetails?.viewCount   || null;

  let transcript       = null;
  let transcriptSource = null;

  if (bestTrack?.baseUrl) {
    transcript = await fetchCaptionTrack(bestTrack.baseUrl);
    if (transcript) transcriptSource = 'youtube-captions';
  }

  // Build frontmatter
  const fmFields = {
    title:    sanitizeTitle(title),
    url:      sanitizeUrlForDisplay(watchUrl),
    saved_at: savedAt,
    source:   'markdown-vault',
    type:     'youtube',
  };
  if (author)          fmFields.author           = author;
  if (duration)        fmFields.duration_seconds = duration;
  if (viewCount)       fmFields.view_count       = viewCount;
  if (transcriptSource) fmFields.transcript_source = transcriptSource;

  const fm = include_frontmatter ? buildFrontmatter(fmFields) : '';

  const lines = [`# ${escapeMarkdownHeading(sanitizeTitle(title))}`, ''];
  if (author) lines.push(`**Channel:** ${author}`, '');
  const durationStr = formatDuration(duration);
  if (durationStr) lines.push(`**Duration:** ${durationStr}`, '');

  if (description) {
    // Limit description to avoid enormous files
    const shortDesc = description.length > 1000 ? description.slice(0, 1000) + '…' : description;
    lines.push('## Description', '', shortDesc, '');
  }

  if (transcript) {
    lines.push('## Transcript', '', transcript, '');
  } else {
    lines.push('> No transcript available for this video.', '');
  }

  lines.push(`Source: ${sanitizeUrlForDisplay(watchUrl)}`);

  const content    = fm + lines.join('\n');
  const cleanTitle = sanitizeTitle(title);
  const filename   = buildFilename(cleanTitle, file_naming_pattern);
  const savedName  = await saveMarkdownFile(dirHandle, filename, content);

  return { title: cleanTitle, filename: savedName };
}
