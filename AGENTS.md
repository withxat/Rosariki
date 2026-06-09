# Cahciua Agent Guide

Reference for contributors. Improve code when you touch it; avoid one-off patterns.

**Maintenance rule**: when you change a key pattern, invariant, or architectural rule, update this file in the same commit. Per-file descriptions and schema dumps belong in source — don't add them here.

## What Is Cahciua

Slack group-chat bot built on the **Deterministic Context Pipeline (DCP)**:

1. **Adaptation** (`src/slack/adapter.ts`): Slack events → `CanonicalIMEvent` (anti-corruption).
2. **Projection** (`src/projection/`): `IC' = reduce(IC, event)` — pure, Immer-backed.
3. **Rendering** (`src/rendering/`): `RC = render(IC, params)` — XML serialization + viewport filtering.
4. **Driver** (`src/driver/`): merges RC with its own TRs (turn responses) by timestamp, owns tool-call loops, reactive scheduling (alien-signals), compaction, probe gate.

Supports three LLM API formats via direct non-streaming `fetch`: `openai-chat`, `anthropic-messages`, `responses`. TRs are stored in raw provider format; conversion happens only at API boundaries.

Design goals: KV-cache friendly, group-chat native, autonomous reply (bot decides whether to respond via `send_message` tool call).

See `docs/dcp-design.md` for architecture rationale.

## Tech Stack

Node ≥22, TypeScript, pnpm. Slack: @slack/bolt + @slack/web-api (Socket Mode; mrkdwn; inbound image hydration; reaction ingress; interaction tools: react/edit/delete/read_thread). DB: better-sqlite3 + Drizzle. State: Immer. Reactivity: alien-signals. Validation: Valibot. Prompts: `@velin-dev/core` (all in `prompts/*.velin.md` — never hardcode prompt strings). Logging: `@guiiai/logg`. Tests: Vitest. Media: sharp (thumbnails + image-to-text).

## Commands

`pnpm dev` (watch) / `pnpm start` / `pnpm build` / `pnpm typecheck` / `pnpm lint[:fix]` / `pnpm test[:run]` / `pnpm db:generate` (Drizzle migration).

## Layout

```
src/
├── adaptation/   Canonical types + contentToPlainText helpers.
├── projection/   reduce(IC, event) → IC' (pure, Immer).
├── rendering/    IC + params → RC (XML).
├── driver/       LLM orchestration, tool loop, compaction, probe gate, format conversion.
├── db/           Drizzle schema + persistence. Schema is the source of truth.
├── slack/        Socket Mode ingress, reactions, mrkdwn adapter, inbound image hydration, interaction tools, outbound messages/files.
├── media/        Shared image-to-text resolver, thumbnails, LLM description helpers.
├── event-bus.ts  Typed pub/sub for platform ingress handlers.
├── config/       YAML loader (Valibot).
├── http.ts       fetch wrapper with credential redaction (registerHttpSecret).
├── pipeline.ts   Per-chat IC/RC state manager.
├── startup.ts    Configured replay whitelist / in-memory residency checks.
└── index.ts      Wiring shell.
prompts/          All velin templates.
docs/             Design docs (not prompts).
```

**Type ownership**: Slack platform types live in `src/slack/types.ts`. Canonical types (`CanonicalIMEvent`, `ContentNode`, ...) live in `src/adaptation/types.ts`. All IDs in canonical types are strings. Legacy `users` / `messages` tables remain in the schema for historical Telegram rows only; live persistence is canonical `events`. Never define platform types in the DB layer.

**Imports**: relative paths only. No tsconfig aliases.

## Architecture Invariants

### Purity & data flow

Projection reducers are pure: `(IC, event) => IC'`. No I/O. Only IM platform events feed Projection — bot's own LLM output lives exclusively in Driver TRs. Data flows strictly forward; Driver is the sole owner of TRs.

External data (memory, profiles) enters via Driver-level late binding (`injectLateBindingPrompt()`), not by mutating IC.

### Agent identity (IDENTITY.md / SOUL.md)

Optional `agent/IDENTITY.md` and `agent/SOUL.md` (or `agent.dir` / `AGENT_DIR`) are loaded at startup and appended to the primary system prompt via `systemFiles`. `agent.displayName` in config sets the bot sender label in synthetic Slack events (defaults to `Cahciua`). Example templates: `agent/*.example.md`.

