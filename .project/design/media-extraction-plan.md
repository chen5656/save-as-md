# Media Extraction Plan: Expanding Markdown Vault

_Analysis of `summarize` repo and integration plan for Markdown Vault extension._
_Created: 2026-03-01_

---

## 1. What `summarize` Can Do

`@steipete/summarize` is a TypeScript monorepo (Node.js 22+) with two packages:
- `@steipete/summarize-core` — extraction library
- `@steipete/summarize` — CLI wrapper + LLM integration

### Content types it handles

| Type | How |
|------|-----|
| Web pages | Mozilla Readability + HTML segment extraction + metadata (og:, JSON-LD) |
| PDFs | Provider-dependent (Google Gemini most reliable) |
| Images | LLM vision (not extractable without API) |
| YouTube | Native captions from `ytInitialPlayerResponse` → Apify → yt-dlp+Whisper |
| Direct audio/video (mp3, mp4, etc.) | yt-dlp download → Whisper transcription |
| Podcasts | Apple/Spotify page scrape + Podcasting 2.0 RSS transcript links |
| RSS feeds | Enclosure extraction → transcription |
| Twitter/X | oEmbed + DOM extraction |

### Pure extraction functions (no LLM, no API keys, browser-portable)

These are usable patterns since they're just logic:

- **URL classification** — `isYouTubeUrl()`, `isYouTubeVideoUrl()`, `extractYouTubeVideoId()`, `isDirectMediaUrl()`, `isDirectMediaExtension()`, `isPodcastHost()`
- **HTML metadata** — og:title, og:description, og:site_name, twitter: meta, `<title>`, `<meta name="description">`
- **JSON-LD parsing** — `<script type="application/ld+json">` blocks → title, description, type
- **Readability wrapper** — identical to what the extension already does
- **YouTube page extraction** — `ytInitialPlayerResponse` JSON in page HTML → `captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl` → fetch VTT
- **VTT parsing** — `vttToSegments()`, `vttToPlainText()`
- **JSON transcript parsing** — `jsonTranscriptToSegments()`, `jsonTranscriptToPlainText()`
- **RSS/Podcast transcript links** — Podcasting 2.0 `<podcast:transcript>` tags in RSS feeds
- **Embedded media detection** — `<video>`, `<audio>`, `og:video` in HTML
- **Hidden element stripping** — `display:none`, `aria-hidden`, etc.

### What requires external tools or LLM (NOT usable without APIs)

