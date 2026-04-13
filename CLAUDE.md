# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start of Session

Read project documents to load context:

- `docs/design-system.md` — visual design, typography, colours, layout
- `docs/technical-architecture.md` — platform, framework stack, directory structure, critical rules

Also check `plans/` for any active plan.

## Project Overview

MIST is a collaborative markdown editor — a cross between GitHub Gist and Google Docs. Users can quickly share and do multiplayer editing on markdown documents in real-time. Everything is public by URL (no auth yet). Documents persist live with no save button. Documents auto-expire after 99 hours.

## Tech Stack

- **Backend:** Deno 2.x (`Deno.serve()` HTTP server, `Deno.upgradeWebSocket()`, `@db/sqlite` from JSR)
- **Frontend:** React Router 7 (SSR)
- **Editor:** TipTap 3 + Yjs (CRDT multiplayer)
- **Styling:** Tailwind CSS 4
- **Language:** TypeScript (strict mode)
- **Testing:** Vitest with v8 coverage

## Prerequisites

Requires [Deno](https://deno.land/) 2.x.

## Commands

```bash
deno task dev          # Local development server
deno task build        # Production build
deno task start        # Start Deno production server
deno task preview      # Build + start
deno task typecheck    # TypeScript type checking
deno task lint         # ESLint
deno task test         # Vitest with coverage
deno task test:watch   # Vitest in watch mode

# Run a single test file
deno run -A node_modules/.bin/vitest run tests/unit/lib/critic-parser.test.ts

# Run tests matching a pattern
deno run -A node_modules/.bin/vitest run -t "pattern"
```

## Architecture

See `docs/technical-architecture.md` for full details.

### Directory Layout

- `server/index.ts` — Deno server entry point (`Deno.serve()` with HTTP + WebSocket)
- `server/rooms.ts` — Document room management (Yjs sync, `@db/sqlite` persistence, auto-expiry)
- `agents/` — Original Durable Object agent (kept for reference)
- `app/components/` — React UI components
- `app/lib/` — Editor logic, CriticMarkup, Yjs provider, utilities
- `app/shared/` — Constants and types shared between client and server
- `app/routes/` — File-based routing (`home.tsx`, `docs.$id.tsx`, `new.ts`)
- `tests/` — Unit tests (`tests/unit/`) and integration tests (`tests/integration/`)
- `scripts/` — Build and compatibility helper scripts

### Import Path Alias

`~` resolves to `app/` (configured in tsconfig and vitest). Use `~/lib/foo` instead of relative paths.

### Critical Rule: Server/Client Separation

Client-side React components must **never** import from `server/`. Server modules use `@db/sqlite` and other server-only APIs that don't exist in the browser. Use `app/shared/` for types needed by both sides.

### Real-Time Collaboration Flow

The multiplayer system works as follows:

1. **`server/rooms.ts`** — manages in-memory document rooms, each holding a Yjs `Y.Doc`, persists state to SQLite on every update, and relays Yjs sync/awareness messages between connected WebSocket clients.
2. **`yjs-provider.ts`** (`app/lib/`) — client-side WebSocket provider that connects to the server at `/ws/:docId` and handles Yjs sync protocol encoding/decoding.
3. **TipTap** uses `@tiptap/extension-collaboration` (bound to the Yjs doc's `XmlFragment`) and `@tiptap/extension-collaboration-caret` for cursor awareness.
4. **Server entry** (`server/index.ts`) — `Deno.serve()` routes WebSocket upgrades to room handlers via `Deno.upgradeWebSocket()`, REST API calls to room management, and everything else to React Router SSR.

### CriticMarkup / Suggest Mode

Track-changes functionality spans multiple files:

- `app/lib/critic-marks.ts` — ProseMirror mark definitions (criticAddition, criticDeletion, criticComment, criticHighlight) with `inclusive: false`
- `app/lib/suggest-mode.ts` — ProseMirror plugin that intercepts edits and applies addition/deletion marks instead of direct changes
- `app/lib/critic-parser.ts` — Parses CriticMarkup syntax (`{++ ++}`, `{-- --}`, etc.) into clean text + mark ranges
- `app/lib/critic-serializer.ts` — Serializes marks back to CriticMarkup delimiter syntax
- `app/lib/critic-markup.ts` — TipTap extension that wires up the CriticMarkup marks and delimiter decorations

### Testing Constraints

- Server modules use `@db/sqlite` — integration tests mock this import. Unit tests should focus on pure logic in `app/lib/` and `app/shared/`.
- Coverage thresholds ramp linearly from 0% to 80% between Feb–Dec 2026 (see `vitest.config.ts`).
- Tests live in `tests/unit/` and `tests/integration/`, mirroring the source structure.

### ESLint Conventions

- Unused variables must be prefixed with `_` (e.g., `_args`, `_ctx`).
- Tagged template expressions are allowed (for `this.sql` in Durable Objects).
