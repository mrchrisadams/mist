# MIST Code Review

General code review of the MIST collaborative markdown editor, focused on patterns that break common web development conventions and would trip up developers new to the project.

---

## 1. The `sqlBlob` Type Lie

**File:** `agents/document.ts`

```typescript
function sqlBlob(data: Uint8Array): string {
  return data as unknown as string;
}
```

This double-cast deliberately lies to TypeScript, treating a `Uint8Array` as a `string`. The comment explains why — Cloudflare's Durable Object SQLite API actually accepts `Uint8Array` for BLOB columns via its template literal syntax, but the type signature says `string`. This is a reasonable workaround for a platform typing gap, but it's the kind of thing that will make a new developer do a double-take and possibly "fix" it. The grep-able name and comment are good; consider adding a `// DO NOT CHANGE` marker or linking to Cloudflare docs.

**Risk:** Low — it works correctly. The danger is someone removing it thinking it's a bug.

---

## 2. `Math.random()` for Document IDs

**File:** `app/shared/constants.ts`

```typescript
export function generateDocumentId(): string {
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return id;
}
```

This uses `Math.random()` to generate 8-character document IDs that serve as the sole access control for documents (anyone with the URL can edit). `Math.random()` is not cryptographically secure — its output is predictable given enough samples. With only 36^8 ≈ 2.8 trillion possible IDs and no rate limiting on the existence-check endpoint (`GET /agents/document-agent/:id`), an attacker could enumerate valid document IDs.

The same function is also used in `useThreads.ts` for thread/reply IDs via a local `generateId()`, where it matters less.

**Recommendation:** Use `crypto.getRandomValues()` (available in both Workers and browsers) for document IDs. Thread IDs are internal and don't need cryptographic randomness.

---

## 3. No Authentication + Unguessable URLs = The Entire Security Model

There is no authentication anywhere. Documents are "protected" only by the unguessability of their URLs. This is an intentional design choice (like a pastebin), but a new developer should understand its implications:

- **Anyone with the URL has full edit access** — there's no read-only mode, no permissions.
- **The `GET /agents/document-agent/:id` endpoint** returns `{ exists: true/false }`, enabling enumeration.
- **Document creation has no rate limiting** — no captcha, no IP throttling. The `POST /new` and `POST /agents/document-agent/:id` endpoints could be spammed.
- **The 99-hour TTL is the only cleanup mechanism** — there's no way to manually delete a document before its alarm fires.

This is fine for a WIP tool with 20 users, but should be documented as explicit non-goals rather than oversights.

---

## 4. Full Yjs State Written on Every Keystroke

**File:** `agents/document.ts`

```typescript
this.doc.on("update", () => {
  const state = Y.encodeStateAsUpdate(this.doc!);
  this.sql`INSERT INTO doc_state ...`;
});
```

This re-encodes and writes the **entire** Yjs document state on every single update (i.e., every keystroke from any connected client). The conventional Yjs persistence pattern is to store incremental updates and periodically compact them. Here, every update triggers a full state snapshot.

For 20 users this won't be a problem, but a developer familiar with Yjs will expect incremental persistence and may be confused by the simplicity. It also means that if two updates arrive near-simultaneously, you get two full-state writes where only the last one matters — harmless (idempotent via UPSERT) but wasteful.

**Why it's fine for now:** Durable Object SQLite is co-located with the DO instance (no network round-trip), and the document size is bounded by the 1MB upload limit.

---

## 5. `connection.id` Cast to Number for Awareness Protocol

**File:** `agents/document.ts`

```typescript
awarenessProtocol.removeAwarenessStates(
  this.awareness,
  [connection.id as unknown as number],
  null,
);
```

The Agents SDK uses string IDs for connections; the Yjs awareness protocol expects numbers. The comment says "The protocol converts via toString() internally, so this is safe" — but this is fragile. If the awareness protocol changes its internal handling, or if a future Agents SDK version changes ID format, this breaks silently. A new developer will rightly question this cast.

**Recommendation:** Consider assigning numeric client IDs (e.g., from `doc.clientID`) in `onConnect` and storing a mapping, rather than force-casting.

---

## 6. The God Context: `DocumentContextValue` with 30+ Fields

**File:** `app/lib/DocumentContext.tsx`

The `DocumentContextValue` interface has 30+ fields covering:
- Yjs state, editor instance, markdown text
- Mode toggling, preview toggling, clean view toggling
- Comment input state (active, selection, highlight range)
- Thread CRUD operations
- Onboarding state
- Editor lifecycle callbacks

