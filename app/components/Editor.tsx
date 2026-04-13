import { useEffect, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension, getMarkRange, type Editor as TiptapEditor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Slice, Fragment } from "@tiptap/pm/model";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { CriticAddition, CriticDeletion, CriticComment, CriticHighlight, CriticDelimiters } from "~/lib/critic-marks";
import { markdownDecorations, cleanViewKey } from "~/lib/markdown-decorations";
import { suggestModePlugin } from "~/lib/suggest-mode";
import BubbleToolbar from "~/components/BubbleToolbar";
import type { useYjsEditor } from "~/lib/useYjsEditor";

const MarkdownDecorations = Extension.create({
  name: "markdownDecorations",
  addProseMirrorPlugins() {
    return markdownDecorations();
  },
});

const SuggestMode = Extension.create<{ docState: ReturnType<typeof useYjsEditor>["docState"] | null }>({
  name: "suggestMode",
  addOptions() {
    return { docState: null };
  },
  addProseMirrorPlugins() {
    if (!this.options.docState) return [];
    return [suggestModePlugin(this.options.docState)];
  },
});

/**
 * Overrides ProseMirror's default clipboard text parser so that every
 * newline in pasted plain-text creates a new paragraph.  The default
 * behaviour only splits on double-newlines (treating single newlines
 * as spaces), which destroys line breaks in markdown, code, and any
 * other line-oriented content.
 */
const PreserveNewlines = Extension.create({
  name: "preserveNewlines",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("preserveNewlines"),
        props: {
          clipboardTextParser(text, $context, _plain, _view) {
            const schema = $context.parent.type.schema;
            const paragraphType = schema.nodes.paragraph;
            const lines = text.split(/\r?\n/);
            const nodes = lines.map((line) =>
              paragraphType.createAndFill({}, line ? schema.text(line) : undefined)!
            );
            return new Slice(Fragment.from(nodes), 0, 0);
          },
        },
      }),
    ];
  },
});

const CommentClickHandler = Extension.create<{
  onCommentClick?: (commentText: string) => void;
}>({
  name: "commentClickHandler",
  addOptions() {
    return { onCommentClick: undefined };
  },
  addProseMirrorPlugins() {
    const onCommentClick = this.options.onCommentClick;
    if (!onCommentClick) return [];
    return [
      new Plugin({
        props: {
          handleClick(view, pos) {
            const $pos = view.state.doc.resolve(pos);
            // Use nodeAt for reliable mark detection at boundaries (inclusive:false)
            const node = view.state.doc.nodeAt(pos);
            const marks = node?.isText ? node.marks : $pos.marks();

            // Direct click on comment text (or point marker at comment boundary)
            const commentMark = marks.find((m) => m.type.name === "criticComment");
            if (commentMark) {
              if (node?.isText) {
                onCommentClick(node.text ?? "");
              }
              return true;
            }

            // Click on highlighted text → find adjacent comment
            const highlightMark = marks.find((m) => m.type.name === "criticHighlight");
            if (highlightMark) {
              const highlightType = view.state.schema.marks.criticHighlight;
              const commentType = view.state.schema.marks.criticComment;
              if (highlightType && commentType) {
                const hlRange = getMarkRange($pos, highlightType);
                if (hlRange) {
                  const $afterHl = view.state.doc.resolve(hlRange.to);
                  const cmRange = getMarkRange($afterHl, commentType);
                  if (cmRange) {
                    const text = view.state.doc.textBetween(cmRange.from, cmRange.to);
                    onCommentClick(text);
                    return true;
                  }
                }
              }
            }

            return false;
          },
        },
      }),
    ];
  },
});

// Plugin that highlights a range while the comment input is open
const commentHighlightKey = new PluginKey("commentHighlight");

const CommentHighlight = Extension.create({
  name: "commentHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: commentHighlightKey,
        state: {
          init() {
            return null as { from: number; to: number } | null;
          },
          apply(tr, value) {
            const meta = tr.getMeta(commentHighlightKey);
            if (meta !== undefined) return meta;
            if (value && tr.docChanged) {
              const from = tr.mapping.map(value.from);
              const to = tr.mapping.map(value.to);
              return from < to ? { from, to } : null;
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            const range = commentHighlightKey.getState(state) as { from: number; to: number } | null;
            if (!range) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, {
                class: "comment-selection-highlight",
              }),
            ]);
          },
        },
      }),
    ];
  },
});

// Plugin that highlights the active comment thread's range in the editor
const activeCommentHighlightKey = new PluginKey("activeCommentHighlight");