### Dual timestamps

Every `CanonicalIMEvent` carries:
- `receivedAtMs` — local ingress time, **captured before any async transform**. Ordering source of truth; DB orders by `(received_at, id)`.
- `timestampSec` — server time, shown to the AI.
- `utcOffsetMin` — captured at ingress; Rendering uses it for local-time display.

### Consistency above availability

**Never admit partially transformed events.** When `imageToText` is enabled, Slack ingress blocks on image description before emitting the canonical event. Timeouts and infinite retries are acceptable; inconsistent data is not. No silent fallback to thumbnail-only / empty alt text.

### Configured chat residency

`chats` config = in-memory residency whitelist (Slack channel IDs). Requires top-level `slack.botToken` + `slack.appToken`. Unconfigured channels are not loaded into IC/RC/Driver on cold start.

### Per-channel context (no cross-channel memory)

Each Slack channel ID (`chatId`) has its own IC/RC, `events`, TRs, compactions, probe history, and driver scope. Conversation memory does **not** span channels — the model in channel A cannot see channel B unless you add a separate global-memory layer.

### Slack user display names

Ingress calls `users.info` per message sender → `displayName` / `username` in message XML. Use `slack_read_user_profile` when status, title, or full profile fields are needed.

### Scheduled tasks (calendar recurrence + model writes at fire time)

`create_schedule` / `list_schedules` / `cancel_schedule` persist rows in `scheduled_tasks` (per channel). `src/schedule/` polls enabled tasks every minute, matches `recurrence` (`cn_workday` / `daily` / `weekly` / `once`), and emits `runtime` `kind: schedule_triggered` with an **instruction** (intent). Primary model composes and sends via `send_message`. `cn_workday` uses `chinese-days` (`isWorkday`) for China holidays and调休; **update `chinese-days` annually** when the State Council publishes the next year's calendar (`pnpm update chinese-days`). Idempotency: `last_fired_local_date` prevents duplicate fires on the same local day; missed minute ticks are not backfilled. `once` disables after fire. Skips probe gate (`isScheduleTriggered` / `isRuntimeEvent`).

### IC mutation semantics

- **In-place** (edit, delete): mutate existing IC nodes with marks (`editedAtSec`, `deleted: true`). Costs KV cache from that point. Acceptable for infrequent recent edits.
- **Append-only** (rename, future join/leave): insert system event nodes at the tail. Old messages keep their original `sender` field — Rendering uses `node.sender`, not `ic.users`.

Rule: metadata changes about entities → append-only; content changes to specific messages → in-place with marks.

### RC × TR merge

RC carries `receivedAtMs`; TRs carry `requestedAtMs`. Driver merges by timestamp. **Tiebreaker (mandatory)**: RC before TR at equal timestamps — required by Anthropic's strict role alternation.

Each LLM API call = one TR. New external messages during a tool loop trigger `checkInterrupt`, which breaks the loop; the reactive effect re-schedules a fresh call with updated RC. Not mid-loop re-rendering — interrupt + re-schedule.

### Reasoning signature sanitization

Each TR records `reasoningSignatureCompat`. On replay: same compat → keep reasoning; otherwise strip all reasoning fields (thinking text + signature/encrypted content go together). Format conversion preserves the pair: openai-chat `reasoning_text`/`reasoning_opaque` ↔ responses `summary`/`encrypted_content`.

### Tool call ID sanitization

