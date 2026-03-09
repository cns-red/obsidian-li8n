/**
 * editorExtension.ts
 *
 * CodeMirror 6 extension that hides (or dims) non-active language blocks
 * in Obsidian's Live Preview / editing mode.
 *
 * Supported open-block syntax (same as markdownProcessor):
 *   :::lang zh-cn
 *   {% i8n zh-cn %}
 *   [//]: # (lang zh-cn)
 *   %% lang zh-cn %%
 *
 * Supported close-block syntax:
 *   :::
 *   {% endi8n %}
 *   [//]: # (endlang)
 *   %% endlang %%
 */

import {
  EditorState,
  Extension,
  StateField,
  StateEffect,
  Transaction,
  Range,
  RangeSet,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { isLanguageBlockClose, langCodeIncludes, matchLanguageBlockOpen } from "./syntax";

// ── Public API ────────────────────────────────────────────────────────────────

/** Effect dispatched to the editor when the active language changes. */
export const setActiveLangEffect = StateEffect.define<string>();

/** Settings snapshot passed into the extension factory. */
export interface LangExtensionConfig {
  getActiveLanguage: () => string;
  getHideMode: () => boolean;
}

/** Build and return the array of CM6 extensions. */
export function buildEditorExtension(config: LangExtensionConfig): Extension[] {
  return [langDecorationsField(config), hideTheme];
}

// ── Marker parsing is shared in src/syntax.ts ─────────────────────────────

// ── Collapsed widget (placeholder shown when a block is hidden) ───────────────

class HiddenBlockWidget extends WidgetType {
  constructor(private langCode: string, private lineCount: number) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "ml-hidden-block-placeholder";
    el.setAttribute("data-lang", this.langCode);
    el.title = `Hidden language block: ${this.langCode}  (${this.lineCount} lines)`;
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }

  eq(other: HiddenBlockWidget): boolean {
    return other.langCode === this.langCode && other.lineCount === this.lineCount;
  }
}

// ── StateField ────────────────────────────────────────────────────────────────

function langDecorationsField(config: LangExtensionConfig): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create(state: EditorState): DecorationSet {
      return computeDecorations(state, config);
    },

    update(deco: DecorationSet, tr: Transaction): DecorationSet {
      const hasLangEffect = tr.effects.some((e) => e.is(setActiveLangEffect));
      if (tr.docChanged || hasLangEffect) {
        return computeDecorations(tr.state, config);
      }
      return deco.map(tr.changes);
    },

    provide(field) {
      return EditorView.decorations.from(field);
    },
  });
}

// ── Core computation ──────────────────────────────────────────────────────────

function computeDecorations(
  state: EditorState,
  config: LangExtensionConfig
): DecorationSet {
  const active   = config.getActiveLanguage();
  const hideMode = config.getHideMode();

  // hideMode = false means "show everything in editor — no filtering at all".
  // Return an empty decoration set so all lang blocks are fully editable.
  if (!hideMode) {
    return RangeSet.empty;
  }

  const decorations: Range<Decoration>[] = [];
  const doc       = state.doc;
  const lineCount = doc.lines;

  let insideBlock    = false;
  let blockLang      = "";
  let blockStartLine = 0; // 1-based

  for (let ln = 1; ln <= lineCount; ln++) {
    const line = doc.line(ln);
    const text = line.text;

    if (!insideBlock) {
      const langCode = matchLanguageBlockOpen(text);
      if (langCode !== null) {
        insideBlock    = true;
        blockLang      = langCode;
        blockStartLine = ln;
      }
    } else {
      if (isLanguageBlockClose(text)) {
        // Complete block: blockStartLine … ln
        const blockLineCount = ln - blockStartLine + 1;
        // Case-insensitive: "zh-cn" in note matches "zh-CN" in settings
        const isActive = active === "ALL" || langCodeIncludes(blockLang, active);

        if (!isActive) {
          // Always use full-hide when hideMode is true
          applyHideDecorations(
            decorations,
            state,
            blockStartLine,
            ln,
            blockLang,
            blockLineCount,
          );
        }

        insideBlock    = false;
        blockLang      = "";
        blockStartLine = 0;
      }
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return RangeSet.of(decorations);
}

// Collapses a non-active block to a thin placeholder bar in the editor.
function applyHideDecorations(
  out: Range<Decoration>[],
  state: EditorState,
  fromLineno: number,
  toLineno: number,
  langCode: string,
  lineCount: number,
): void {
  const fromLine = state.doc.line(fromLineno);
  const toLine   = state.doc.line(toLineno);
  out.push(
    Decoration.replace({
      widget: new HiddenBlockWidget(langCode, lineCount),
      block: true,
      inclusive: true,
    }).range(fromLine.from, toLine.to)
  );
}

// ── Theme ─────────────────────────────────────────────────────────────────────

const hideTheme = EditorView.baseTheme({
  ".ml-hidden-block-placeholder": {
    display: "inline-block",
    height: "2px",
    width: "100%",
    backgroundColor: "var(--background-modifier-border)",
    borderRadius: "2px",
    cursor: "pointer",
    opacity: "0.4",
  },
  ".ml-dimmed-block": {
    opacity: "0.25",
    filter: "grayscale(80%)",
  },
});
