# Plan: Telegram Save Ack With Session Counter (No Implementation Yet)

## Goal
When a Telegram message is saved successfully, send an acknowledgment back to the same chat, including the running count of files saved in the current browser session.

## Scope
- Plan only.
- No code implementation in this task.

## Behavior Definition
- Ack is optional and controlled by a new setting: `send_save_ack` (default `false`).
- Ack is sent only for Telegram-origin messages (not manual context menu/paste saves).
- Ack includes:
  - Saved target (filename or daily file) --- remove!
  - Session count for that chat
- Example:
  - `✅ Saved: 2026-03-05-some-article.md`---- remove!
  - `📊 Session saved count: 12`

## "Session Count" Definition
- Session = current browser run (resets when browser restarts).
- Counter is tracked per `chat_id` so multiple chats do not mix counts.
- Use a bounded in-memory/small-session store (not unbounded global growth).

## Implementation Plan
1. Add lightweight Telegram reply helper
- Add `sendTelegramMessage(token, chatId, text, replyToMessageId?)` using existing `telegramCall`.
- Keep helper small and local to `background.js`; no new dependencies.

2. Extend message context once at dispatcher boundary
- In `processUpdate`, build a compact context object once:
  - `chat_id`
  - `message_id`
  - `update_id`
  - `source: 'telegram'`
- Pass this context through URL/text/image/document save paths.

3. Centralize ack trigger in one function
- Add one orchestrator, e.g. `maybeSendSaveAck({ messageCtx, savedLabel })`.
- Preconditions:
  - `send_save_ack === true`
  - `messageCtx.source === 'telegram'`
  - save operation succeeded
- This avoids scattered ack logic and duplicate code.

4. Add session counter utility
- Add `incrementSessionSaveCount(chatId)` returning next count.
- Keep map bounded:
  - max tracked chats (for example 50)
  - prune oldest entries when over limit
- Reset naturally on browser restart.

5. Dedupe for retries/restarts
- Use a small bounded dedupe store keyed by:
  - `chat_id:update_id:savedLabel`
- Skip ack if key already seen.
- Keep TTL/size cap to prevent growth (for example max 500 keys).

6. Settings wiring
- Add `send_save_ack` to defaults and `get_state`.
- Add toggle in Settings page and include in `save_settings`.
- Keep default `off`.

7. Failure handling
- If ack fails, log warning only.
- Never fail save flow because ack failed.
- Preserve current error `.md` and notification behavior.

## Memory-Safety Constraints (from SERVICE_WORKER_MEMORY_REPORT.md)
- Do not add any large `executeScript({ func: ... })` functions.
- Do not add large string literals/JSON blobs/tokens to `background.js`.
- Keep new helpers short and modular; no heavy module-level state.
- Use bounded maps/queues only (strict max sizes), no unbounded caches.
- Do not add new injected extraction logic to `background.js`; if future script-injection work is needed, use `files: ['...js']`.

## Validation Checklist
- `send_save_ack = off`: no Telegram ack messages sent.
- `send_save_ack = on`: one ack per successful Telegram save.
- Retries: success after retry still sends only one ack.
- Permission missing: no ack (because no successful save).
- Browser restart: session counter resets.
- Multi-chat: counts remain independent by chat.
- Stress test (many saves): no growing unbounded memory structures.
