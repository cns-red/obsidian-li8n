/**
 * Reading-mode post-processor.
 *
 * Obsidian invokes post-processors per rendered element, not once per file.
 * We therefore parse the full source via ctx.getSectionInfo(el) and decide
 * per element whether to show or hide it for the active language.
 */


import { MarkdownPostProcessorContext } from "obsidian";
import type MultilingualNotesPlugin from "../main";
import { isLanguageBlockClose, langCodeIncludes, matchLanguageBlockOpen } from "./syntax";

// ── Marker parsing uses shared helpers in src/syntax.ts ────────────────

// ── Internal data ────────────────────────────────────────────────────────────

export interface LangBlock {
  langCode: string;
  /** 0-based line number of the open marker in the source. */
  openLine: number;
  /** Whether the open marker renders visibly. */
  openVisible: boolean;
  /** 0-based line number of the close marker (-1 if the block is never closed). */
  closeLine: number;
  /** Whether the close marker renders visibly. */
  closeVisible: boolean;
}

function isVisibleMarkerLine(line: string): boolean {
  const text = line.trim();
  // Obsidian comment and markdown link-reference hacks are not rendered.
  if (/^\[\/\/\]:\s*#\s*\(/.test(text)) return false;
  if (/^%%.*%%$/.test(text)) return false;
  return true;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/**
 * Maps  "sourcePath|sourceLength"  →  parsed blocks for that note.
 * Using source length as a cheap change-detector.
 * Also cleared whenever the user switches language.
 */
const blockCache = new Map<string, LangBlock[]>();

/** Called from main.ts whenever the active language changes. */
export function clearBlockCache(): void {
  blockCache.clear();
}

// ── Language code helpers ─────────────────────────────────────────────────────

/**
 * Case-insensitive comparison for language codes.
 * "zh-CN", "zh-cn", "ZH-CN" all match each other.
 * "zh-CN en" space style supports multiple languages, indicating that all multi-language versions are rendered from it.
 * This is critical: notes may use :::lang zh-cn while settings store "zh-CN".
 */
export function langMatch(blockLang: string, active: string): boolean {
  if (active === "ALL") return true;
  return langCodeIncludes(blockLang, active);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export function parseLangBlocks(source: string): LangBlock[] {
  const lines = source.split("\n");
  const blocks: LangBlock[] = [];
  let openBlock: { langCode: string; openLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (openBlock === null) {
      const code = matchLanguageBlockOpen(line);
      if (code !== null) {
        openBlock = { langCode: code, openLine: i };
      }
    } else {
      if (isLanguageBlockClose(line)) {
        blocks.push({
          langCode: openBlock.langCode,
          openLine: openBlock.openLine,
          closeLine: i,
          openVisible: isVisibleMarkerLine(lines[openBlock.openLine]),
          closeVisible: isVisibleMarkerLine(line),
        });
        openBlock = null;
      }
    }
  }

  if (openBlock) {
    blocks.push({
      langCode: openBlock.langCode,
      openLine: openBlock.openLine,
      openVisible: isVisibleMarkerLine(lines[openBlock.openLine]),
      closeVisible: true,
      closeLine: -1,
    });
  }

  return blocks;
}

// ── Post-processor ────────────────────────────────────────────────────────────

export function registerReadingModeProcessor(plugin: MultilingualNotesPlugin): void {
  plugin.registerMarkdownPostProcessor(
    (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      // getSectionInfo returns the FULL note source plus the line range of
      // this specific rendered element.
      const info = ctx.getSectionInfo(el);
      if (!info) return; // Can't determine position → leave untouched.

      const { text: source, lineStart, lineEnd } = info;
      const active      = plugin.settings.activeLanguage;
      const defaultLang = plugin.settings.defaultLanguage;
      const showBadges  = plugin.settings.showLangBadges;

      // Parse (cached) all lang blocks from the full source.
      const cacheKey = `${ctx.sourcePath}|${source.length}`;
      let blocks = blockCache.get(cacheKey);
      if (!blocks) {
        blocks = parseLangBlocks(source);
        blockCache.set(cacheKey, blocks);
      }

      // ── Feature 3: no markers → whole note is the default language ─────────
      if (blocks.length === 0) {
        if (active !== "ALL" && !langMatch(active, defaultLang)) {
          el.style.display = "none";
        } else {
          // Reset stale display:none from a previous language/mode state.
          el.style.display = "";
        }
        return;
      }

      // ── Find which block (if any) this element belongs to ─────────────────
      for (const block of blocks) {

        // ① This element IS the open-fence line.
        if (lineStart === block.openLine) {
          if (!block.openVisible) return; // already hidden by Obsidian

          const isActive = active === "ALL" || langMatch(block.langCode, active);

          // Guard merged paragraph nodes so marker cleanup never removes real content.
          // Side effect: merged marker+content nodes are toggled as one element.
          if (lineEnd > block.openLine) {
            el.style.display = isActive ? "" : "none";
            return;
          }

          // Normal case: single-line fence element.
          if (!isActive) {
            el.style.display = "none";
          } else if (showBadges) {
            // Reset stale display:none, then replace raw fence with a badge.
            el.style.display = "";
            el.innerHTML = "";
            el.appendChild(createBadge(block.langCode, plugin));
          } else {
            el.style.display = "none"; // hide raw fence syntax even when active
          }
          return;
        }

        // ② This element IS the close-fence line.
        if (block.closeLine >= 0 && lineStart === block.closeLine) {
          if (block.closeVisible) el.style.display = "none";
          return;
        }

        // ③ This element is INSIDE the block (between open and close).
        const afterOpen   = lineStart > block.openLine;
        const beforeClose = block.closeLine < 0 || lineStart < block.closeLine;
        if (afterOpen && beforeClose) {
          const isActive = active === "ALL" || langMatch(block.langCode, active);
          if (!isActive) {
            el.style.display = "none";
          } else {
            el.style.display = "";

            if (block.closeLine >= 0 && lineEnd >= block.closeLine) {
              removeCloseMarkerFromElement(el);
            }
          }
          return;
        }
      }

      // Element is outside every block — ensure it is visible.
      el.style.display = "";
    },
    // Priority 100 — run after most other processors.
    100
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Remove rendered close-marker text from mixed-content elements.
 * Handles paragraphs, blockquotes, headings, list items, and table cells.
 */
function removeCloseMarkerFromElement(el: HTMLElement): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const toRemove: Node[] = [];

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim() ?? "";
    if (isLanguageBlockClose(text)) {
      toRemove.push(node);
    }
  }

  for (const node of toRemove) {
    const parent = node.parentElement;
    if (!parent) continue;

    const siblings = Array.from(parent.childNodes).filter(
        n => n !== node && n.textContent?.trim() !== ""
    );
    if (siblings.length === 0) {
      parent.style.display = "none";
    } else {
      node.parentNode?.removeChild(node);
    }
  }

  // Hide the wrapper if removing the marker leaves no visible text.
  if (el.textContent?.trim() === "") {
    el.style.display = "none";
  }
}


function createBadge(langCode: string, plugin: MultilingualNotesPlugin): HTMLElement {
  // Case-insensitive lookup so "zh-cn" finds the entry stored as "zh-CN"
  const lang  = plugin.settings.languages.find((l) => langMatch(l.code, langCode));
  const label = lang ? lang.label : langCode;
  const badge = document.createElement("span");
  badge.className = "ml-lang-badge";
  badge.textContent = label;
  badge.setAttribute("data-lang", langCode);
  return badge;
}
