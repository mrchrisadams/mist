/**
 * Deno server entry point for MIST.
 *
 * Handles:
 * 1. WebSocket upgrades for /ws/:docId
 * 2. REST API for document creation/checking
 * 3. Static asset serving from the Vite build
 * 4. React Router SSR for all other routes
 */
import {
  initDB,
  wsOpen,
  wsMessage,
  wsClose,
  createDocument,
  checkDocument,
} from "./rooms.ts";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

// Initialise SQLite
initDB();

// Dynamic import of the React Router handler (built by Vite)
const BUILD_DIR = "./build";

let handler: ((request: Request) => Promise<Response>) | null = null;

async function getHandler() {
  if (handler) return handler;
  const { createRequestHandler } = await import("react-router");
  const build = await import("../build/server/index.js");
  handler = createRequestHandler(build, "production");
  return handler;
}

const WS_PATTERN = /^\/ws\/([a-z0-9]{8})$/;
const DOC_AGENT_PATTERN = /^\/agents\/document-agent\/([a-z0-9]{8})$/;

/** MIME types for static assets */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".map": "application/json",
};

function serveStaticFile(filePath: string, cacheControl?: string): Response | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = Deno.readFileSync(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (cacheControl) headers["Cache-Control"] = cacheControl;
    return new Response(content, { headers });
  } catch {
    return null;
  }
}

const port = Number(Deno.env.get("PORT") || 8000);

Deno.serve({ port }, async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // WebSocket upgrade for /ws/:docId
  const wsMatch = url.pathname.match(WS_PATTERN);
  if (wsMatch) {
    const docId = wsMatch[1];
    try {
      const { socket, response } = Deno.upgradeWebSocket(req);
      // Attach docId to the socket for room handlers
      (socket as unknown as { _docId: string })._docId = docId;
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => wsOpen(socket));
      socket.addEventListener("message", (event) => wsMessage(socket, event.data));
      socket.addEventListener("close", () => wsClose(socket));
      return response;
    } catch {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
  }

  // REST API: /agents/document-agent/:docId
  const agentMatch = url.pathname.match(DOC_AGENT_PATTERN);
  if (agentMatch) {
    const docId = agentMatch[1];

    // WebSocket upgrade (client may connect here too)
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      try {
        const { socket, response } = Deno.upgradeWebSocket(req);
        (socket as unknown as { _docId: string })._docId = docId;
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => wsOpen(socket));
        socket.addEventListener("message", (event) => wsMessage(socket, event.data));
        socket.addEventListener("close", () => wsClose(socket));
        return response;
      } catch {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
    }

    if (req.method === "POST") {
      return createDocument(docId, req);
    }
    if (req.method === "GET") {
      return checkDocument(docId);
    }
    return new Response("Not found", { status: 404 });
  }

  // Static assets from Vite build (hashed — immutable cache)
  if (url.pathname.startsWith("/assets/")) {
    const res = serveStaticFile(
      join(BUILD_DIR, "client", url.pathname),
      "public, max-age=31536000, immutable",
    );
    if (res) return res;
  }

  // Favicon and other static files in client root
  if (url.pathname !== "/") {
    const res = serveStaticFile(join(BUILD_DIR, "client", url.pathname));
    if (res) return res;
  }

  // React Router SSR
  try {
    const h = await getHandler();
    return await h(req);
  } catch (err) {
    console.error("SSR error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
});

console.log(`MIST running at http://localhost:${port}`);
