# MIST: Open-Source Self-Hosted Deployment Alternatives

Three proposals for running MIST on a single VM without Cloudflare Workers or Durable Objects. All assume ≤20 concurrent users.

---

## Proposal 1: Node.js + Express + `ws` + better-sqlite3

**The "plain Node" approach — minimal dependencies, maximum control.**

### Technologies

- **Runtime:** Node.js 20+
- **HTTP framework:** Express (or Fastify — either works; Express chosen for ubiquity)
- **WebSocket server:** [`ws`](https://github.com/websockets/ws) — the standard Node WebSocket library
- **Database:** [`better-sqlite3`](https://github.com/JoshuaWise/better-sqlite3) — synchronous SQLite from Node
- **SSR / frontend build:** React Router 7 in "node" adapter mode + Vite
- **Process manager:** systemd (or PM2 if you prefer)

### How Each Cloudflare Capability Gets Replaced

| Cloudflare feature | Replacement |
|-|-|
| **Workers runtime** | Node.js HTTP server (Express) serving SSR + static assets |
| **Durable Objects (per-doc state)** | A plain `Map<string, DocumentRoom>` in the Node process. Each `DocumentRoom` holds a `Y.Doc`, an `Awareness`, and a `Set<WebSocket>` for connected clients |
| **DO SQLite** | A single `better-sqlite3` database file with a `doc_state` table keyed by `(doc_id, key)` |
| **DO Alarm API** | `setTimeout()` per document. On startup, scan the DB for all documents and re-schedule their expiry timers |
| **Agents SDK routing** | Express route: `app.get('/ws/:docId', (req, res) => ...)` that upgrades to WebSocket via `ws` |
| **`useAgent` React hook** | Replace with a 5-line hook that does `new WebSocket(`ws://${host}/ws/${docId}`)` and passes it to `YjsProvider` (which is already framework-agnostic) |
| **`@cloudflare/vite-plugin`** | `@react-router/node` adapter. Vite config drops the `cloudflare()` plugin, uses `reactRouter()` with node target |
| **Wrangler** | `vite build` + `node ./build/server/index.js` |

### Server Architecture Sketch

```
┌─────────────────────────────────────────────┐
│  Node.js process                            │
│                                             │
│  Express                                    │
│  ├── GET /              → SSR (home)        │
│  ├── POST /new          → create doc        │
│  ├── GET /docs/:id      → SSR (editor)      │
│  ├── GET /assets/*      → static files      │
│  └── GET /ws/:id        → WebSocket upgrade │
│                                             │
│  In-memory Map<string, DocumentRoom>        │
│  ┌─────────────┐  ┌─────────────┐           │
│  │ Room "abc"  │  │ Room "xyz"  │  ...      │
│  │  Y.Doc      │  │  Y.Doc      │           │
│  │  Awareness  │  │  Awareness  │           │
│  │  Set<WS>    │  │  Set<WS>    │           │
│  └──────┬──────┘  └──────┬──────┘           │
│         │                │                  │
│         └───────┬────────┘                  │
│                 ▼                            │
│        better-sqlite3                       │
│        ./data/mist.db                       │
└─────────────────────────────────────────────┘
```

Key server-side file (`server/rooms.ts`, ~150 lines):

```ts
import Database from 'better-sqlite3';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { WebSocket } from 'ws';

interface DocumentRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const rooms = new Map<string, DocumentRoom>();
const db = new Database('./data/mist.db');

// The message handling logic is nearly identical to the existing
// DocumentAgent.onMessage — it decodes the Yjs binary protocol,
// applies updates to the Y.Doc, persists to SQLite, and broadcasts.
```

### Trade-offs

| Dimension | Assessment |
|-|-|
| **Complexity** | ⭐ Lowest of the three proposals. ~200 lines of new server code. No new paradigms. |
| **Performance** | More than sufficient. `better-sqlite3` is synchronous but handles thousands of writes/sec. 20 users is trivial. |
| **Operational burden** | One process, one SQLite file. Back up the file. Done. |
| **Ecosystem** | Express, `ws`, and `better-sqlite3` are among the most downloaded packages on npm. Battle-tested. |
| **Resilience** | Single process = if it crashes, all WebSocket connections drop. Clients reconnect automatically (Yjs providers do this). No data loss because state is persisted to SQLite on every update. |
| **Scale ceiling** | Comfortable to ~500 concurrent connections on a single process. Way beyond the 20-user requirement. |

### Scale Appropriateness (20 users)

This is the right level of engineering for 20 users. No message queues, no separate services, no container orchestration. A single Node process holding a `Map` of document rooms is the equivalent of what Durable Objects do, minus the geographic distribution you don't need.

### Codebase Changes Required

1. **`vite.config.ts`** — Remove `cloudflare()` plugin. Add `@react-router/node` adapter configuration.
2. **`workers/app.ts`** → **`server/index.ts`** — Replace with an Express server that: mounts React Router SSR handler, creates a `ws.WebSocketServer`, handles upgrade requests on `/ws/:docId`.
3. **`agents/document.ts`** → **`server/rooms.ts`** — Port the `DocumentAgent` class to a plain `DocumentRoom` class. The core Yjs sync/awareness logic (onMessage, onConnect, broadcast) is identical — it just operates on `ws.WebSocket` instead of the Agents SDK `Connection` type. Replace `this.sql` calls with `better-sqlite3` prepared statements. Replace `this.ctx.storage.setAlarm()` with `setTimeout()`.
4. **`app/lib/useYjsEditor.ts`** — Replace the `useAgent()` call with a plain `useEffect` that creates a `new WebSocket(...)` to `/ws/${docId}`. The `YjsProvider` class needs zero changes.
5. **`app/routes/new.ts`** — Replace `getAgentByName(env.DocumentAgent, id)` with a direct function call to the room manager (e.g., `rooms.createDocument(id, content)`).
6. **`app/routes/docs.$id.tsx`** — Same: replace the DO stub fetch with a direct call to check if a doc exists in the DB.
7. **`app/lib/cloudflare.server.ts`** — Delete entirely.
8. **`package.json`** — Remove `agents`, `@cloudflare/vite-plugin`, `wrangler`. Add `express`, `ws`, `better-sqlite3`, `@react-router/node`.

---

## Proposal 2: Deno + Hono + Deno.Kv

**A different runtime entirely — leverage Deno's built-in tooling to eliminate dependencies.**

### Technologies

- **Runtime:** [Deno](https://deno.com/) 2.x (open source, MIT licensed)
- **HTTP framework:** [Hono](https://hono.dev/) (already a transitive dependency in MIST via the agents package)
- **WebSockets:** Deno's built-in `Deno.upgradeWebSocket()` — no library needed
- **Database:** [Deno KV](https://docs.deno.com/deploy/kv/manual/) backed by SQLite locally (built into the runtime, zero config), OR just use `better-sqlite3` via npm compatibility
- **SSR:** React Router 7 — Deno runs the same Vite build via npm compatibility
- **Process manager:** systemd

### How Each Cloudflare Capability Gets Replaced

| Cloudflare feature | Replacement |
|-|-|
| **Workers runtime** | Deno process running Hono |
| **Durable Objects** | Same in-memory `Map<string, DocumentRoom>` pattern as Proposal 1, but using Deno APIs |
| **DO SQLite** | Deno KV: `const kv = await Deno.openKv("./data/mist.db")`. Store Yjs state as `kv.set(["doc", docId, "state"], stateBytes)`. Deno KV is backed by SQLite under the hood — zero setup. |
| **DO Alarm API** | `setTimeout()` (same as Proposal 1) |
| **Agents SDK routing** | Hono route: `app.get('/ws/:docId', (c) => { ... Deno.upgradeWebSocket() ... })` |
| **`useAgent` hook** | Same plain WebSocket hook as Proposal 1 |
| **`@cloudflare/vite-plugin`** | Vite builds the client bundle normally. Server entry uses Hono directly. |
| **Wrangler** | `deno run --allow-net --allow-read --allow-write server.ts` |

### Server Architecture Sketch

```
┌─────────────────────────────────────────────┐
│  Deno process                               │
│                                             │
│  Hono                                       │
│  ├── GET /              → SSR               │
│  ├── POST /new          → create doc        │
│  ├── GET /docs/:id      → SSR               │
│  ├── GET /assets/*      → serveStatic()     │
│  └── GET /ws/:id        → upgradeWebSocket  │
│                                             │
│  Map<string, DocumentRoom>                  │
│  (same pattern as Proposal 1)               │
│                                             │
│  Deno KV (backed by local SQLite)           │
│  Keys: ["doc", docId, "state"]              │
│         ["doc", docId, "createdAt"]         │
│         ["doc", docId, "exists"]            │
└─────────────────────────────────────────────┘
```

### Trade-offs

| Dimension | Assessment |
|-|-|
| **Complexity** | ⭐⭐ Slightly more than Proposal 1 because of runtime switch. But the server code itself is simpler — no `ws` or `better-sqlite3` dependencies since WebSockets and KV are built-in. |
| **Performance** | Excellent. Deno's V8-based runtime is fast. Deno KV is fast for small key-value workloads. |
| **Operational burden** | Low. Single binary runtime (`deno`), no `node_modules` to manage (Deno caches deps). One process, one KV file. |
| **Ecosystem** | Deno has npm compatibility, so all existing MIST dependencies (yjs, tiptap, react, etc.) work via `npm:` specifiers. Hono is already in the dependency tree. |
| **Risk** | Deno KV's local backend is stable but less battle-tested than `better-sqlite3`. If concerned, use `better-sqlite3` via npm compat instead — Deno supports it. |
| **Migration effort** | Moderate. Need to verify all npm deps work under Deno (most do). TypeScript runs natively — no `tsc` step. |

### Scale Appropriateness (20 users)

Same as Proposal 1 — the in-memory room map pattern is the right abstraction for this scale. The Deno advantage is fewer moving parts: no separate SQLite library to compile (native bindings), no WebSocket library to install. The trade-off is a less common runtime for deployment.

### Codebase Changes Required

1. **Runtime switch** — Add a `deno.json` with npm dependency mappings. Existing `package.json` deps work via Deno's npm compatibility.
2. **`vite.config.ts`** — Remove `cloudflare()` plugin. Configure for standard SSR build.
3. **`workers/app.ts`** → **`server/main.ts`** — Hono server with `Deno.serve()`. WebSocket upgrade via `Deno.upgradeWebSocket()`.
4. **`agents/document.ts`** → **`server/rooms.ts`** — Same port as Proposal 1 but using `Deno.openKv()` instead of `better-sqlite3` for persistence. The Yjs protocol handling code is identical.
5. **`app/lib/useYjsEditor.ts`** — Same change as Proposal 1: replace `useAgent()` with plain `new WebSocket()`.
6. **`app/routes/new.ts` and `docs.$id.tsx`** — Replace DO stub calls with direct function calls to the room manager.
7. **`app/lib/cloudflare.server.ts`** — Delete.
8. **Dependencies** — Remove `agents`, `@cloudflare/vite-plugin`, `wrangler`. No new npm deps needed (WebSocket + KV are built into Deno).

---

## Proposal 3: y-sweet (Jamsocket) — Purpose-Built Yjs Server

**Don't rewrite the collaboration server at all — use an open-source Yjs server designed for exactly this.**

### Technologies

- **Collaboration server:** [y-sweet](https://github.com/jamsocket/y-sweet) — an open-source standalone Yjs sync + persistence server written in Rust. Handles WebSocket connections, Yjs sync protocol, and document persistence out of the box.
- **HTTP / SSR:** Node.js + Express (or any framework) running React Router 7 for the web app only.
- **Storage backend:** y-sweet's built-in filesystem persistence (stores Yjs document state as files on disk). No separate database needed.
- **Process manager:** systemd (two units: one for y-sweet, one for Node)

### How Each Cloudflare Capability Gets Replaced

| Cloudflare feature | Replacement |
|-|-|
| **Workers runtime** | Node.js for the web app. y-sweet for the collab server. |
| **Durable Objects** | y-sweet IS the replacement. It holds Y.Docs in memory, handles WebSocket sync, persists to disk. Each document is identified by a string ID — same as DO naming. |
| **DO SQLite** | y-sweet persists Yjs state to disk (or S3-compatible storage). No SQLite needed. |
| **DO Alarm API** | A cron job or a simple script that deletes document files older than 99 hours. y-sweet stores each doc as a file — `find ./data -mmin +5940 -delete` in a cron. |
| **Agents SDK routing** | Not needed. y-sweet exposes its own WebSocket endpoint. Clients connect directly to it. |
| **`useAgent` hook** | Replace with y-sweet's `@y-sweet/react` hooks, OR just use a plain WebSocket pointed at y-sweet's URL. y-sweet speaks standard Yjs sync protocol. |
| **`@cloudflare/vite-plugin`** | `@react-router/node` adapter (same as Proposal 1) |

### Server Architecture Sketch

```
┌─────────────────────────────────────────────┐
│  VM                                         │
│                                             │
│  ┌───────────────────────┐                  │
│  │ Node.js (web app)     │                  │
│  │                       │                  │
│  │ Express               │                  │
│  │ ├── GET /        SSR  │                  │
│  │ ├── POST /new    API  │─── creates doc──▶│
│  │ ├── GET /docs/:id SSR │                  │
│  │ └── GET /assets/*     │                  │
│  └───────────────────────┘                  │
│                                             │
│  ┌───────────────────────┐                  │
│  │ y-sweet server (Rust) │                  │
│  │                       │                  │
│  │ :8080                 │                  │
│  │ ├── WS /:docId   sync │◀── browsers     │
│  │ ├── POST /doc/new     │    connect       │
│  │ └── GET /doc/:id/auth │    directly      │
│  │                       │                  │
│  │ Filesystem storage:   │                  │
│  │ ./data/docs/          │                  │
│  └───────────────────────┘                  │
│                                             │
│  Cron: delete expired doc files             │
└─────────────────────────────────────────────┘
```

Client connection flow:
1. Browser loads `/docs/abc123` → Node.js SSR renders the page.
2. Client-side JS requests a y-sweet connection token from the Node app (or connects directly if auth isn't needed).
3. Client opens WebSocket to `ws://host:8080/doc/abc123`.
4. y-sweet handles all Yjs sync, awareness, and persistence.

### Trade-offs

| Dimension | Assessment |
|-|-|
| **Complexity** | ⭐⭐ for the MIST codebase (you delete the entire `agents/document.ts` and all server-side Yjs code). ⭐⭐⭐ for operations (two processes instead of one). |
| **Performance** | Best of the three. y-sweet is written in Rust and optimized for Yjs workloads. Not that it matters at 20 users. |
| **Operational burden** | Two processes to manage. But y-sweet is a single static binary with minimal config. |
| **Ecosystem** | y-sweet is actively maintained by Jamsocket (the company behind it). MIT licensed. Has a React SDK (`@y-sweet/react`). But it's a smaller project than Express or ws — less community knowledge. |
| **Vendor coupling** | y-sweet is fully open source and self-hostable. No lock-in. But you are coupling to their document storage format. |
| **Customization** | You lose fine-grained control over the sync server. The existing `DocumentAgent` has custom logic (format version stamping, content initialization on POST). This would need to move into the Node app layer or use y-sweet's hooks. |

### Scale Appropriateness (20 users)

Slightly over-engineered for 20 users (a Rust server for a problem a Node.js Map could solve), but the trade-off is that you **delete all the server-side Yjs protocol code**. The `agents/document.ts` file — the most complex server code in MIST — simply goes away. If you value less custom code over fewer moving parts, this is the right choice.

### Codebase Changes Required

1. **Delete `agents/document.ts`** — y-sweet replaces all of it.
2. **`workers/app.ts`** → **`server/index.ts`** — Plain Express server for SSR only. No WebSocket handling.
3. **`app/routes/new.ts`** — Instead of calling a DO stub, call y-sweet's HTTP API to create a document (`POST /doc/new`). Then make a second call to write initial content (y-sweet provides an API for this, or use the `@y-sweet/sdk` Node package).
4. **`app/routes/docs.$id.tsx`** — Loader calls y-sweet's HTTP API to check if a doc exists. Pass the y-sweet connection URL to the client.
5. **`app/lib/useYjsEditor.ts`** — Replace `useAgent()` with `@y-sweet/react`'s `useYDoc()` and `useYSweet()` hooks, OR keep the existing `YjsProvider` and just point a plain WebSocket at y-sweet's endpoint (it speaks the same Yjs sync protocol).
6. **Document initialization** — The current `DocumentAgent.onRequest(POST)` parses content and populates the Y.Doc server-side. With y-sweet, you'd either: (a) create the doc via y-sweet's SDK from the Node app, write content using the SDK's server-side Y.Doc access, or (b) create an empty doc and have the client populate it after connecting.
7. **Auto-expiry** — Add a cron job: `find ./data/docs -type f -mmin +5940 -delete` (99 hours = 5940 minutes). Or a small script that queries y-sweet's doc metadata.
8. **Dependencies** — Remove `agents`, `@cloudflare/vite-plugin`, `wrangler`. Add `@y-sweet/sdk` (server) and optionally `@y-sweet/react` (client). Install the y-sweet binary.

---

## Proposal 4: Bun — Single Binary Runtime with Built-in WebSockets and SQLite

**The Node-compatible runtime that ships the kitchen sink — eliminate external dependencies by using what Bun provides out of the box.**

### Technologies

- **Runtime:** [Bun](https://bun.sh/) 1.x (MIT licensed, single binary install)
- **HTTP server:** Bun's built-in `Bun.serve()` — no Express, no Hono, no framework needed
- **WebSocket server:** Bun's built-in WebSocket support via `Bun.serve({ websocket: ... })` — no `ws` library
- **Database:** Bun's built-in `bun:sqlite` — a native SQLite binding shipping inside the runtime, no `better-sqlite3`
- **SSR / frontend build:** React Router 7 — Bun is Node-API compatible, so `@react-router/node` works. Vite also runs under Bun.
- **Process manager:** systemd

### Why Bun Specifically

Bun's pitch for this project is that the three heaviest dependencies in Proposal 1 (Express, `ws`, `better-sqlite3`) are all replaced by things built into the runtime itself:

| Proposal 1 dependency | Bun built-in equivalent |
|-|-|
| `express` (HTTP routing + static files) | `Bun.serve()` with `fetch` handler + `Bun.file()` for static assets |
| `ws` (WebSocket server) | `Bun.serve({ websocket: { open, message, close } })` — first-class WebSocket support integrated with the HTTP server |
| `better-sqlite3` (SQLite) | `import { Database } from "bun:sqlite"` — synchronous, zero-install SQLite |

This means `package.json` adds **zero new runtime dependencies** for the server layer. The only additions are dev/build dependencies (`@react-router/node`).

### How Each Cloudflare Capability Gets Replaced

| Cloudflare feature | Replacement |
|-|-|
| **Workers runtime** | Bun process running `Bun.serve()` for HTTP + WebSocket on a single port |
| **Durable Objects (per-doc state)** | In-memory `Map<string, DocumentRoom>` — same pattern as Proposals 1 and 2 |
| **DO SQLite** | `bun:sqlite` — `new Database("./data/mist.db")`. Same schema as Proposal 1 (`doc_state` table keyed by `(doc_id, key)`) |
| **DO Alarm API** | `setTimeout()` per document. Restore timers from DB on startup. |
| **Agents SDK routing** | `Bun.serve()` WebSocket upgrade: check URL in `fetch` handler, return `server.upgrade(req, { data: { docId } })` |
| **`useAgent` React hook** | Plain WebSocket hook: `new WebSocket(\`ws://\${host}/ws/\${docId}\`)` passed to the existing `YjsProvider` |
| **`@cloudflare/vite-plugin`** | `@react-router/node` adapter. Vite runs under Bun (`bun run vite build`). |
| **Wrangler** | `bun run build && bun ./server/index.ts` |

### Server Architecture Sketch

```
┌─────────────────────────────────────────────┐
│  Bun process (single port, e.g. :8000)      │
│                                             │
│  Bun.serve({                                │
│    fetch(req, server) {                     │
│      // WebSocket upgrade for /ws/:docId    │
│      if (url matches /ws/:id)               │
│        return server.upgrade(req, { data }) │
│                                             │
│      // Static assets                       │
│      if (url starts with /assets/)          │
│        return new Response(Bun.file(...))   │
│                                             │
│      // SSR via React Router                │
│      return reactRouterHandler(req)         │
│    },                                       │
│    websocket: {                             │
│      open(ws) { /* join room, send sync */ }│
│      message(ws, msg) { /* relay Yjs */ }   │
│      close(ws) { /* leave room */ }         │
│    }                                        │
│  })                                         │
│                                             │
│  Map<string, DocumentRoom>                  │
│  ┌─────────────┐  ┌─────────────┐           │
│  │ Room "abc"  │  │ Room "xyz"  │  ...      │
│  │  Y.Doc      │  │  Y.Doc      │           │
│  │  Awareness  │  │  Awareness  │           │
│  │  Set<WS>    │  │  Set<WS>    │           │
│  └──────┬──────┘  └──────┬──────┘           │
│         └───────┬────────┘                  │
│                 ▼                            │
│        bun:sqlite (built-in)                │
│        ./data/mist.db                       │
└─────────────────────────────────────────────┘
```

Key server entry (`server/index.ts`, ~120 lines):

```ts
import { Database } from "bun:sqlite";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

const db = new Database("./data/mist.db");
const rooms = new Map<string, DocumentRoom>();

Bun.serve({
  port: 8000,
  fetch(req, server) {
    const url = new URL(req.url);
    const wsMatch = url.pathname.match(/^\/ws\/([a-z0-9]{8})$/);
    if (wsMatch) {
      const upgraded = server.upgrade(req, { data: { docId: wsMatch[1] } });
      if (upgraded) return;  // Bun handles the rest
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    // ... static files via Bun.file(), SSR via React Router handler
  },
  websocket: {
    open(ws) { /* getOrCreateRoom(ws.data.docId), send SyncStep1+2 */ },
    message(ws, message) { /* decode Yjs protocol, apply, broadcast */ },
    close(ws) { /* remove from room, clean up awareness */ },
  },
});
```

Note how Bun's API integrates HTTP and WebSocket into a single `serve()` call — there's no separate `ws.WebSocketServer` to wire up, no `server.on("upgrade")` dance.

### Trade-offs

| Dimension | Assessment |
|-|-|
| **Complexity** | ⭐ Lowest of all four proposals. Fewer lines than Proposal 1 because there's no Express routing boilerplate and no WebSocket library setup. ~120 lines of server code. |
| **New runtime deps** | **Zero.** HTTP server, WebSocket, and SQLite are all built into Bun. |
| **Performance** | Bun's WebSocket server is benchmarked significantly faster than `ws` on Node. `bun:sqlite` is faster than `better-sqlite3`. None of this matters at 20 users, but it means you have enormous headroom. |
| **Operational burden** | Single process, single SQLite file, single binary runtime. `curl -fsSL https://bun.sh/install | bash` to install. |
| **Ecosystem risk** | Bun is younger than Node and Deno. npm compatibility is very good (>99% of packages work) but edge cases exist. React Router and Vite both work under Bun today. The main risk is hitting a compatibility bug in a transitive dependency. |
| **Node API compatibility** | Bun implements most of the Node.js API surface. The existing MIST codebase uses standard APIs (Buffer, crypto, streams) that Bun supports. The `y-protocols` and `lib0` packages work fine. |
| **Community** | Growing fast but smaller than Node. Stack Overflow answers and blog posts are less abundant. |
| **TypeScript** | Bun runs `.ts` files natively — no compile step for the server. |

### Scale Appropriateness (20 users)

This is arguably the most right-sized option. You get the same in-memory room pattern as Proposals 1 and 2, but with fewer moving parts — no package to install for WebSockets, no native addon to compile for SQLite. For a single VM serving 20 users, Bun's single-binary approach means less to install, less to break, less to update.

The risk is proportional to the maturity: if you hit a Bun-specific bug, the community is smaller and you may need to report it upstream. For a low-traffic internal tool this is acceptable; for a production service with an SLA it would give pause.

### Codebase Changes Required

1. **`vite.config.ts`** — Remove `cloudflare()` plugin. Add `@react-router/node` adapter config. Vite runs under Bun (`bun run vite build`).
2. **`workers/app.ts`** → **`server/index.ts`** — Replace with a `Bun.serve()` entry point. The `fetch` handler does URL routing (WebSocket upgrade, static files, SSR). The `websocket` handler object replaces the Agents SDK connection management.
3. **`agents/document.ts`** → **`server/rooms.ts`** — Port `DocumentAgent` to a `DocumentRoom` class. Replace `this.sql` template literals with `bun:sqlite` prepared statements (`db.prepare(...).run(...)`). The Yjs sync/awareness protocol code is identical — only the storage and WebSocket APIs change. Replace `this.ctx.storage.setAlarm()` with `setTimeout()`.
4. **`app/lib/useYjsEditor.ts`** — Replace `useAgent()` with a `useEffect` creating `new WebSocket(\`ws://\${host}/ws/\${docId}\`)`. The `YjsProvider` class needs **zero changes** (it already works with standard WebSocket).
5. **`app/routes/new.ts`** — Replace `getAgentByName()` call with a direct function call to the room manager.
6. **`app/routes/docs.$id.tsx`** — Replace DO stub fetch with a direct check against the SQLite DB.
7. **`app/lib/cloudflare.server.ts`** — Delete.
8. **`wrangler.jsonc`** — Delete.
9. **`package.json`** — Remove `agents`, `@cloudflare/vite-plugin`, `wrangler`. Add `@react-router/node`. Remove `better-sqlite3` and `ws` if they were considered — they're not needed. Run `bun install` instead of `npm install`.
10. **`tsconfig.json`** — Add `"types": ["bun-types"]` for `bun:sqlite` and `Bun.serve` type definitions.

### Bun-Specific Niceties

- **`bun --watch server/index.ts`** — built-in file watching with fast restart, replaces nodemon/tsx watch.
- **`Bun.file(path)`** — zero-copy static file serving, no `express.static()` middleware.
- **`bun:sqlite` transactions** — `db.transaction(() => { ... })()` for atomic writes, useful if you want to batch the Yjs state + metadata writes.
- **`Bun.password.hash()` / `Bun.CryptoHasher`** — built-in crypto, useful if auth is added later.
- **No `node_modules` compilation** — `bun install` is fast and doesn't need to compile native addons (unlike `better-sqlite3` which requires a C++ toolchain).

---

## Comparison Summary

| | Proposal 1: Node + Express + ws | Proposal 2: Deno + Hono + KV | Proposal 3: y-sweet | Proposal 4: Bun |
|-|-|-|-|-|
| **Paradigm** | DIY — port the DO logic to plain Node | DIY — same pattern, different runtime | Delegate — use a purpose-built Yjs server | DIY — same pattern, batteries-included runtime |
| **Processes** | 1 | 1 | 2 (Node + y-sweet) | 1 |
| **New runtime deps** | express, ws, better-sqlite3 | (built into Deno) | @y-sweet/sdk, y-sweet binary | **None** (HTTP, WS, SQLite all built-in) |
| **Lines of new server code** | ~200 | ~180 | ~50 (just HTTP routes) | ~120 |
| **Lines deleted** | ~200 (agent code moves, doesn't vanish) | ~200 (same) | ~200 (agent code is truly deleted) | ~200 (same as Proposal 1) |
| **Operational complexity** | Lowest | Low | Moderate (two services) | Lowest |
| **Runtime familiarity** | Highest (Node.js) | Moderate (Deno) | Moderate (Rust binary) | High (Node-compatible) |
| **Native addon compilation** | Yes (`better-sqlite3`) | No | No | No |
| **Right-sized for 20 users** | ✅ Yes | ✅ Yes | ✅ Slightly over, but less custom code | ✅ Yes |

## Recommendation

**Proposal 1 (Node + Express + ws + better-sqlite3)** is the safest default. It's the smallest conceptual leap from the current architecture, uses the most mainstream tools, and results in a single process with a single SQLite file. The existing `DocumentAgent` logic translates almost line-for-line.

**Proposal 4 (Bun)** is the most concise option — zero new runtime dependencies, the fewest lines of server code, and no native addon compilation. If you're comfortable with a younger runtime, it's the cleanest single-VM deployment. The npm compatibility is good enough that the existing MIST client code should work unchanged.

Choose **Proposal 2** if you're already in the Deno ecosystem and want its built-in KV store.

Choose **Proposal 3** if you'd rather not own the Yjs sync server code at all and are comfortable running two processes.
