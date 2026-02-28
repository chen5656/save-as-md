---
name: "keep-markdown"
description: "Search and retrieve saved web content as clean Markdown from the keep.md API."
---

# keep-markdown

Search and retrieve saved web content as clean Markdown from the keep.md API. Users save web pages via the keep.md browser extension or CLI, and this skill lets you search, list, and read that content.

## Authentication

You need an API key to use keep.md. The user must provide one or have it set in their environment.

1. Sign up at https://keep.md
2. Go to https://keep.md/dashboard
3. Create a **personal** API token
4. Save the key:

```
npm i -g keep-markdown
keep key <your-token>
```

This persists the key to `~/.config/keep/config.json`. Alternatively set the `KEEP_API_KEY` environment variable.

All CLI commands and API requests require this token. The API accepts it via `Authorization: Bearer <token>` header.

## CLI Commands

Install globally once, then use the `keep` command.

### Check account info

```
keep me
```

Returns account info.

### List saved items

```
keep list
```

Returns items with status `stashed` (the default). Archived items are excluded unless you filter by status explicitly.

### List items from the last 7 days

```
keep list --since 7d
```

### List items with their Markdown content included

```
keep list --since 24h --content
```

### Search items by keyword

```
keep search "react hooks"
```

Searches across titles, URLs, notes, and tags. This is equivalent to `list --query "react hooks"`.

### List with query flag

```
keep list --query "typescript" --limit 10
```

### Get item metadata by ID

```
keep get <id>
```

Returns JSON with the item's URL, title, tags, status, and timestamps.

### Get item content as Markdown

```
keep content <id>
```

Returns the extracted Markdown content of the saved page. This is the primary way to read saved web content.

### Archive an item

```
keep archive <id>
```

Sets the item status to `archived`. Archived items no longer appear in `keep list` or `GET /api/items` by default. Use `--status archived` to view them.

### List unprocessed items (agent feed)

```
keep feed
```

Returns items that have not been marked as processed. Content is included by default. This is the primary command for agent consumption — fetch new items, process them, then mark as done.

### List unprocessed items from the last 7 days

```
keep feed --since 7d
```

### List unprocessed items as JSON

```
keep feed --json
```

### Mark items as processed

```
keep processed <id> [id...]
```

After an agent has consumed items from `keep feed`, mark them as processed so they won't appear in future feed requests.

### List archived items

```
keep list --status archived
```

### List all items including archived

```
keep list --status stashed,archived
```

### Get usage statistics

```
keep stats
```

### Get stats for a date range

```
keep stats --since 30d
```

### Output raw JSON

Any command supports `--json` for machine-readable output:

```
keep list --since 7d --json
```

## HTTP API Reference

Base URL: `https://keep.md`

All endpoints require `Authorization: Bearer <token>` header.

### GET /api/me

Returns account info.

```
curl -H "Authorization: Bearer $KEEP_API_KEY" https://keep.md/api/me
```

Response:

```json
{
  "accountId": "uuid",
  "authType": "api",
  "...": "..."
}
```

### GET /api/items

List saved items. Returns newest first. Archived items are excluded by default.

Query parameters:
- `since` — timestamp (ms) or relative like `7d`, `24h`
- `until` — timestamp (ms) or relative
- `status` — comma-separated status filter (e.g. `stashed`, `archived`, or `stashed,archived` for all). When omitted, archived items are excluded.
- `q` — search query (searches title, URL, notes, tags)
- `limit` — max items to return (default 200, max 1000)
- `offset` — pagination offset
- `content` — set to `1` to include Markdown content in response

```
curl -H "Authorization: Bearer $KEEP_API_KEY" "https://keep.md/api/items?limit=10&content=1"
```

Response:

```json
{
  "items": [
    {
      "id": "sha256-hash",
      "url": "https://example.com/article",
      "title": "Example Article",
      "status": "stashed",
      "createdAt": 1706745600000,
      "contentMarkdown": "# Article Title\n\nArticle content..."
    }
  ],
  "limit": 10,
  "offset": 0,
  "count": 1
}
```

### GET /api/items/:id

Get a single item's metadata.

```
curl -H "Authorization: Bearer $KEEP_API_KEY" https://keep.md/api/items/<id>
```

Add `?content=1` to include Markdown content in the response.

### GET /api/items/:id/content

Get the extracted Markdown content for an item. Returns `text/markdown`.

```
curl -H "Authorization: Bearer $KEEP_API_KEY" https://keep.md/api/items/<id>/content
```

Returns 404 if no content has been extracted for this item.

### POST /api/items/archive

Archive items by ID. Archived items are hidden from the default list response.

```
curl -X POST -H "Authorization: Bearer $KEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ids": ["item-id-1", "item-id-2"]}' \
  https://keep.md/api/items/archive
```

Response:

```json
{
  "archived": 2
}
```

### GET /api/feed

List unprocessed items with content included. Returns items where `processed_at` is null and status is not archived. Content markdown is always included in the response.

Query parameters:
- `since` — timestamp (ms) or relative like `7d`, `24h`
- `until` — timestamp (ms) or relative
- `q` — search query (searches title, URL, notes, tags)
- `limit` — max items to return (default 200, max 1000)
- `offset` — pagination offset

```
curl -H "Authorization: Bearer $KEEP_API_KEY" "https://keep.md/api/feed?limit=50"
```

Response:

```json
{
  "items": [
    {
      "id": "sha256-hash",
      "url": "https://example.com/article",
      "title": "Example Article",
      "status": "stashed",
      "createdAt": 1706745600000,
      "contentMarkdown": "# Article Title\n\nArticle content...",
      "processedAt": null
    }
  ],
  "limit": 50,
  "offset": 0,
  "count": 1
}
```

### POST /api/items/mark-processed

Mark items as processed. Processed items no longer appear in `GET /api/feed`.

```
curl -X POST -H "Authorization: Bearer $KEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ids": ["item-id-1", "item-id-2"]}' \
  https://keep.md/api/items/mark-processed
```

Response:

```json
{
  "processed": 2
}
```

### GET /api/stats

Get usage statistics.

```
curl -H "Authorization: Bearer $KEEP_API_KEY" "https://keep.md/api/stats?since=30d"
```

Response:

```json
{
  "total": 42,
  "byStatus": { "stashed": 30, "archived": 12 },
  "...": "..."
}
```

## Common Workflows

### Find and read a saved article

First search for it:

```
keep search "article title"
```

Then read the content using the item ID from the results:

```
keep content <id>
```

### List recent saves with content

```
keep list --since 7d --content --json
```

### Archive an item after reading it

```
keep archive <id>
```

### View archived items

```
keep list --status archived
```

### Agent feed loop (fetch, process, mark done)

Fetch unprocessed items with content:

```
keep feed --json
```

After your agent has processed the items, mark them as done using the IDs:

```
keep processed <id1> <id2> <id3>
```

Only unprocessed items appear in the feed, so the next call to `keep feed` returns only new items.

## OpenAPI Specification

Full API spec available at: https://keep.md/openapi.json