const ActiveCommentHighlight = Extension.create({
  name: "activeCommentHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: activeCommentHighlightKey,
        state: {
          init() {
            return null as { from: number; to: number } | null;
          },
          apply(tr, value) {
            const meta = tr.getMeta(activeCommentHighlightKey);
            if (meta !== undefined) return meta;
            if (value && tr.docChanged) {
              const from = tr.mapping.map(value.from);
              const to = tr.mapping.map(value.to);
              return from < to ? { from, to } : null;
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            const range = activeCommentHighlightKey.getState(state) as {
              from: number;
              to: number;
            } | null;
            if (!range) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, {
                class: "cm-comment-active",
              }),
            ]);
          },
        },
      }),
    ];
  },
});

type YjsEditorState = ReturnType<typeof useYjsEditor>;

function renderCaret(user: Record<string, unknown>) {
  const cursor = document.createElement("span");
  cursor.classList.add("collaboration-cursor__caret");
  cursor.setAttribute("style", `border-color: ${user.color}`);

  const label = document.createElement("div");
  label.classList.add("collaboration-cursor__label");
  label.setAttribute("style", `background-color: ${user.color}`);
  label.insertBefore(document.createTextNode(user.name as string), null);

  cursor.insertBefore(label, null);
  return cursor;
}

export default function Editor({
  yjs,
  hidden,
  onEditorReady,
  onCommentClick,
  commentHighlight,
  activeCommentRange,
  cleanView,
  onNewComment,
  onResolveAtCursor,
  onDeleteAtCursor,
}: {
  yjs: YjsEditorState;
  hidden?: boolean;
  onEditorReady?: (editor: TiptapEditor) => void;
  onCommentClick?: (commentText: string) => void;
  commentHighlight?: { from: number; to: number } | null;
  activeCommentRange?: { from: number; to: number } | null;
  cleanView?: boolean;
  onNewComment?: () => void;
  onResolveAtCursor?: () => void;
  onDeleteAtCursor?: () => void;
}) {
  const { doc, awareness, user, docState } = yjs;
  const prevHighlightRef = useRef<{ from: number; to: number } | null>(null);
  const prevActiveRangeRef = useRef<{ from: number; to: number } | null>(null);
  const prevCleanViewRef = useRef<boolean>(false);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        Document,
        Paragraph,
        Text,
        CriticAddition,
        CriticDeletion,
        CriticComment,
        CriticHighlight,
        CriticDelimiters,
        Collaboration.configure({ document: doc }),
        CollaborationCaret.configure({
          provider: { awareness },
          user,
          render: renderCaret,
        }),
        MarkdownDecorations,
        PreserveNewlines,
        SuggestMode.configure({ docState }),
        CommentClickHandler.configure({ onCommentClick }),
        CommentHighlight,
        ActiveCommentHighlight,
      ],
      editorProps: {
        attributes: {
          class: "tiptap",
        },
      },
    },
    [doc, awareness],
  );

  // Update the comment highlight decoration when the prop changes
  useEffect(() => {
    if (!editor) return;
    const range = commentHighlight ?? null;
    const prev = prevHighlightRef.current;
    if (range?.from === prev?.from && range?.to === prev?.to) return;
    prevHighlightRef.current = range;
    const tr = editor.state.tr.setMeta(commentHighlightKey, range);
    editor.view.dispatch(tr);
  }, [editor, commentHighlight]);

  // Update the active comment highlight when the prop changes
  useEffect(() => {
    if (!editor) return;
    const range = activeCommentRange ?? null;
    const prev = prevActiveRangeRef.current;
    if (range?.from === prev?.from && range?.to === prev?.to) return;
    prevActiveRangeRef.current = range;
    const tr = editor.state.tr.setMeta(activeCommentHighlightKey, range);
    editor.view.dispatch(tr);
  }, [editor, activeCommentRange]);

  // Update clean view state when prop changes
  useEffect(() => {
    if (!editor) return;
    const isClean = cleanView ?? false;
    if (isClean === prevCleanViewRef.current) return;
    prevCleanViewRef.current = isClean;
    const tr = editor.state.tr.setMeta(cleanViewKey, isClean);
    editor.view.dispatch(tr);
  }, [editor, cleanView]);

  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  const handleClick = useCallback(() => {
    if (editor && !editor.isFocused) {
      editor.commands.focus("end");
    }
  }, [editor]);

  if (!editor) {
    return null;
  }

  return (
    <>
      <div
        className={`min-h-full cursor-text ${hidden ? "hidden" : ""} ${cleanView ? "clean-view" : ""}`}
        onClick={handleClick}
      >
        <EditorContent editor={editor} />
      </div>
      {onNewComment && onResolveAtCursor && onDeleteAtCursor && (
        <BubbleToolbar
          editor={editor}
          onNewComment={onNewComment}
          onResolveAtCursor={onResolveAtCursor}
          onDeleteAtCursor={onDeleteAtCursor}
        />
      )}
    </>
  );
}