Stored TRs keep provider-native IDs. `composeContext()` always remaps IDs to `[A-Za-z0-9_-]` for the request (Anthropic's regex) — deterministic, collision-safe, never written back to storage.

### Token statistics (cross-provider normalization)

All `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` columns are normalized at the API boundary in `src/driver/{chat,messages,responses}.ts`. See `docs/dcp-design.md` for the cost model.

### Context optimizations (always on in `composeContext`)

- Drop pure-text TRs (no tool calls) beyond the latest 5.
- Filter RC segments with `isSelfSent=true` (bot sends exist as synthetic RC and TR — keep the TR side).
- Mechanically trim oversized (`text >512 chars` or non-`low` image) tool results beyond the latest 5.
- Sanitize empty assistant content for Anthropic (delete empty `content`, drop empty-shell messages).

`isSelfSent` is set at creation (synthetic event bypass in `src/index.ts`), not derived from sender ID.

### Final send prep

`prepareChatMessagesForSend()` / `prepareResponsesInputForSend()` are the **only** places that convert the internal `Message[]` to wire format. Model `maxImagesAllowed` is enforced here on **every** request.

### Compaction

Independent alien-signals effect parallel to the reply flow. Dual water mark (token estimates use `CHARS_PER_TOKEN = 2` heuristic). Output: structured plain-text summary in `compactions` table. `cursorMs` is a `computed()` signal; pipeline auto-applies via `setCompactCursor()`.

### Probe / activate gate

In group chats, run a small `probe.model` first when the bot wasn't recently mentioned/replied to. Probe responses go in `probe_responses` and **never** enter `composeContext`.

### Slack emoji catalog

Single `emoji.list({ include_categories: true })` cache (5 min TTL) shared by late-binding `<slack-emoji-catalog>` (truncated custom names + alias hints) and `slack_list_emoji` (full/searchable list, optional standard categories from API). Requires `emoji:read`. `emoji_changed` clears the cache.

### Slack metadata tools (on-demand)

Driver registers Slack-only tools so large workspace metadata enters context only when requested: `slack_read_channel_info` (`conversations.info`), `slack_read_channel_members` (`conversations.members`), `slack_read_user_profile` (`users.info` + `users.profile.get`), `slack_list_emoji`, `slack_read_canvas` (`canvases.sections.lookup`). Channel tools use the current `chatId` (raw Slack channel ID). User IDs accept `U…` or `slack:U…`.

### Slack thread vs channel placement

Driver computes `computeSlackReplyPlacement()` from new RC segments (`mentionsMe` / `repliesToMe`, `messageId`, `replyToMessageId`) and injects `<slack-reply-placement>` into late-binding. Rendering sets `in-thread="true"` on `<message>` when the event was posted inside a thread. The model still omits `reply_to` only when intentionally broadcasting to the channel — not rewritten at send time.

### Media-to-text (image)

When `imageToText.enabled`, Slack downloads inbound images, generates a deterministic WebP thumbnail, and blocks on LLM alt text before commit. Cache key = sha256 of thumbnail bytes in `image_alt_texts`. Alt text is transient on attachments at render time — never stored in `events`.

### HTTP credential redaction

`registerHttpSecret(secret)` in `src/http.ts` masks secrets in `HttpError` messages. Slack tokens registered at client creation.

### Anti-injection

Identity (who said what) is carried as XML attributes, never inline text. Users can't spoof attributes.

### Debug dumps

Driver writes full LLM request JSON to `/tmp/cahciua/<chatId>.request.json` before each call. Intentional — project is not production-deployed. Don't flag.

## Conventions

- **Functional**: `const` + arrow functions, closure factories. Classes only when required by library APIs or for `Error` subclasses.
- **Strict types**: avoid `any`; `unknown` + narrow. `noUncheckedIndexedAccess` is on. `import type` for type-only imports (lint-enforced).
- **File names**: `kebab-case`.
- **Logging**: `@guiiai/logg` only. `console.log` is reserved for CLI scripts that print copy-paste output.
- **Comments**: only the non-obvious "why" (workarounds, edge cases, decisions).
- **No speculative code**: leave a `// TODO:` instead of a wrong placeholder.
- **Error handling**: let errors propagate. No silent `catch` returning empty/default values.
- **Styling** (ESLint-enforced via `@withxat/eslint-config`): tab indent, single quotes, no semicolons — see that package for the full rule set.

## Testing

Vitest, files next to source as `*.test.ts`. Driver, persistence, and Slack adapter are the complexity hotspots — expand coverage when behavior changes.

## Dependencies

`pnpm add [-D] <dep>`. Don't hand-edit `package.json`. Run `pnpm typecheck` and `pnpm lint:fix` after finishing a task.

## Data migration

When existing data doesn't match the current design, fix it with a Drizzle migration (SQL UPDATE in a new migration file). **No** runtime fallbacks or compat shims for old data shapes — code handles the latest design only.

## Commits

Conventional Commits (`feat:`, `fix:`, `refactor:`, ...). Focused, scoped. Update this file in the same commit when changing key patterns or invariants.

**NEVER commit or push without explicit human instruction.** Wait for the user to verify and ask.
