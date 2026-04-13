/**
 * DocumentAgent / Rooms integration tests.
 *
 * Tests the room management logic with a mocked bun:sqlite module.
 * The original agent tests tested DocumentAgent lifecycle methods;
 * these tests exercise the rooms.ts module functions through mock
 * WebSocket/SQLite wiring.
 *
 * For Yjs sync tests, real Y.Doc clients exchange messages through the
 * actual room code — testing the sync relay, SQL persistence, and
 * awareness propagation end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { DOCUMENT_TTL_MS, DOC_FORMAT_VERSION } from "~/shared/constants";
import { YjsProvider } from "~/lib/yjs-provider";

/* ------------------------------------------------------------------ */
/*  Mock bun:sqlite                                                    */
/* ------------------------------------------------------------------ */

let mockSqlStore: Map<string, ArrayBuffer>;

class MockStatement {
  private query: string;

  constructor(query: string) {
    this.query = query.toLowerCase().trim();
  }

  run(...args: unknown[]) {
    if (this.query.includes("insert into doc_state")) {
      const docId = args[0] as string;
      const key = this.query.match(/,\s*'(\w+)'/)?.[1];
      if (key && args[1] !== undefined) {
        const val = args[1];
        const storeKey = `${docId}:${key}`;
        if (val instanceof Uint8Array || val instanceof Buffer) {
          const bytes = val instanceof Buffer ? val : Buffer.from(val);
          mockSqlStore.set(
            storeKey,
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          );
        }
      }
      return;
    }
    if (this.query.includes("delete from doc_state")) {
      const docId = args[0] as string;
      for (const key of mockSqlStore.keys()) {
        if (key.startsWith(`${docId}:`)) {
          mockSqlStore.delete(key);
        }
      }
      return;
    }
  }

  get(...args: unknown[]) {
    if (this.query.includes("select") && this.query.includes("from doc_state")) {
      const docId = args[0] as string;
      const keyMatch = this.query.match(/key\s*=\s*'(\w+)'/);
      if (keyMatch) {
        const storeKey = `${docId}:${keyMatch[1]}`;
        const buf = mockSqlStore.get(storeKey);
        if (buf) return { value: Buffer.from(buf) };
      }
      return null;
    }
    return null;
  }

  all() {
    if (this.query.includes("select") && this.query.includes("createdat")) {
      const results: { doc_id: string; value: Buffer }[] = [];
      for (const [key, buf] of mockSqlStore) {
        if (key.endsWith(":createdAt")) {
          results.push({
            doc_id: key.split(":")[0],
            value: Buffer.from(buf),
          });
        }
      }
      return results;
    }
    return [];
  }
}

class MockDatabase {
  run(_query: string) {}
  prepare(query: string) {
    return new MockStatement(query);
  }
}

vi.mock("bun:sqlite", () => ({
  Database: MockDatabase,
}));

/* ------------------------------------------------------------------ */
/*  Mock Socket (client-side WebSocket)                                */
/* ------------------------------------------------------------------ */

class MockSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockSocket.OPEN;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  onSend?: (data: Uint8Array) => void;

  send(data: Uint8Array | ArrayBuffer) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.sent.push(bytes);
    this.onSend?.(bytes);
  }

  close() {
    this.readyState = MockSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  receiveMessage(data: Uint8Array) {
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.dispatchEvent(new MessageEvent("message", { data: copy }));
  }
}

Object.defineProperty(MockSocket.prototype, "OPEN", { value: 1 });
Object.defineProperty(MockSocket.prototype, "CONNECTING", { value: 0 });

/* ------------------------------------------------------------------ */
/*  Mock ServerWebSocket (Bun-side)                                    */
/* ------------------------------------------------------------------ */

class MockServerWebSocket {
  data: { docId: string };
  closed = false;
  closeCode?: number;
  closeReason?: string;
  onSendBinary?: (data: Uint8Array) => void;

