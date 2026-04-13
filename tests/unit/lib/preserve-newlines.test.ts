import { describe, it, expect } from "vitest";
import { Schema, Slice, Fragment } from "@tiptap/pm/model";

/**
 * Tests for the clipboard text parser logic used by the PreserveNewlines
 * extension. This validates that every single newline in pasted text
 * creates a new paragraph (rather than the ProseMirror default which
 * only splits on double-newlines and collapses single newlines to spaces).
 */

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] as const },
    text: { inline: true },
  },
  marks: {},
});

/** Replicates the clipboardTextParser from PreserveNewlines extension */
function parseClipboardText(text: string): Slice {
  const paragraphType = schema.nodes.paragraph;
  const lines = text.split(/\r?\n/);
  const nodes = lines.map((line) =>
    paragraphType.createAndFill({}, line ? schema.text(line) : undefined)!,
  );
  return new Slice(Fragment.from(nodes), 0, 0);
}

describe("PreserveNewlines clipboard text parser", () => {
  it("creates one paragraph for single-line text", () => {
    const slice = parseClipboardText("hello world");
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.child(0).textContent).toBe("hello world");
  });

  it("creates separate paragraphs for each line", () => {
    const slice = parseClipboardText("line 1\nline 2\nline 3");
    expect(slice.content.childCount).toBe(3);
    expect(slice.content.child(0).textContent).toBe("line 1");
    expect(slice.content.child(1).textContent).toBe("line 2");
    expect(slice.content.child(2).textContent).toBe("line 3");
  });

  it("preserves empty lines as empty paragraphs", () => {
    const slice = parseClipboardText("line 1\n\nline 3");
    expect(slice.content.childCount).toBe(3);
    expect(slice.content.child(0).textContent).toBe("line 1");
    expect(slice.content.child(1).textContent).toBe("");
    expect(slice.content.child(2).textContent).toBe("line 3");
  });

  it("handles Windows-style CRLF line endings", () => {
    const slice = parseClipboardText("line 1\r\nline 2\r\nline 3");
    expect(slice.content.childCount).toBe(3);
    expect(slice.content.child(0).textContent).toBe("line 1");
    expect(slice.content.child(1).textContent).toBe("line 2");
    expect(slice.content.child(2).textContent).toBe("line 3");
  });

  it("handles trailing newline", () => {
    const slice = parseClipboardText("line 1\nline 2\n");
    expect(slice.content.childCount).toBe(3);
    expect(slice.content.child(0).textContent).toBe("line 1");
    expect(slice.content.child(1).textContent).toBe("line 2");
    expect(slice.content.child(2).textContent).toBe("");
  });

  it("creates an empty paragraph for empty input", () => {
    const slice = parseClipboardText("");
    expect(slice.content.childCount).toBe(1);
    expect(slice.content.child(0).textContent).toBe("");
  });

  it("preserves markdown list items as separate paragraphs", () => {
    const markdown = "- item 1\n- item 2\n- item 3";
    const slice = parseClipboardText(markdown);
    expect(slice.content.childCount).toBe(3);
    expect(slice.content.child(0).textContent).toBe("- item 1");
    expect(slice.content.child(1).textContent).toBe("- item 2");
    expect(slice.content.child(2).textContent).toBe("- item 3");
  });

  it("preserves code block structure", () => {
    const code = "```js\nconst x = 1;\nconst y = 2;\n```";
    const slice = parseClipboardText(code);
    expect(slice.content.childCount).toBe(4);
    expect(slice.content.child(0).textContent).toBe("```js");
    expect(slice.content.child(1).textContent).toBe("const x = 1;");
    expect(slice.content.child(2).textContent).toBe("const y = 2;");
    expect(slice.content.child(3).textContent).toBe("```");
  });
});
