# mist (Bun fork)

Collaborative markdown editor. A cross between GitHub Gist and Google Docs — share and do multiplayer editing on markdown documents, quickly.

Everything is public by URL. Documents persist live with no save button. Multiple users see each other's cursors in real time.

> **This is a fork** that replaces Cloudflare Workers + Durable Objects with a single [Bun](https://bun.sh/) process, designed to run on a single VM. See the upstream repo at [inanimate-tech/mist](https://github.com/inanimate-tech/mist) for the Cloudflare version.

## Features

- **Real-time multiplayer editing** via TipTap + Yjs, backed by Bun's built-in SQLite
- **Live markdown formatting** — inline styles render as you type, with formatting characters shown in grey
- **Suggest mode** — track changes using CriticMarkup (additions, deletions, comments, highlights)
- **Threaded comments** with highlight anchoring
- **Preview mode** — rendered markdown with click, hover, or keypress toggle
- **CLI upload** — `curl https://your-domain/new -T file.md`
- **Drag and drop** `.md` files to create new documents
- **Dark/light/auto themes**
- **Documents auto-expire** after 99 hours

## Tech stack

- [Bun](https://bun.sh/) (runtime — built-in HTTP server, WebSocket server, and SQLite)
- [React Router 7](https://reactrouter.com/) (SSR)
- [TipTap 3](https://tiptap.dev/) (editor)
- [Yjs](https://yjs.dev/) (CRDT for multiplayer)
- [Tailwind CSS 4](https://tailwindcss.com/) (styling)
- TypeScript, Vitest

### What changed from upstream

- **Cloudflare Workers** → `Bun.serve()` (single entry point in `server/index.ts`)
- **Durable Objects** → in-memory `Map<string, DocumentRoom>` with `bun:sqlite` persistence (`server/rooms.ts`)
- **Agents SDK** → plain WebSocket routing via URL pattern matching
- **`useAgent()` hook** → plain `new WebSocket()` in `useYjsEditor.ts`
- **Zero new runtime dependencies** — HTTP, WebSocket, and SQLite are all built into Bun

## Getting started

### Prerequisites

- [Bun](https://bun.sh/) 1.x (`curl -fsSL https://bun.sh/install | bash`)
- Node.js 22+ (for the Vite build toolchain and tests)

### Setup

```bash
git clone https://github.com/mrchrisadams/mist.git
cd mist
git checkout ca-mist-bun
npm install
```

### Development

```bash
npm run dev
```

### Production

```bash
npm run build          # Build the React Router app
bun run server/index.ts # Start the Bun server
```

Or in one step:

```bash
npm run preview
```

The server listens on port 8000 by default. Set `PORT` env var to change it.

Data is stored in `./data/mist.db` (SQLite, created automatically).

### Commands

```bash
npm run dev          # Local development server (Vite)
npm run build        # Production build
npm run start        # Start Bun production server
npm run preview      # Build + start
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run test         # Vitest with coverage
npm run test:watch   # Vitest in watch mode
```

## Project structure

```
server/       Bun server entry point + room management
  index.ts    Bun.serve() — HTTP, WebSocket, static files, SSR
  rooms.ts    Document rooms — Yjs sync, SQLite persistence, auto-expiry
app/
  components/ UI components
  lib/        Editor logic, utilities, CriticMarkup, Yjs provider
  routes/     File-based routing
  shared/     Types and constants shared between client and server
agents/       (kept for reference — original Durable Object agent)
tests/        Test suite
```

## Licence

[MIT](LICENSE)
