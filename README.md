# mist (Deno fork)

Collaborative markdown editor. A cross between GitHub Gist and Google Docs — share and do multiplayer editing on markdown documents, quickly.

Everything is public by URL. Documents persist live with no save button. Multiple users see each other's cursors in real time.

> **This is a fork** that replaces Cloudflare Workers + Durable Objects with a single [Deno](https://deno.land/) process, designed to run on a single VM. See the upstream repo at [inanimate-tech/mist](https://github.com/inanimate-tech/mist) for the Cloudflare version.

## Features

- **Real-time multiplayer editing** via TipTap + Yjs, backed by SQLite (via `@db/sqlite` on JSR)
- **Live markdown formatting** — inline styles render as you type, with formatting characters shown in grey
- **Suggest mode** — track changes using CriticMarkup (additions, deletions, comments, highlights)
- **Threaded comments** with highlight anchoring
- **Preview mode** — rendered markdown with click, hover, or keypress toggle
- **CLI upload** — `curl https://your-domain/new -T file.md`
- **Drag and drop** `.md` files to create new documents
- **Dark/light/auto themes**
- **Documents auto-expire** after 99 hours

## Tech stack

- [Deno](https://deno.land/) 2.x (runtime — `Deno.serve()` for HTTP, `Deno.upgradeWebSocket()` for WebSocket)
- [@db/sqlite](https://jsr.io/@db/sqlite) (SQLite via JSR — persistence layer)
- [React Router 7](https://reactrouter.com/) (SSR)
- [TipTap 3](https://tiptap.dev/) (editor)
- [Yjs](https://yjs.dev/) (CRDT for multiplayer)
- [Tailwind CSS 4](https://tailwindcss.com/) (styling)
- TypeScript, Vitest

### What changed from upstream

- **Cloudflare Workers** → `Deno.serve()` (single entry point in `server/index.ts`)
- **Durable Objects** → in-memory `Map<string, DocumentRoom>` with `@db/sqlite` persistence (`server/rooms.ts`)
- **Agents SDK** → plain WebSocket routing via `Deno.upgradeWebSocket()` + URL pattern matching
- **`useAgent()` hook** → plain `new WebSocket()` in `useYjsEditor.ts`
- **`bun:sqlite`** → `@db/sqlite` from JSR (uses Deno FFI to load native SQLite)
- **Zero new npm dependencies** — WebSocket is built into Deno, SQLite comes from JSR

## Getting started

### Prerequisites

- [Deno](https://deno.land/) 2.x (`curl -fsSL https://deno.land/install.sh | sh`)

### Setup

```bash
git clone https://github.com/mrchrisadams/mist.git
cd mist
git checkout ca-mist-deno
npm install                 # Deno reads package.json; npm creates node_modules
bash scripts/patch-deno-compat.sh  # Fix CJS sub-path resolution for Deno
```

### Development

```bash
deno task dev
```

### Production

```bash
deno task build          # Build the React Router app
deno task start           # Start the Deno server
```

Or in one step:

```bash
deno task preview
```

The server listens on port 8000 by default. Set `PORT` env var to change it.

Data is stored in `./data/mist.db` (SQLite, created automatically).

### Commands

```bash
deno task dev          # Local development server (Vite via React Router)
deno task build        # Production build
deno task start        # Start Deno production server
deno task preview      # Build + start
deno task typecheck    # TypeScript type checking
deno task lint         # ESLint
deno task test         # Vitest with coverage (305 tests)
deno task test:watch   # Vitest in watch mode
```

## Project structure

```
server/       Deno server entry point + room management
  index.ts    Deno.serve() — HTTP, WebSocket, static files, SSR
  rooms.ts    Document rooms — Yjs sync, @db/sqlite persistence, auto-expiry
app/
  components/ UI components
  lib/        Editor logic, utilities, CriticMarkup, Yjs provider
  routes/     File-based routing
  shared/     Types and constants shared between client and server
agents/       (kept for reference — original Durable Object agent)
tests/        Test suite
scripts/      Build/compat helper scripts
deno.json     Deno tasks, import map, compiler options
```

## Notes

### Deno + npm compatibility

Deno 2.x has excellent npm compatibility. This project uses `package.json` for npm dependencies and `deno.json` for tasks and JSR imports (like `@db/sqlite`). The `nodeModulesDir: "manual"` setting in `deno.json` means `npm install` manages `node_modules/` directly.

### `--sloppy-imports`

The server runs with `--sloppy-imports` because the existing app code uses TypeScript imports without `.ts` extensions (standard for Vite/bundler projects). This flag allows Deno to resolve these imports at runtime.

### CJS sub-path workaround

`scripts/patch-deno-compat.sh` fixes a Deno CJS resolution issue where sub-directory `package.json` files with relative `main` fields aren't followed correctly. This affects `react-remove-scroll-bar/constants` (a transitive dependency of Radix UI). Run it after `npm install`.

## Licence

[MIT](LICENSE)