  constructor(docId: string) {
    this.data = { docId };
  }

  sendBinary(data: Uint8Array | ArrayBuffer) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    this.onSendBinary?.(bytes);
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    if (typeof data === "string") return;
    this.sendBinary(data);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("DocumentAgent (rooms)", () => {
  let rooms: typeof import("../../../server/rooms");

  beforeEach(async () => {
    vi.stubGlobal("WebSocket", MockSocket);
    mockSqlStore = new Map();

    // Fresh import each time to reset module state
    vi.resetModules();
    rooms = await import("../../../server/rooms");
    rooms.initDB();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /* ---- Helpers ---- */

  let nextConnId = 0;

  /**
   * Connect a full Yjs client through the rooms module.
   *
   * Wiring:
   *   server sends -> serverWs.sendBinary -> socket.receiveMessage -> YjsProvider
   *   YjsProvider sends -> socket.send -> rooms.wsMessage(serverWs, ...)
   */
  function connectYjsClient(docId = "testdoc1") {
    const connId = `conn-${nextConnId++}`;
    const socket = new MockSocket();
    const serverWs = new MockServerWebSocket(docId);

    // Wire server -> client
    serverWs.onSendBinary = (data) => socket.receiveMessage(data);

    // Create provider (attaches message listener to socket)
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const provider = new YjsProvider(
      socket as unknown as WebSocket,
      doc,
      awareness,
    );

    // Wire client -> server
    socket.onSend = (data) => {
      const buf = Buffer.from(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
      rooms.wsMessage(serverWs as never, buf);
    };

    // Trigger sync handshake
    rooms.wsOpen(serverWs as never);

    return { doc, awareness, socket, serverWs, provider, connId };
  }

  function cleanup(...clients: Array<{ provider: YjsProvider; doc: Y.Doc }>) {
    for (const c of clients) {
      c.provider.destroy();
      c.doc.destroy();
    }
  }

  /* ================================================================ */
  /*  HTTP GET (checkDocument)                                         */
  /* ================================================================ */

  describe("GET /", () => {
    it("returns exists: false for a fresh document", async () => {
      const res = rooms.checkDocument("newdoc01");
      const body = (await res.json());
      expect(body).toEqual({ exists: false, createdAt: null });
    });

    it("returns exists: true with createdAt after POST", async () => {
      const before = Date.now();
      await rooms.createDocument(
        "postdoc1",
        new Request("https://do/", { method: "POST" }),
      );
      const after = Date.now();

      const res = rooms.checkDocument("postdoc1");
      const body = (await res.json()) as { exists: boolean; createdAt: number };
      expect(body.exists).toBe(true);
      expect(body.createdAt).toBeGreaterThanOrEqual(before);
      expect(body.createdAt).toBeLessThanOrEqual(after);
    });
  });

  /* ================================================================ */
  /*  HTTP POST (createDocument)                                       */
  /* ================================================================ */

  describe("POST /", () => {
    it("returns { ok: true }", async () => {
      const res = await rooms.createDocument(
        "newdoc02",
        new Request("https://do/", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("stamps DOC_FORMAT_VERSION in Yjs meta map", async () => {
      await rooms.createDocument(
        "verdoc01",
        new Request("https://do/", { method: "POST" }),
      );

      const client = connectYjsClient("verdoc01");
      expect(client.doc.getMap<number>("meta").get("version")).toBe(
        DOC_FORMAT_VERSION,
      );
      cleanup(client);
    });

    it("imports plain text content", async () => {
      await rooms.createDocument(
        "txtdoc01",
        new Request("https://do/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "hello world" }),
        }),
      );

      const client = connectYjsClient("txtdoc01");
      const frag = client.doc.getXmlFragment("default");
      expect(frag.length).toBe(1);
      const para = frag.get(0) as Y.XmlElement;
      expect((para.get(0) as Y.XmlText).toString()).toBe("hello world");
      cleanup(client);
    });

    it("imports content with CriticMarkup marks", async () => {
      await rooms.createDocument(
        "cmrkdoc1",
        new Request("https://do/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "hello {++world++}" }),
        }),
      );

      const client = connectYjsClient("cmrkdoc1");
      const para = client.doc.getXmlFragment("default").get(0) as Y.XmlElement;
      const ytext = para.get(0) as Y.XmlText;
      expect(ytext.toDelta()).toEqual([
        { insert: "hello " },
        { insert: "world", attributes: { criticAddition: {} } },
      ]);
      cleanup(client);
    });

    it("imports multiline content as separate paragraphs", async () => {
      await rooms.createDocument(
        "mldoc001",
        new Request("https://do/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "line one\nline two\nline three" }),
        }),
      );

      const client = connectYjsClient("mldoc001");
      expect(client.doc.getXmlFragment("default").length).toBe(3);
      cleanup(client);
    });

    it("imports threads into Y.Map", async () => {
      const thread = { id: "t-1", commentText: "good point", replies: [] };
      await rooms.createDocument(
        "thrdoc01",
        new Request("https://do/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "text", threads: [thread] }),
        }),
      );

      const client = connectYjsClient("thrdoc01");
      const stored = JSON.parse(
        client.doc.getMap<string>("threads").get("t-1")!,
      );
      expect(stored.commentText).toBe("good point");
      cleanup(client);
    });

    it("returns 400 for unsupported CriticMarkup (substitution)", async () => {
      const res = await rooms.createDocument(
        "subdoc01",
        new Request("https://do/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "hello {~~old~>new~~}" }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Unsupported CriticMarkup");
    });

    it("still creates doc even with malformed JSON body", async () => {
      const res = await rooms.createDocument(
        "badjson1",
        new Request("https://do/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // Document should still exist
      const getRes = rooms.checkDocument("badjson1");
      const body = (await getRes.json()) as { exists: boolean };
      expect(body.exists).toBe(true);
    });
  });

  /* ================================================================ */
  /*  Alarm (auto-delete via _deleteDocument)                           */
  /* ================================================================ */

  describe("alarm", () => {
    it("clears all SQL data", async () => {
      await rooms.createDocument(
        "alrmdoc1",
        new Request("https://do/", { method: "POST" }),
      );
      // Check there's data
      let count = 0;
      for (const key of mockSqlStore.keys()) {
        if (key.startsWith("alrmdoc1:")) count++;
      }
      expect(count).toBeGreaterThan(0);

      rooms._deleteDocument("alrmdoc1");

      count = 0;
      for (const key of mockSqlStore.keys()) {
        if (key.startsWith("alrmdoc1:")) count++;
      }
      expect(count).toBe(0);
    });

    it("closes all active connections with code 1000", async () => {
      await rooms.createDocument(
        "alrmdoc2",
        new Request("https://do/", { method: "POST" }),
      );
      const ws1 = new MockServerWebSocket("alrmdoc2");
      const ws2 = new MockServerWebSocket("alrmdoc2");
      rooms.wsOpen(ws1 as never);
      rooms.wsOpen(ws2 as never);

      rooms._deleteDocument("alrmdoc2");

      expect(ws1.closed).toBe(true);
      expect(ws1.closeCode).toBe(1000);
      expect(ws1.closeReason).toBe("Document expired");
      expect(ws2.closed).toBe(true);
    });

    it("resets room to fresh state (exists: false after delete)", async () => {
      await rooms.createDocument(
        "alrmdoc3",
        new Request("https://do/", { method: "POST" }),
      );

      rooms._deleteDocument("alrmdoc3");

      const res = rooms.checkDocument("alrmdoc3");
      const body = (await res.json()) as { exists: boolean };
      expect(body.exists).toBe(false);
    });
  });

  /* ================================================================ */
  /*  Yjs sync through rooms                                           */
  /* ================================================================ */

  describe("Yjs sync", () => {
    it("syncs content from client A to client B", () => {
      const a = connectYjsClient("syncdoc1");
      a.doc.getText("default").insert(0, "hello from A");

      const b = connectYjsClient("syncdoc1");
      expect(b.doc.getText("default").toString()).toBe("hello from A");
      cleanup(a, b);
    });

    it("syncs live edits bidirectionally", () => {
      const a = connectYjsClient("syncdoc2");
      const b = connectYjsClient("syncdoc2");

      a.doc.getText("default").insert(0, "AAA");
      expect(b.doc.getText("default").toString()).toBe("AAA");

      b.doc.getText("default").insert(3, " BBB");
      expect(a.doc.getText("default").toString()).toBe("AAA BBB");
      cleanup(a, b);
    });

    it("persists state in SQL and restores on new room", async () => {
      const a = connectYjsClient("syncdoc3");
      a.doc.getText("default").insert(0, "persisted data");
      cleanup(a);
      rooms.wsClose(a.serverWs as never);

      // Force the room to be re-created from SQL by deleting it from memory
      rooms._getRooms().delete("syncdoc3");

      const b = connectYjsClient("syncdoc3");
      expect(b.doc.getText("default").toString()).toBe("persisted data");
      cleanup(b);
    });

    it("propagates awareness state between clients", () => {
      const a = connectYjsClient("syncdoc4");
      const b = connectYjsClient("syncdoc4");

      a.awareness.setLocalStateField("user", {
        name: "Alice",
        color: "#E57373",
      });

      const stateA = b.awareness.getStates().get(a.doc.clientID);
      expect(stateA?.user).toEqual({ name: "Alice", color: "#E57373" });
      cleanup(a, b);
    });

    it("new client receives content after first client disconnects", () => {
      const a = connectYjsClient("syncdoc5");
      a.doc.getText("default").insert(0, "before disconnect");
      a.provider.destroy();
      a.socket.close();
      rooms.wsClose(a.serverWs as never);
      a.doc.destroy();

      const b = connectYjsClient("syncdoc5");
      expect(b.doc.getText("default").toString()).toBe("before disconnect");
      cleanup(b);
    });

    it("handles rapid sequential edits", () => {
      const a = connectYjsClient("syncdoc6");
      const b = connectYjsClient("syncdoc6");

      const text = a.doc.getText("default");
      for (let i = 0; i < 50; i++) {
        text.insert(text.length, `${i} `);
      }

      const expected = Array.from({ length: 50 }, (_, i) => `${i} `).join("");
      expect(b.doc.getText("default").toString()).toBe(expected);
      cleanup(a, b);
    });

    it("handles deletions synced between clients", () => {
      const a = connectYjsClient("syncdoc7");
      const b = connectYjsClient("syncdoc7");

      a.doc.getText("default").insert(0, "hello world");
      expect(b.doc.getText("default").toString()).toBe("hello world");

      a.doc.getText("default").delete(6, 5);
      expect(b.doc.getText("default").toString()).toBe("hello ");
      cleanup(a, b);
    });
  });

  /* ================================================================ */
  /*  wsMessage edge cases                                             */
  /* ================================================================ */

  describe("wsMessage", () => {
    it("ignores string messages gracefully", () => {
      const serverWs = new MockServerWebSocket("edgedoc1");
      rooms.wsOpen(serverWs as never);
      // Should not throw
      rooms.wsMessage(serverWs as never, "some string message");
    });
  });

  /* ================================================================ */
  /*  wsClose                                                          */
  /* ================================================================ */

  describe("wsClose", () => {
    it("does not throw for unknown doc", () => {
      const serverWs = new MockServerWebSocket("unknown1");
      rooms.wsClose(serverWs as never);
    });

    it("does not throw after normal usage", () => {
      const serverWs = new MockServerWebSocket("clsdoc01");
      rooms.wsOpen(serverWs as never);
      rooms.wsClose(serverWs as never);
    });
  });
});
