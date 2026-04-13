/**
 * Bun server entry point for MIST.
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
  type RoomWSData,
} from "./rooms";

// Initialise SQLite
initDB();

// Dynamic import of the React Router handler (built by Vite)
const BUILD_DIR = "./build";

let handler: ((request: Request) => Promise<Response>) | null = null;

async function getHandler() {
  if (handler) return handler;
  // React Router's node adapter provides a createRequestHandler
  const { createRequestHandler } = await import("react-router");
  const build = await import("../build/server/index.js");
  handler = createRequestHandler(build, "production");
  return handler;
}

const WS_PATTERN = /^\/ws\/([a-z0-9]{8})$/;
const DOC_AGENT_PATTERN = /^\/agents\/document-agent\/([a-z0-9]{8})$/;

const server = Bun.serve<RoomWSData>({
  port: Number(process.env.PORT || 8000),
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for /ws/:docId
    const wsMatch = url.pathname.match(WS_PATTERN);
    if (wsMatch) {
      const docId = wsMatch[1];
      const upgraded = server.upgrade(req, { data: { docId } });
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // REST API: /agents/document-agent/:docId (backward-compatible with existing client code)
    const agentMatch = url.pathname.match(DOC_AGENT_PATTERN);
    if (agentMatch) {
      const docId = agentMatch[1];

      // WebSocket upgrade (client may connect here too)
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = server.upgrade(req, { data: { docId } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (req.method === "POST") {
        return createDocument(docId, req);
      }
      if (req.method === "GET") {
        return checkDocument(docId);
      }
      return new Response("Not found", { status: 404 });
    }

    // Static assets from Vite build
    if (url.pathname.startsWith("/assets/")) {
      const file = Bun.file(`${BUILD_DIR}/client${url.pathname}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }
    }

    // Favicon and other static files in client root
    const clientFile = Bun.file(`${BUILD_DIR}/client${url.pathname}`);
    if (url.pathname !== "/" && (await clientFile.exists())) {
      return new Response(clientFile);
    }

    // React Router SSR
    try {
      const h = await getHandler();
      return await h(req);
    } catch (err) {
      console.error("SSR error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
  websocket: {
    open: wsOpen,
    message: wsMessage,
    close: wsClose,
  },
});

console.log(`MIST running at http://localhost:${server.port}`);