Every component that needs *any* of these values subscribes to the same context, so **any state change re-renders every consumer**. This is a well-known React anti-pattern. In practice with 20 users it's probably not causing visible jank, but it makes the code hard to reason about — you can't tell from a component's `useDocument()` call which specific pieces of state it depends on.

**What trips people up:** A developer adding a new feature will naturally put state in this context (it's the established pattern), making the problem worse over time. Consider splitting into focused contexts (e.g., `EditorContext`, `ThreadContext`, `UIContext`) or using a state management library.

---

## 7. `useEffect` Dispatching ProseMirror Transactions from React State

**File:** `app/components/Editor.tsx`

Three separate `useEffect` hooks dispatch ProseMirror transactions in response to React prop changes:

```typescript
useEffect(() => {
  if (!editor) return;
  const range = commentHighlight ?? null;
  // ... comparison with ref ...
  const tr = editor.state.tr.setMeta(commentHighlightKey, range);
  editor.view.dispatch(tr);
}, [editor, commentHighlight]);
```

This creates a React→ProseMirror data flow that goes against ProseMirror's conventional plugin-driven architecture. Normally, ProseMirror state should be driven by plugins reacting to transactions, not by React effects dispatching transactions from outside. Each `useEffect` includes manual ref-based comparison (`prevHighlightRef`, `prevActiveRangeRef`, `prevCleanViewRef`) to avoid infinite loops — a code smell indicating the data flow is fighting the framework.

**Why it's done this way:** Tiptap's React integration makes it hard to pass React state into ProseMirror plugins reactively. The `setMeta` approach is actually the recommended Tiptap escape hatch. But three of these in one component is pushing it.

---

## 8. Suggest Mode Only Handles Text Input and Backspace

**File:** `app/lib/suggest-mode.ts`

The suggest mode plugin intercepts `handleTextInput` and `handleKeyDown` (only `Backspace`). It does **not** handle:
- **Enter** (pressing Enter in suggest mode creates a normal paragraph split, not a tracked change)
- **Delete** key (forward-delete does nothing special)
- **Paste** (pasting in suggest mode inserts text without `criticAddition` marks)
- **Cut** (cutting doesn't mark text as deleted)
- **Drag-and-drop** (completely unhandled)
- **Undo/redo** (undoing in suggest mode can remove `criticDeletion` marks, effectively "un-deleting" text)

This is a significant correctness issue, not just a missing feature. A user in suggest mode reasonably expects *all* edits to be tracked. Pasting without tracking is particularly likely to cause confusion.

**Recommendation:** At minimum, intercept `handlePaste` to apply `criticAddition` marks. Consider `handleDrop` and `handleKeyDown` for Delete/Enter. Document the limitations prominently.

---

## 9. Thread Matching by Comment Text (Not by ID)

**Files:** `app/lib/comment-threads.ts`, `app/lib/useThreads.ts`

Threads are matched to their inline positions in the document by comparing `thread.commentText === comment.commentText` — i.e., by the literal text content of the comment. This means:

- **Two comments with identical text are ambiguous.** If you add two comments saying "fix this", the matching uses first-come-first-served by creation time. Clicking on the second one in the sidebar might highlight the first one in the editor.
- **Editing comment text breaks the association.** If the comment text is ever modified (e.g., by a collaborator's cursor accidentally including it in a selection replacement), the thread becomes orphaned.

The conventional approach would be to use a unique ID stored as a mark attribute (the `criticHighlight` mark already has a `threadId` attribute, but it's not used for matching).

---

## 10. `scanDocumentComments` Walks the Entire Document on Every Editor Update

**File:** `app/lib/comment-threads.ts` called from `app/lib/useThreads.ts`

```typescript
// In useThreads:
editor.on("update", handler);  // handler calls reconcile()
// reconcile() calls scanDocumentComments(editor)
// scanDocumentComments walks every node via doc.descendants()
```

Every keystroke triggers a full document walk to find comment marks. This is called from `reconcile()`, which also calls `readAllThreads()` (parsing every thread's JSON), then `matchThreadsToComments()` (which walks the threads list again with O(n×m) matching). Combined with the thread matching happening on every Y.Map change *and* every editor update, this is a lot of redundant work.

More importantly for correctness: the `reconcile` function auto-creates Y.Map entries for "unmatched" comments (comments in the document that don't match any existing thread). This runs on every editor update, so if matching briefly fails (e.g., during a multi-step transaction), it could create duplicate thread entries.

---

## 11. No WebSocket Reconnection

**Files:** `app/lib/yjs-provider.ts`, `app/lib/useYjsEditor.ts`

The `YjsProvider` has no reconnection logic. If the WebSocket disconnects (network blip, Cloudflare restart, laptop sleep/wake), the user sees "Offline" in the connection status indicator and must manually refresh the page. The `useAgent` hook from the `agents` package may handle some reconnection, but the `YjsProvider` doesn't re-sync state after reconnection.

Conventionally, collaborative editing providers (like y-websocket) include exponential backoff reconnection and state re-sync. The `onClose` handler just sets `synced = false`:

```typescript
private onClose(): void {
  if (this.synced) {
    this.synced = false;
    this.onSyncedChange?.(false);
  }
}
```

**Impact:** Users lose collaboration silently and continue editing locally. When they refresh, their local changes are lost because the Y.Doc only exists in memory.

---

## 12. Y.Doc Never Destroyed on Unmount

**File:** `app/lib/useYjsEditor.ts`

```typescript
const doc = useMemo(() => new Y.Doc(), []);
const awareness = useMemo(() => new Awareness(doc), [doc]);
```

The `Y.Doc` and `Awareness` instances are created via `useMemo` but never destroyed. There's no cleanup `useEffect` calling `doc.destroy()` or removing the awareness state. If the component unmounts and remounts (e.g., React strict mode in development, or navigating away and back), the old Y.Doc instances leak.

The `YjsProvider.destroy()` method does clean up its own listeners, but the doc and awareness themselves persist.

---

## 13. `useAgent` Socket Cast to WebSocket

**File:** `app/lib/useYjsEditor.ts`

```typescript
const ws = socket as unknown as WebSocket;
const provider = new YjsProvider(ws, doc, awareness, setSynced);
```

The return value of `useAgent()` is cast to `WebSocket` via `as unknown as WebSocket`. This is another type lie — the `agents` SDK returns its own socket type that happens to be WebSocket-compatible. If the SDK changes its return type, this breaks at runtime with no TypeScript warning.

---

## 14. `onRequest` Does Too Many Things in One Handler

**File:** `agents/document.ts`

The `onRequest` handler in `DocumentAgent` handles both `POST` (create document) and `GET` (check existence) with completely different logic. The POST handler alone:
1. Initializes the Yjs doc
2. Creates the SQLite table and marks existence
3. Sets doc format version
4. Stores creation timestamp
5. Sets the auto-delete alarm
6. Optionally parses JSON body
7. Parses CriticMarkup (via dynamic import)
8. Populates Yjs XML fragments with marks
9. Stores thread data
10. Sets onboarding flag

This is a 60+ line method doing document creation, parsing, and persistence. Errors in steps 6-10 are silently swallowed (the document is still created empty):

```typescript
} catch (err) {
  if (err instanceof Error && err.message.includes("Unsupported CriticMarkup")) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 400 });
  }
  // Ignore other malformed JSON — document is still created
}
```

A new developer might not realize that a malformed JSON body creates an empty document rather than returning an error.

---

## 15. Two Different Document Creation Paths

**Files:** `app/routes/home.tsx`, `app/routes/new.ts`

There are two ways to create a document:

1. **From the browser** (`home.tsx`): Client-side JavaScript generates the ID, calls `fetch("/agents/document-agent/${id}", { method: "POST" })` directly, then navigates.
2. **From curl** (`new.ts`): Server-side action generates the ID, calls the DO stub directly via `getAgentByName`, returns a URL.

The browser path calls the agent via its HTTP URL (routing through `routeAgentRequest`), while the curl path calls the DO stub directly. Both parse CriticMarkup and deserialize threads, but through slightly different code paths. The browser path doesn't check the response status before navigating:

```typescript
await fetch(`/agents/document-agent/${id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: body, threads, onboarding }),
});
navigate(`/docs/${id}`);  // navigates even if POST failed
```

---

## 16. Dynamic Import Inside Request Handler

**File:** `agents/document.ts`

```typescript
const { parseCriticMarkupToContent } = await import("../app/lib/critic-parser");
```

The CriticMarkup parser is dynamically imported inside the POST handler rather than statically imported at the top of the file. This is likely done to keep the module out of the initial DO bundle (it's only needed during document creation), but it's unexpected — a developer looking for where `critic-parser` is used won't find it in the imports.

---

## 17. Storing `createdAt` as a Float64Array Blob

**File:** `agents/document.ts`

```typescript
this.sql`INSERT INTO doc_state (key, value) VALUES ('createdAt', ${sqlBlob(new Uint8Array(new Float64Array([now]).buffer))})`;
// ...
const createdAt = new Float64Array(createdAtRows[0].value)[0];
```

The creation timestamp is stored as a `Float64Array` buffer in a BLOB column, then read back and reinterpreted. This is unusual when SQLite natively supports `REAL` or `INTEGER` types. It's done because the `doc_state` table has a single `BLOB` column for all values (keyed by string), avoiding a schema change. But it's the kind of thing that makes a new developer wonder if something is broken.

---

## 18. Coverage Thresholds Ramp from 0% to 80% Over a Future Year

**File:** `vitest.config.ts`

```typescript
function coverageThresholds() {
  const start = new Date("2026-02-01");
  const end = new Date("2026-12-31");
  // ...
}
```

The coverage thresholds are time-based, ramping linearly from 0% to 80% between February and December 2026. Since it's currently before that date, the thresholds are 0% — meaning **coverage checks are effectively disabled**. This is a creative approach to gradually introducing coverage requirements, but a new developer running `npm test` might be surprised that tests pass with 0% coverage.

---

## 19. Thread Data Stored as JSON Strings Inside a Y.Map

**Files:** `app/lib/useThreads.ts`, `agents/document.ts`

```typescript
const threadsMap = doc.getMap<string>("threads");
threadsMap.set(id, JSON.stringify(thread));
// ...
const thread: ThreadData = JSON.parse(raw);
```

Thread data is stored as serialized JSON strings in a `Y.Map<string>`. This means Yjs's CRDT conflict resolution operates on the entire JSON blob — if two users simultaneously edit different fields of the same thread (e.g., one adds a reply while another resolves it), one update wins entirely and the other is lost. The conventional approach with Yjs would be to use nested `Y.Map` structures so each field resolves independently.

---

## 20. `removeInlineComment` Walks Entire Document

**File:** `app/lib/useThreads.ts`

When resolving or deleting a thread, `removeInlineComment` removes highlight marks by walking the **entire document**:

```typescript
newDoc.descendants((node, pos) => {
  if (node.isText && node.marks.some((m) => m.type === highlightType)) {
    tr.removeMark(pos, pos + node.nodeSize, highlightType);
  }
});
```

This removes **all** highlight marks in the document, not just the one associated with the thread being resolved. If multiple highlighted comments exist, resolving one will strip the highlight from all of them.

---

## Summary

| # | Issue | Severity | Category |
|---|-------|----------|----------|
| 1 | `sqlBlob` double-cast | Low | Convention |
| 2 | `Math.random()` for document IDs | Medium | Security |
| 3 | No auth, enumerable existence endpoint | Medium | Security |
| 4 | Full state written every keystroke | Low | Convention |
| 5 | `connection.id` cast to number | Low | Correctness |
| 6 | 30+ field God Context | Medium | Architecture |
| 7 | `useEffect` dispatching PM transactions | Low | Convention |
| 8 | Suggest mode only handles text + backspace | High | Correctness |
| 9 | Thread matching by text content, not ID | Medium | Correctness |
| 10 | Full doc walk on every keystroke | Low | Convention |
| 11 | No WebSocket reconnection | High | Resilience |
| 12 | Y.Doc never destroyed | Low | Correctness |
| 13 | `useAgent` cast to WebSocket | Low | Convention |
| 14 | `onRequest` does too many things | Low | Architecture |
| 15 | Two different doc creation paths | Medium | Architecture |
| 16 | Dynamic import in request handler | Low | Convention |
| 17 | `createdAt` as Float64Array blob | Low | Convention |
| 18 | Time-based coverage thresholds (currently 0%) | Low | Testing |
| 19 | Thread data as JSON strings in Y.Map | Medium | Correctness |
| 20 | `removeInlineComment` strips ALL highlights | High | Correctness |

**Top priorities for a new developer to be aware of:**
1. **Suggest mode is incomplete** (#8) — users will lose tracked changes on paste/Enter/Delete
2. **No reconnection** (#11) — disconnected users lose local edits on refresh
3. **`removeInlineComment` is destructive** (#20) — resolving one thread strips highlights from all threads
4. **Thread JSON-in-Y.Map loses concurrent edits** (#19) — simultaneous thread operations cause data loss
5. **`Math.random()` IDs** (#2) — document URLs are the only access control and they're predictable
