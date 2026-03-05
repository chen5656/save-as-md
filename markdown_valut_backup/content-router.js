// Markdown Vault — Content Router
// Classifies URLs and Content-Types to route to the right handler.

'use strict';

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus', 'aiff', 'wma']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'mpeg', 'mpg', 'avi', 'wmv', 'flv']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'tiff']);
const PDF_EXTS   = new Set(['pdf']);

const PODCAST_HOST_SUFFIXES = [
  'spotify.com', 'podcasts.apple.com', 'podchaser.com', 'podbean.com',
  'buzzsprout.com', 'spreaker.com', 'simplecast.com', 'rss.com', 'libsyn.com',
  'omny.fm', 'acast.com', 'transistor.fm', 'captivate.fm', 'soundcloud.com',
  'ivoox.com', 'iheart.com', 'megaphone.fm', 'pca.st', 'player.fm', 'castbox.fm',
];

function getUrlExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    if (dot < 0) return '';
    return last.slice(dot + 1).toLowerCase().split('?')[0];
  } catch { return ''; }
}

function isYouTubeVideoUrl(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    if (hostname === 'youtu.be') return !!u.pathname.split('/').filter(Boolean)[0];
    if (!hostname.includes('youtube.com')) return false;
    if (u.pathname === '/watch') return !!u.searchParams.get('v')?.trim();
    return (
      u.pathname.startsWith('/shorts/') ||
      u.pathname.startsWith('/live/')   ||
      u.pathname.startsWith('/embed/')  ||
      u.pathname.startsWith('/v/')
    );
  } catch { return false; }
}

function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    let id = null;
    if (hostname === 'youtu.be') {
      id = u.pathname.split('/')[1] ?? null;
    } else if (hostname.includes('youtube.com')) {
      if (u.pathname.startsWith('/watch'))   id = u.searchParams.get('v');
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] ?? null;
      else if (u.pathname.startsWith('/embed/'))  id = u.pathname.split('/')[2] ?? null;
      else if (u.pathname.startsWith('/v/'))      id = u.pathname.split('/')[2] ?? null;
    }
    const trimmed = id?.trim() ?? '';
    return /^[a-zA-Z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
  } catch { return null; }
}

function isPodcastHost(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host.startsWith('music.amazon.') && u.pathname.includes('/podcasts/')) return true;
    return PODCAST_HOST_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`));
  } catch { return false; }
}

function isRssContentType(ct) {
  const normalized = (ct || '').toLowerCase().split(';')[0].trim();
  return (
    normalized === 'application/rss+xml' ||
    normalized === 'application/atom+xml' ||
    normalized === 'application/feed+json' ||
    normalized === 'text/xml'             ||
    normalized === 'application/xml'
  );
}

/**
 * Classify a URL (and optional Content-Type after fetch) into a handler type.
 * Returns: 'youtube' | 'direct-video' | 'direct-audio' | 'direct-image'
 *        | 'pdf' | 'rss' | 'podcast' | 'html'
 */
function classifyUrl(url, contentType) {
  // 1. YouTube video URLs
  if (isYouTubeVideoUrl(url)) return 'youtube';

  // 2. URL extension-based detection
  const ext = getUrlExtension(url);
  if (ext) {
    if (AUDIO_EXTS.has(ext))  return 'direct-audio';
    if (VIDEO_EXTS.has(ext))  return 'direct-video';
    if (PDF_EXTS.has(ext))    return 'pdf';
    if (IMAGE_EXTS.has(ext))  return 'direct-image';
  }

  // 3. Content-Type based (requires fetch result)
  if (contentType) {
    const ct = contentType.toLowerCase().split(';')[0].trim();
    if (ct === 'application/pdf')           return 'pdf';
    if (ct.startsWith('image/'))            return 'direct-image';
    if (ct === 'audio/mpeg' || ct === 'audio/mp4' || ct.startsWith('audio/')) return 'direct-audio';
    if (ct.startsWith('video/'))            return 'direct-video';
    if (isRssContentType(ct))              return 'rss';
  }

  // 4. Podcast platform detection
  if (isPodcastHost(url)) return 'podcast';

  return 'html';
}
