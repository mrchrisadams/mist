import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { MSG_SYNC, MSG_AWARENESS, DOCUMENT_TTL_MS, DOC_FORMAT_VERSION } from "../app/shared/constants";
import type { ServerWebSocket } from "bun";

export interface RoomWSData {
  docId: string;
}

interface DocumentRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<ServerWebSocket<RoomWSData>>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const rooms = new Map<string, DocumentRoom>();
let db: Database;

export function initDB(dbPath = "./data/mist.db") {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.run("PRAGMA journal_mode=WAL");
  db.run(
    `CREATE TABLE IF NOT EXISTS doc_state (
      doc_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value BLOB,
      PRIMARY KEY (doc_id, key)
    )`
  );

  // Restore expiry timers for existing documents
  const rows = db
    .prepare("SELECT doc_id, value FROM doc_state WHERE key = 'createdAt'")
    .all() as { doc_id: string; value: Buffer }[];
  for (const row of rows) {
    const createdAt = new Float64Array(
      row.value.buffer.slice(row.value.byteOffset, row.value.byteOffset + row.value.byteLength)
    )[0];
    const remaining = createdAt + DOCUMENT_TTL_MS - Date.now();
    if (remaining <= 0) {
      deleteDocument(row.doc_id);
    } else {
      scheduleExpiry(row.doc_id, remaining);
    }
  }
}

export function getDB(): Database {
  return db;
}

function scheduleExpiry(docId: string, ms: number) {
  // Clear any existing timer
  const existing = rooms.get(docId);
  if (existing?.expiryTimer) clearTimeout(existing.expiryTimer);

  const timer = setTimeout(() => deleteDocument(docId), ms);
  // If a room exists in memory, attach the timer to it
  const room = rooms.get(docId);
  if (room) room.expiryTimer = timer;
  // If no room yet, we'll create a placeholder timer reference
  // by storing it — but actually the room may not exist yet.
  // We store the timer on a temporary structure if needed.
  if (!room) {
    // Store the timer so we can clear it if the room is created before it fires
    pendingTimers.set(docId, timer);
  }
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function deleteDocument(docId: string) {
  const room = rooms.get(docId);
  if (room) {
    for (const ws of room.clients) {
      ws.close(1000, "Document expired");
    }
    room.doc.destroy();
    clearTimeout(room.expiryTimer);
    rooms.delete(docId);
  }
  const pending = pendingTimers.get(docId);
  if (pending) {
    clearTimeout(pending);
    pendingTimers.delete(docId);
  }
  db.prepare("DELETE FROM doc_state WHERE doc_id = ?").run(docId);
}

function getOrCreateRoom(docId: string): DocumentRoom {
  let room = rooms.get(docId);
  if (room) return room;

  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);

  // Load persisted state
  const row = db
    .prepare("SELECT value FROM doc_state WHERE doc_id = ? AND key = 'state'")
    .get(docId) as { value: Buffer } | null;
  if (row?.value) {
    const state = new Uint8Array(
      row.value.buffer.slice(row.value.byteOffset, row.value.byteOffset + row.value.byteLength)
    );
    Y.applyUpdate(doc, state);
  }

  // Persist on every update
  doc.on("update", () => {
    const state = Y.encodeStateAsUpdate(doc);
    db.prepare(
      "INSERT INTO doc_state (doc_id, key, value) VALUES (?, 'state', ?) ON CONFLICT(doc_id, key) DO UPDATE SET value = excluded.value"
    ).run(docId, Buffer.from(state));
  });

  // Recover pending timer or create a dummy timer
  let expiryTimer = pendingTimers.get(docId);
  if (expiryTimer) {
    pendingTimers.delete(docId);
  } else {
    // No pending timer — set a far-future placeholder (will be replaced on POST)
    expiryTimer = setTimeout(() => {}, 2 ** 31 - 1);
  }

  room = { doc, awareness, clients: new Set(), expiryTimer };
  rooms.set(docId, room);
  return room;
}

/* ------------------------------------------------------------------ */
/*  WebSocket handlers (called from Bun.serve websocket config)        */
/* ------------------------------------------------------------------ */

export function wsOpen(ws: ServerWebSocket<RoomWSData>) {
  const { docId } = ws.data;
  const room = getOrCreateRoom(docId);
  room.clients.add(ws);

  // Send SyncStep1
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, room.doc);
  ws.sendBinary(encoding.toUint8Array(syncEncoder));

  // Send SyncStep2 (full state)
  const stateEncoder = encoding.createEncoder();
  encoding.writeVarUint(stateEncoder, MSG_SYNC);
  syncProtocol.writeSyncStep2(stateEncoder, room.doc);
  ws.sendBinary(encoding.toUint8Array(stateEncoder));

  // Send current awareness states
  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    const clients = Array.from(awarenessStates.keys());
    const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, clients);
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(awarenessEncoder, update);
    ws.sendBinary(encoding.toUint8Array(awarenessEncoder));
  }
}

