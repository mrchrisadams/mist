import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import Editor from "~/components/Editor";

function makeYjs() {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  return {
    doc,
    awareness,
    socket: null as unknown as WebSocket,
    synced: false,
  };
}

describe("Editor SSR", () => {
  it("renders without throwing during server-side rendering", () => {
    const yjs = makeYjs();

    expect(() => {
      renderToString(createElement(Editor, { yjs }));
    }).not.toThrow();

    yjs.doc.destroy();
  });
});