- Whisper transcription (needs Groq/OpenAI/FAL key or local binary)
- yt-dlp (native binary, can't run in Chrome extension)
- Firecrawl (API key)
- PDF text extraction (needs PDF.js or LLM)
- Image understanding (needs vision LLM)
- Audio/video transcription (all require LLM or local binary)

---

## 2. Current Extension Capabilities

| Type | Status | How |
|------|--------|-----|
| Web pages (HTML) | ✅ Works | Readability + Turndown via offscreen doc |
| JS-rendered pages | ✅ Works | Background tab fallback |
| Twitter/X | ✅ Works | DOM polling + oEmbed fallback |
| Xiaohongshu | ✅ Works | DOM extraction + image download |
| Telegram images | ✅ Works | Download from Telegram CDN |
| Telegram documents | ✅ Works | Download from Telegram CDN |
| Text messages | ✅ Works | Appended to daily digest |
| YouTube | ❌ Missing | Falls through to generic HTML extraction (thin content) |
| Direct media URLs (mp3, mp4) | ❌ Missing | Treated as binary, saved as file with no metadata |
| PDF URLs | ❌ Partial | Downloads as binary file, no metadata stub |
| Podcast episode pages | ❌ Missing | Falls through to generic HTML (often blocked) |
| RSS feed URLs | ❌ Missing | Falls through to generic HTML |

---

## 3. Target: What We're Adding

### Goals
- **Full text content** — not summaries, just raw extracted text
- **Files downloaded as-is** — binary content (PDFs, audio, video, and unknown types) is saved directly to a `YYYY-MM-DD/` date subfolder. A companion `.md` metadata file is always created alongside, recording the file path, URL, content type, and file size. ✅ Implemented.
- **No LLM, no API keys** — for anything that can't be extracted deterministically, URL + title + whatever metadata is available goes into the companion `.md`.
- **Broad format coverage** — web pages, PDFs, images, audio/video, YouTube, podcasts, RSS

### Fallback policy (NO LLM)
> If content cannot be fully extracted without an LLM or external API, add to the daily digest markdown file
> - `url` in frontmatter
> - `title` (from og:title, JSON-LD, `<title>`, or URL filename)
> - `description` if available
> - `saved_at`
> - `type` field indicating what kind of content it is
> - Body: a note explaining what it is and why full extraction wasn't possible

---

## 4. Architecture Changes

### New module: `content-router.js`
Determines content type from URL + HTTP response headers, routes to the right handler.

```
URL arrives → content-router.js
  ├── isYouTubeVideo → youtube-handler.js
  ├── isDirectMedia (mp3, mp4, wav, etc.) → media-handler.js
  ├── isPDF (url or Content-Type) → pdf-handler.js
  ├── isImage (jpg, png, gif, webp, etc.) → image-handler.js
  ├── isRSSFeed (Content-Type: application/rss+xml etc.) → rss-handler.js
  ├── isPodcastPage → podcast-handler.js
  └── default → existing HTML handler (background.js processURL)
```

### Extended offscreen document capabilities
The offscreen document (`pages/offscreen/offscreen.js`) gets new message types:
- `parse_rss` — parse RSS/Atom XML, extract items + metadata
- `parse_youtube_page` — extract `ytInitialPlayerResponse` + caption track URLs
- `parse_vtt` — convert VTT transcript text to plain text
- `extract_metadata_only` — just og:, JSON-LD, `<title>` (for fallback stubs)

### New file types the extension will save

| Input | Output |
|-------|--------|
| YouTube URL | `YYYY-MM-DD-video-title.md` with transcript (if available) or stub |
| Direct audio/video URL | File downloaded + `YYYY-MM-DD-media-title.md` stub |
| PDF URL | File downloaded + `YYYY-MM-DD-pdf-title.md` stub |
| Image URL | File downloaded, appended to daily digest |
| RSS feed URL | `YYYY-MM-DD-feed-name.md` with all items listed |
| Podcast episode URL | `YYYY-MM-DD-episode-title.md` with transcript (if Podcasting 2.0) or stub |

---

## 5. Implementation Plan

### Phase 1: URL Classification + Content Router

**Files:** new `content-router.js` (can live in root alongside `background.js`)

Port these detection functions from `summarize/packages/core/src/content/url.ts`:

```js
// Media extensions to detect as direct download
const AUDIO_EXTS = ['mp3','m4a','wav','flac','aac','ogg','opus','aiff','wma'];
const VIDEO_EXTS = ['mp4','mov','m4v','mkv','webm','mpeg','mpg','avi','wmv','flv'];
const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','avif','svg','bmp','tiff'];
const PDF_EXT = ['pdf'];

function classifyUrl(url, contentType) {
  // Returns: 'youtube' | 'direct-video' | 'direct-audio' | 'direct-image'
  //          | 'pdf' | 'rss' | 'podcast' | 'html'
}
```

RSS/Atom detection by Content-Type:
- `application/rss+xml`, `application/atom+xml`, `application/feed+json`
- `text/xml` + URL containing "feed", "rss", "atom"

Podcast page detection (host-based, from `summarize`):
- `podcasts.apple.com`, `open.spotify.com/episode`, `podbean.com`, `podchaser.com`
- Amazon Music/Audible podcast paths

**Integration point:** call `classifyUrl()` at the top of `processURLWithRetry()` in `background.js` before the existing fetch logic.

---

### Phase 2: YouTube Handler

**File:** new `youtube-handler.js`

**Algorithm (no API key, no yt-dlp):**

1. Extract video ID from URL using `extractYouTubeVideoId()` pattern
2. Fetch `https://www.youtube.com/watch?v=ID` with spoofed User-Agent
3. Send HTML to offscreen doc with `parse_youtube_page` message
4. Offscreen doc finds `ytInitialPlayerResponse` in page HTML:
   - Use regex: `var ytInitialPlayerResponse = ({.+?});` then JSON parse
   - Extract `videoDetails`: title, author, shortDescription, lengthSeconds, viewCount
   - Extract `captions.playerCaptionsTracklistRenderer.captionTracks`
   - Pick first English track (or first track if no English)
   - Return `captionTrackUrl`
5. If caption track URL found: fetch the VTT from that URL
6. Parse VTT to plain text using VTT parser (port from `summarize/transcript/parse.ts`)
7. Build Markdown:
   ```markdown
   ---
   title: "Video Title"
   url: https://youtube.com/watch?v=ID
   author: "Channel Name"
   duration_seconds: 1234
   saved_at: 2026-03-01T...
   source: markdown-vault
   type: youtube
   transcript_source: youtube-captions
   ---
   # Video Title

   **Channel:** Channel Name
   **Duration:** 20:34

   ## Description

   [short description from videoDetails]

   ## Transcript

   [full plain text transcript]
   ```
8. **Fallback** (no captions found): save stub with title + description only

**VTT Parser to port** (pure logic, ~50 lines):
```js
function vttToPlainText(vttText) {
  // Strip WEBVTT header, cue timings, tags like <00:00:00.000>, <c>
  // Deduplicate consecutive identical lines
  // Return joined plain text
}
```

---

### Phase 3: PDF Handler

**File:** add logic to `background.js` or new `pdf-handler.js`

PDFs are binary — no text extraction without PDF.js or LLM.

**Algorithm:**
1. Detect PDF: URL ends in `.pdf` OR Content-Type is `application/pdf`
2. Download binary to a `YYYY-MM-DD/` subfolder (like Telegram documents already work)
3. Try to get title from:
   - og:title in any HTML redirect/landing page
   - URL filename (last path segment, decoded)
   - Content-Disposition header filename
4. Create companion Markdown stub:
   ```markdown
   ---
   title: "Document Title"
   url: https://example.com/paper.pdf
   saved_at: 2026-03-01T...
   source: markdown-vault
   type: pdf
   file: ./2026-03-01/document-title.pdf
   ---
   # Document Title

   > PDF file saved to `./2026-03-01/document-title.pdf`

   [url]: https://example.com/paper.pdf
   ```
5. Save stub as `.md` file alongside downloaded PDF

**Size limit:** respect existing `MAX_PAGE_SIZE` or a configurable PDF limit (suggest 50MB)

---

### Phase 4: Direct Media Handler (Audio/Video)

**File:** extend `background.js` or new `media-handler.js`

**Algorithm:**
1. Detect: URL extension matches `AUDIO_EXTS` or `VIDEO_EXTS`
2. Determine media kind: audio or video
3. Get filename from URL path (decoded, cleaned)
4. Download binary file to `YYYY-MM-DD/` subfolder
5. Try to get title from:
   - `Content-Disposition: attachment; filename="..."` header
   - URL path filename
6. **No transcription** — save a stub:
   ```markdown
   ---
   title: "Episode Title"
   url: https://example.com/episode.mp3
   saved_at: 2026-03-01T...
   source: markdown-vault
   type: audio
   file: ./2026-03-01/episode-title.mp3
   ---
   # Episode Title

   > Audio file saved to `./2026-03-01/episode-title.mp3`
   ```
7. Append reference to daily digest (like Telegram docs currently work)

**Size limit:** configurable (suggest 200MB with a progress indicator via notification)

---

### Phase 5: Image URL Handler (non-Telegram)

**File:** extend existing image handling in `background.js`

Currently images only come from Telegram messages. Add URL-based detection:

1. Detect: URL extension matches `IMAGE_EXTS` OR Content-Type starts with `image/`
2. Download to `YYYY-MM-DD/` subfolder (same as Telegram images)
3. Append to daily digest with timestamp:
   ```markdown
   **10:30 AM** — [Image from URL](https://example.com/photo.jpg)
   ![photo](./2026-03-01/photo.jpg)
   ```

---

### Phase 6: RSS Feed Handler

**File:** new `rss-handler.js` + new offscreen message `parse_rss`

**Algorithm:**
1. Detect RSS: Content-Type is `application/rss+xml`, `application/atom+xml`, `application/feed+json`, or `text/xml`
2. Fetch feed XML
3. Send to offscreen doc: `parse_rss`
4. Offscreen doc uses `DOMParser` to parse XML:
   - RSS 2.0: `<channel>` → `<title>`, `<description>`, `<link>`, `<item>` elements
   - Atom: `<feed>` → `<title>`, `<subtitle>`, `<entry>` elements
   - Extract each item: title, link, pubDate, description/summary
   - Check for `<podcast:transcript>` tags (Podcasting 2.0)
5. Build Markdown with all items:
   ```markdown
   ---
   title: "Feed Title"
   url: https://example.com/feed.xml
   saved_at: 2026-03-01T...
   source: markdown-vault
   type: rss-feed
   item_count: 42
   ---
   # Feed Title

   Feed description here.

   ## Items

   - **[Item Title](https://link)** — 2026-02-28
     Item description or summary...

   - **[Item Title 2](https://link2)** — 2026-02-27
     ...
   ```
6. Save as single Markdown file

**Podcasting 2.0 transcript support:**
- If a `<podcast:transcript>` tag is found with `type="text/vtt"` or `type="application/json"` → fetch and parse transcript
- Append to feed item or save as separate file per episode

---

### Phase 7: Podcast Episode Page Handler

**File:** new `podcast-handler.js`

Podcast episode pages (Apple Podcasts, Spotify, etc.) are often heavily JS-rendered and may be behind auth. Strategy:

1. Detect podcast host using host-based list (from `summarize`)
2. Fetch page with existing browser tab fallback
3. Extract metadata: title, show name, episode description, published date
4. Check for RSS feed link in page HTML (`<link rel="alternate" type="application/rss+xml">`)
5. If RSS feed found → fetch feed → find matching episode → check for `<podcast:transcript>`
6. If transcript found → fetch and parse (VTT or JSON)
7. Build Markdown with metadata + transcript (or stub if no transcript)

**Fallback:** generic HTML extraction (existing flow) — podcast pages often have show notes in readable HTML

---

## 6. Metadata Extraction Enhancement (All Types)

Port from `summarize/packages/core/src/content/link-preview/content/parsers.ts`:

```js
function extractMetadataFromHtml(html, url) {
  return {
    title:       og:title || twitter:title || <title>,
    description: og:description || twitter:description || meta[name=description],
    siteName:    og:site_name || url hostname,
    imageUrl:    og:image || twitter:image,
    author:      article:author || meta[name=author],
    published:   article:published_time || meta[name=date],
    type:        og:type,  // 'article', 'video.other', 'website', etc.
  }
}
```

Port from `summarize/packages/core/src/content/link-preview/content/jsonld.ts`:

```js
function extractJsonLd(html) {
  // Parse <script type="application/ld+json"> blocks
  // Support @graph arrays
  // Extract: @type, name/headline, description, author, datePublished
}
```

These enrich the frontmatter for all content types.

---

## 7. Files to Create / Modify

| File | Change |
|------|--------|
| `content-router.js` | **New** — URL/Content-Type classification |
| `youtube-handler.js` | **New** — YouTube page fetch + caption extraction |
| `rss-handler.js` | **New** — RSS/Atom feed parsing |
| `podcast-handler.js` | **New** — Podcast episode page handling |
| `media-handler.js` | **New** — Direct audio/video download |
| `metadata.js` | **New** — Shared og:/JSON-LD extraction functions |
| `vtt-parser.js` | **New** — VTT to plain text (ported from `summarize`) |
| `background.js` | **Modify** — integrate router at top of processURLWithRetry() |
| `pages/offscreen/offscreen.js` | **Modify** — add `parse_rss`, `parse_youtube_page`, `parse_vtt`, `extract_metadata_only` message types |
| `manifest.json` | **Possibly** — no new permissions needed (already has `<all_urls>`) |

---

## 8. What to Port vs. Reference from `summarize`

### Port (adapt to browser JS, no npm deps):

| From `summarize` | Port to |
|-----------------|---------|
| `url.ts` — URL classification | `content-router.js` |
| `parsers.ts` — og:/meta extraction | `metadata.js` |
| `jsonld.ts` — JSON-LD extraction | `metadata.js` |
| `transcript/parse.ts` — VTT/JSON parsing | `vtt-parser.js` |
| `youtube.ts` — ytInitialPlayerResponse extraction | `youtube-handler.js` |
| `transcript/providers/generic.ts` — embedded media detection | `content-router.js` |

### Reference only (understand the pattern but don't port):

- Whisper transcription — requires API keys, skip entirely
- Firecrawl — requires API key, skip
- Slide extraction — requires ffmpeg, skip
- yt-dlp usage — requires binary, skip
- LLM model integration — skip entirely

### Already in the extension (no need to change):

- Mozilla Readability.js — already bundled in `libs/`
- Turndown.js — already bundled in `libs/`
- Background tab fallback — already works
- File System Access API writes — already works
- Retry logic — already works

---

## 9. Constraints & Decisions

### No LLM fallback
When content can't be extracted, the fallback is always a Markdown stub with:
- URL (always)
- Title (best-effort from og:, JSON-LD, `<title>`, or URL filename)
- Description (if found)
- `type` field
- File path (if a binary was downloaded)
- A human-readable note about why full extraction wasn't done

### No binary execution
No yt-dlp, no ffmpeg, no Whisper. Extension must be self-contained.

### PDF text extraction decision
Options:
1. **Download only (recommended)** — save PDF file + stub Markdown. Simple, reliable.
2. **PDF.js integration** — heavy library (~3MB), complex, needed if user wants searchable text
→ **Start with option 1**, add PDF.js later if requested.

### Size limits for binary downloads
- Images: 20MB (same as Telegram)
- Audio/video: 200MB (with notification progress)
- PDFs: 50MB

### YouTube captions availability
YouTube's `ytInitialPlayerResponse` is present on the page HTML for most videos. However:
- Age-gated, private, or DRM content may not have accessible captions
- Auto-generated captions are included in the track list and are acceptable
- Fallback: stub with title + description only

### RSS feed size
For feeds with many items (100+), consider:
- Limit to last 50 items (most recent)
- Or save all items but note the count in frontmatter

---

## 10. Example Outputs

### YouTube
```markdown
---
title: "How Browsers Work: Behind the Scenes"
url: https://www.youtube.com/watch?v=PzzNuCk-e0Y
author: "Google Chrome Developers"
duration_seconds: 1823
view_count: 1234567
saved_at: 2026-03-01T10:30:00Z
source: markdown-vault
type: youtube
transcript_source: youtube-captions
---
# How Browsers Work: Behind the Scenes

**Channel:** Google Chrome Developers
**Duration:** 30:23

## Description

A deep dive into browser internals...

## Transcript

[full transcript text, one paragraph per ~30s segment]
```

### PDF (download only)
```markdown
---
title: "Attention Is All You Need"
url: https://arxiv.org/pdf/1706.03762
saved_at: 2026-03-01T10:31:00Z
source: markdown-vault
type: pdf
file: ./2026-03-01/attention-is-all-you-need.pdf
---
# Attention Is All You Need

> PDF saved to `./2026-03-01/attention-is-all-you-need.pdf`

Source: https://arxiv.org/pdf/1706.03762
```

### Direct Audio (no transcript)
```markdown
---
title: "episode-42-deep-work.mp3"
url: https://example.com/episodes/ep42.mp3
saved_at: 2026-03-01T10:32:00Z
source: markdown-vault
type: audio
file: ./2026-03-01/episode-42-deep-work.mp3
---
# episode-42-deep-work.mp3

> Audio file saved to `./2026-03-01/episode-42-deep-work.mp3`
>
> No transcript available (no LLM transcription configured).

Source: https://example.com/episodes/ep42.mp3
```

### RSS Feed
```markdown
---
title: "Hacker News RSS"
url: https://news.ycombinator.com/rss
saved_at: 2026-03-01T10:33:00Z
source: markdown-vault
type: rss-feed
item_count: 30
---
# Hacker News RSS

## Items

- **[Ask HN: What tools do you use for...](https://news.ycombinator.com/item?id=...)** — 2026-03-01
  Posted by user, 342 points

- **[Show HN: I built a...](https://example.com/project)** — 2026-02-28
  ...
```

### Podcast with Transcript (Podcasting 2.0)
```markdown
---
title: "Episode 234: The Future of AI"
url: https://podcasts.apple.com/us/podcast/.../id...
show: "The Changelog"
published: 2026-02-20
saved_at: 2026-03-01T10:34:00Z
source: markdown-vault
type: podcast
transcript_source: podcasting20-vtt
---
# Episode 234: The Future of AI

**Show:** The Changelog
**Published:** 2026-02-20

## Show Notes

[episode description from RSS]

## Transcript

[full transcript from VTT]
```

### Stub fallback (no extraction possible)
```markdown
---
title: "Some Paywalled Article"
url: https://wsj.com/article/...
description: "Description from og:description"
saved_at: 2026-03-01T10:35:00Z
source: markdown-vault
type: html
extraction_status: failed
---
# Some Paywalled Article

> Full content could not be extracted. The page may be paywalled or require JavaScript.

**Description:** Description from og:description

Source: https://wsj.com/article/...
```

---

## 11. Implementation Priority

1. **Content router** (Phase 1) — foundation for everything else, low risk
2. **YouTube handler** (Phase 2) — highest value, transcript extraction is pure HTML parsing
3. **Enhanced metadata extraction** (Phase 6) — improves all existing saves too
4. **PDF handler** (Phase 3) — simple download, minimal code
5. **RSS handler** (Phase 6) — useful for feed archiving
6. **Direct media handler** (Phase 4) — download + stub
7. **Image URL handler** (Phase 5) — extend existing image logic
8. **Podcast handler** (Phase 7) — most complex, depends on RSS handler

---

## 12. Key References in `summarize` Repo

For porting/adapting — all in `/Volumes/code/save-as-md/docs/summarize/`:

| What | Path |
|------|------|
| URL classification | `packages/core/src/content/url.ts` |
| og:/meta extraction | `packages/core/src/content/link-preview/content/parsers.ts` |
| JSON-LD extraction | `packages/core/src/content/link-preview/content/jsonld.ts` |
| Hidden element stripping | `packages/core/src/content/link-preview/content/visibility.ts` |
| YouTube page extraction | `packages/core/src/content/link-preview/content/youtube.ts` |
| VTT/JSON transcript parsing | `packages/core/src/content/transcript/parse.ts` |
| Embedded media detection | `packages/core/src/content/transcript/providers/generic.ts` |
| Podcast host list | `packages/core/src/content/url.ts` (`isPodcastHost`) |
| YouTube transcript provider | `packages/core/src/content/transcript/providers/youtube.ts` |
| Podcast transcript provider | `packages/core/src/content/transcript/providers/podcast.ts` |
| Text normalization | `packages/core/src/content/link-preview/content/cleaner.ts` |
