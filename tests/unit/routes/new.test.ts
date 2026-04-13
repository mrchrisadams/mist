import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("~/shared/constants", async () => {
  const actual = await vi.importActual<typeof import("~/shared/constants")>(
    "~/shared/constants",
  );
  return {
    ...actual,
    generateDocumentId: vi.fn().mockReturnValue("abcd1234"),
  };
});

// Minimal mock — redirect just needs to return a Response with Location
vi.mock("react-router", () => ({
  redirect: (url: string) =>
    new Response(null, { status: 302, headers: { Location: url } }),
}));

import { action, loader } from "~/routes/new";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function postRequest(body: string | null, headers?: Record<string, string>) {
  const init: RequestInit = { method: "POST" };
  if (body !== null) init.body = body;
  if (headers) init.headers = headers;
  return new Request("https://mist.example.com/new", init);
}

function putRequest(body: string) {
  return new Request("https://mist.example.com/new", { method: "PUT", body });
}

const context = {} as Parameters<typeof action>[0]["context"];

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("GET /new (loader)", () => {
  it("redirects to /", () => {
    const response = loader() as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });
});

describe("POST /new (action)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  it("returns 201 with document URL for valid markdown", async () => {
    const request = postRequest("# Hello world\n\nSome content.");
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("text/plain");

    const text = await response.text();
    expect(text).toBe("https://mist.example.com/docs/abcd1234\n");
  });

  it("returns 201 for empty body (blank document)", async () => {
    const request = postRequest("");
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).toContain("/docs/abcd1234");
  });

  it("creates document via fetch with content", async () => {
    const request = postRequest("# Test");
    await action({ request, context } as Parameters<typeof action>[0]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://mist.example.com/agents/document-agent/abcd1234");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.content).toBe("# Test");
  });

  it("handles PUT requests (curl -T)", async () => {
    const md = "# Uploaded\n\nBody text.\n";
    const request = putRequest(md);
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).toContain("/docs/abcd1234");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toBe("# Uploaded\n\nBody text.\n");
  });

  it("preserves newlines in multiline markdown", async () => {
    const md = "# Title\n\nParagraph one.\n\nParagraph two.\n";
    const request = postRequest(md);
    await action({ request, context } as Parameters<typeof action>[0]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toBe("# Title\n\nParagraph one.\n\nParagraph two.\n");
  });

  it("sends empty POST to agent when body is blank", async () => {
    const request = postRequest("   ");
    await action({ request, context } as Parameters<typeof action>[0]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).toBeUndefined();
  });

  it("strips frontmatter and passes threads to agent", async () => {
    const md = `---
mist:
  threads:
    - comment: "Nice"
      author: "Alice"
      color: "#E57373"
      created: "2026-01-01T00:00:00Z"
      resolved: false
---

# Doc with threads
`;
    const request = postRequest(md);
    await action({ request, context } as Parameters<typeof action>[0]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.content).toBe("# Doc with threads\n");
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].commentText).toBe("Nice");
  });

  it("returns 400 for binary content (null bytes)", async () => {
    const request = postRequest("hello\0world");
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("binary");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 413 when content exceeds 1MB", async () => {
    const bigContent = "x".repeat(1_000_001);
    const request = postRequest(bigContent);
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(413);
    const text = await response.text();
    expect(text).toContain("too large");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 413 when content-length header exceeds 1MB", async () => {
    const request = postRequest("small body", {
      "content-length": "2000000",
    });
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(413);
    const text = await response.text();
    expect(text).toContain("too large");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("relays agent error message on 400 response", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: "Unsupported CriticMarkup: substitution" }),
        { status: 400 },
      ),
    );

    const request = postRequest("some content");
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("Unsupported CriticMarkup");
  });

  it("returns generic error when agent fails with non-JSON response", async () => {
    mockFetch.mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const request = postRequest("some content");
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("failed to create document");
  });

  it("returns 500 on unexpected error", async () => {
    mockFetch.mockRejectedValue(new Error("network failure"));

    const request = postRequest("some content");
    const response = await action({ request, context } as Parameters<typeof action>[0]);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("something went wrong");
  });

  it("all error responses are plain text", async () => {
    // Binary
    const r1 = await action({
      request: postRequest("a\0b"),
      context,
    } as Parameters<typeof action>[0]);
    expect(r1.headers.get("Content-Type")).toBe("text/plain");

    // Too large
    const r2 = await action({
      request: postRequest("x".repeat(1_000_001)),
      context,
    } as Parameters<typeof action>[0]);
    expect(r2.headers.get("Content-Type")).toBe("text/plain");
  });
});
