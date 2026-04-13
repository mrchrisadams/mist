import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";

/* ---------- ProseMirror plugin ---------- */

interface ModeSource {
  get: (key: string) => string | undefined;
}

const pluginKey = new PluginKey("suggestMode");

/**
 * Check if the character before `pos` has a specific mark.
 * Returns the mark if found, null otherwise.
 */
function markBefore(
  state: import("@tiptap/pm/state").EditorState,
  pos: number,
  markName: string,
) {
  if (pos <= 0) return null;
  const node = state.doc.nodeAt(pos - 1);
  if (!node) return null;
  return node.marks.find((m) => m.type.name === markName) ?? null;
}

/**
 * Check if the entire range [from, to) is within a single run of the given mark.
 */
function rangeHasOnlyMark(
  state: import("@tiptap/pm/state").EditorState,
  from: number,
  to: number,
  markName: string,
): boolean {
  if (from >= to) return false;
  let allMarked = true;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!allMarked) return false;
    if (node.isText) {
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (start < end) {
        const hasMark = node.marks.some((m) => m.type.name === markName);
        if (!hasMark) allMarked = false;
      }
    }
  });
  return allMarked;
}

export function suggestModePlugin(docState: ModeSource): Plugin {
  return new Plugin({
    key: pluginKey,
    props: {
      handleTextInput(view, from, to, text) {
        const mode = docState.get("mode");
        if (mode !== "suggest") return false;

        const { state, dispatch } = view;
        const additionType = state.schema.marks.criticAddition;
        const deletionType = state.schema.marks.criticDeletion;
        if (!additionType || !deletionType) return false;

        if (from === to) {
          // Insertion: always apply criticAddition mark explicitly
          // (inclusive is false so PM won't extend marks at boundaries)
          const tr = state.tr;
          tr.insertText(text, from);
          tr.addMark(from, from + text.length, additionType.create());
          tr.setSelection(TextSelection.near(tr.doc.resolve(from + text.length)));
          dispatch(tr);
          return true;
        }

        // Selection replacement inside an addition — replace and keep mark
        if (rangeHasOnlyMark(state, from, to, "criticAddition")) {
          const tr = state.tr;
          tr.insertText(text, from, to);
          tr.addMark(from, from + text.length, additionType.create());
          tr.setSelection(TextSelection.near(tr.doc.resolve(from + text.length)));
          dispatch(tr);
          return true;
        }

        // Selection replacement: mark old as deleted, insert new as added
        const tr = state.tr;
        tr.addMark(from, to, deletionType.create());
        tr.insertText(text, to);
        tr.addMark(to, to + text.length, additionType.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(to + text.length)));
        dispatch(tr);
        return true;
      },

      handlePaste(view, _event, slice) {
        const mode = docState.get("mode");
        if (mode !== "suggest") return false;

        const { state, dispatch } = view;
        const additionType = state.schema.marks.criticAddition;
        const deletionType = state.schema.marks.criticDeletion;
        if (!additionType || !deletionType) return false;

        const { from, to } = state.selection;
        const tr = state.tr;

        if (from !== to) {
          if (rangeHasOnlyMark(state, from, to, "criticAddition")) {
            // Replacing inside an addition — delete the old text
            tr.delete(from, to);
          } else {
            // Mark selected text as deleted
            tr.addMark(from, to, deletionType.create());
          }
        }

        // Insert point: after deletions (which stay in place), or at cursor
        const insertAt = from !== to && !rangeHasOnlyMark(state, from, to, "criticAddition") ? to : from;

        // Insert the pasted slice
        tr.replaceRange(insertAt, insertAt, slice);

        // The inserted content spans from insertAt to the new cursor pos.
        // Calculate the end of inserted content using the slice size.
        const insertEnd = insertAt + slice.content.size - slice.openStart - slice.openEnd;

        // Apply criticAddition mark to all text in the inserted range
        tr.addMark(insertAt, insertEnd, additionType.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(insertEnd)));

        dispatch(tr);
        return true;
      },

      handleKeyDown(view, event) {
        const mode = docState.get("mode");
        if (mode !== "suggest") return false;

        if (event.key !== "Backspace") return false;

        const { state, dispatch } = view;
        const { from, to, empty } = state.selection;
        const additionType = state.schema.marks.criticAddition;
        const deletionType = state.schema.marks.criticDeletion;
        if (!additionType || !deletionType) return false;

        if (!empty) {
          // Non-empty selection
          if (rangeHasOnlyMark(state, from, to, "criticAddition")) {
            return false; // Normal delete inside addition (shrinks it)
          }
          if (rangeHasOnlyMark(state, from, to, "criticDeletion")) {
            return true; // No-op inside deletion
          }

          // Mark selection as deleted
          const tr = state.tr;
          tr.addMark(from, to, deletionType.create());
          tr.setSelection(TextSelection.near(tr.doc.resolve(from)));
          dispatch(tr);
          return true;
        }

        // Single character backspace
        if (from <= 1) return false; // At start of doc content

        const $from = state.doc.resolve(from);
        if ($from.parentOffset <= 0) return false; // At start of paragraph

        // Inside addition: normal backspace (shrink insertion)
        if (markBefore(state, from, "criticAddition")) {
          return false;
        }

        // Inside deletion: no-op (prevent editing deletions)
        if (markBefore(state, from, "criticDeletion")) {
          return true;
        }

        // Normal character: apply deletion mark to the character before cursor
        const tr = state.tr;
        tr.addMark(from - 1, from, deletionType.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(from - 1)));
        dispatch(tr);
        return true;
      },
    },
  });
}