export function wsMessage(
  ws: ServerWebSocket<RoomWSData>,
  message: string | Buffer,
) {
  if (typeof message === "string") return;

  const { docId } = ws.data;
  const room = rooms.get(docId);
  if (!room) return;

  const data = new Uint8Array(message);
  const decoder = decoding.createDecoder(data);
  const msgType = decoding.readVarUint(decoder);

  switch (msgType) {
    case MSG_SYNC: {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, null);

      if (encoding.length(encoder) > 1) {
        ws.sendBinary(encoding.toUint8Array(encoder));
      }

      // Broadcast to other clients
      for (const client of room.clients) {
        if (client !== ws) {
          client.sendBinary(data);
        }
      }
      break;
    }
    case MSG_AWARENESS: {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);

      for (const client of room.clients) {
        if (client !== ws) {
          client.sendBinary(data);
        }
      }
      break;
    }
  }
}

export function wsClose(ws: ServerWebSocket<RoomWSData>) {
  const { docId } = ws.data;
  const room = rooms.get(docId);
  if (!room) return;
  room.clients.delete(ws);
}

/* ------------------------------------------------------------------ */
/*  HTTP API (called from Bun.serve fetch handler)                     */
/* ------------------------------------------------------------------ */

export async function createDocument(
  docId: string,
  request: Request,
): Promise<Response> {
  const room = getOrCreateRoom(docId);

  // Mark as existing
  db.prepare(
    "INSERT INTO doc_state (doc_id, key, value) VALUES (?, 'exists', ?) ON CONFLICT(doc_id, key) DO UPDATE SET value = excluded.value"
  ).run(docId, Buffer.from([1]));

  // Stamp doc format version
  const meta = room.doc.getMap<number>("meta");
  if (!meta.has("version")) {
    meta.set("version", DOC_FORMAT_VERSION);
  }

  // Store creation timestamp and schedule auto-delete
  const now = Date.now();
  const createdAtBuf = Buffer.from(new Float64Array([now]).buffer);
  db.prepare(
    "INSERT INTO doc_state (doc_id, key, value) VALUES (?, 'createdAt', ?) ON CONFLICT(doc_id, key) DO UPDATE SET value = excluded.value"
  ).run(docId, createdAtBuf);

  // Schedule expiry
  clearTimeout(room.expiryTimer);
  room.expiryTimer = setTimeout(() => deleteDocument(docId), DOCUMENT_TTL_MS);

  // Parse optional JSON body with content/threads/onboarding
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as {
        content?: string;
        threads?: unknown[];
        onboarding?: boolean;
      };
      if (body.content) {
        const { parseCriticMarkupToContent } = await import(
          "../app/lib/critic-parser"
        );
        const frag = room.doc.getXmlFragment("default");
        if (frag.length === 0) {
          const lines = body.content.split("\n");
          for (const line of lines) {
            const { cleanText, marks } = parseCriticMarkupToContent(line);
            const para = new Y.XmlElement("paragraph");
            const ytext = new Y.XmlText(cleanText);
            for (const mark of marks) {
              const attrs: Record<string, Record<string, unknown>> = {};
              attrs[mark.type] = mark.attrs ?? {};
              ytext.format(mark.from, mark.to - mark.from, attrs);
            }
            para.insert(0, [ytext]);
            frag.insert(frag.length, [para]);
          }
        }
      }
      if (body.threads && Array.isArray(body.threads)) {
        const threadsMap = room.doc.getMap<string>("threads");
        for (const thread of body.threads) {
          const t = thread as { id?: string };
          if (t.id) {
            threadsMap.set(t.id, JSON.stringify(thread));
          }
        }
      }
      if (body.onboarding) {
        const docState = room.doc.getMap<string>("docState");
        docState.set("onboarding", "true");
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Unsupported CriticMarkup")
      ) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      // Ignore other malformed JSON — document is still created
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}

export function checkDocument(docId: string): Response {
  // Ensure room is initialised so we can check the DB
  getOrCreateRoom(docId);

  const existsRow = db
    .prepare("SELECT value FROM doc_state WHERE doc_id = ? AND key = 'exists'")
    .get(docId) as { value: Buffer } | null;
  const exists = !!existsRow;

  const createdAtRow = db
    .prepare(
      "SELECT value FROM doc_state WHERE doc_id = ? AND key = 'createdAt'",
    )
    .get(docId) as { value: Buffer } | null;
  const createdAt = createdAtRow
    ? new Float64Array(
        createdAtRow.value.buffer.slice(
          createdAtRow.value.byteOffset,
          createdAtRow.value.byteOffset + createdAtRow.value.byteLength,
        ),
      )[0]
    : null;

  return new Response(JSON.stringify({ exists, createdAt }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Expose for testing */
export function _getRooms() {
  return rooms;
}

export function _deleteDocument(docId: string) {
  deleteDocument(docId);
}
