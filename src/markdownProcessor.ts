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

  // Exact character offsets for text injection/extraction:
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
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
  let openBlock: { langCode: string; openLine: number; start: number; innerStart: number } | null = null;

  let currentOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLengthWithNewline = line.length + (i < lines.length - 1 ? 1 : 0);

    if (openBlock === null) {
      const code = matchLanguageBlockOpen(line);
      if (code !== null) {
        openBlock = {
          langCode: code,
          openLine: i,
          start: currentOffset,
          innerStart: currentOffset + lineLengthWithNewline
        };
      }
    } else {
      if (isLanguageBlockClose(line)) {
        blocks.push({
          langCode: openBlock.langCode,
          openLine: openBlock.openLine,
          closeLine: i,
          openVisible: isVisibleMarkerLine(lines[openBlock.openLine]),
          closeVisible: isVisibleMarkerLine(line),
          start: openBlock.start,
          innerStart: openBlock.innerStart,
          innerEnd: currentOffset,
          end: currentOffset + lineLengthWithNewline
        });
        openBlock = null;
      }
    }
    currentOffset += lineLengthWithNewline;
  }

  if (openBlock) {
    blocks.push({
      langCode: openBlock.langCode,
      openLine: openBlock.openLine,
      openVisible: isVisibleMarkerLine(lines[openBlock.openLine]),
      closeVisible: true,
      closeLine: -1,
      start: openBlock.start,
      innerStart: openBlock.innerStart,
      innerEnd: source.length,
      end: source.length
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
      const active = plugin.getEffectiveLanguageForPath(ctx.sourcePath);
      const defaultLang = plugin.settings.defaultLanguage;
      const showLangHeader = plugin.settings.showLangHeader;

      // Parse (cached) all lang blocks from the full source.
      // Important: `ctx.getSectionInfo(el).text` is section-scoped, not always the whole
      // document text. Different sections can have identical lengths, so source-length-only
      // keys will collide and reuse parsed blocks from the wrong section. That can hide
      // unrelated content after language switches ("half the note disappears").
      const cacheKey = `${ctx.sourcePath}|${lineStart}|${lineEnd}|${source.length}`;
      let blocks = blockCache.get(cacheKey);
      if (!blocks) {
        blocks = parseLangBlocks(source);
        blockCache.set(cacheKey, blocks);
      }

      // ── Language header: inject once at top of sizer for multilingual notes ──
      if (blocks.length > 0 && showLangHeader) {
        ensureLangHeader(el, blocks, plugin, active);
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

          // Normal case: single-line fence element — always hide the raw marker.
          // The language header at the top of the note handles the language indicator.
          el.style.display = "none";
          return;
        }

        // ② This element IS the close-fence line.
        if (block.closeLine >= 0 && lineStart === block.closeLine) {
          if (block.closeVisible) el.style.display = "none";
          return;
        }

        // ③ This element is INSIDE the block (between open and close).
        const afterOpen = lineStart > block.openLine;
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



/**
 * Inject a language-selector bar at the top of the note's sizer container.
 * Uses a data attribute to guarantee it is injected only once per render pass.
 */
function ensureLangHeader(
  el: HTMLElement,
  blocks: LangBlock[],
  plugin: MultilingualNotesPlugin,
  active: string,
): void {
  const owner = el.closest(".markdown-preview-sizer") ?? el.parentElement;
  if (!owner) return;

  // Collect unique language codes present in this document.
  const langCodes = new Set<string>();
  for (const block of blocks) {
    block.langCode.split(/\s+/).filter(Boolean).forEach((c) => langCodes.add(c.toLowerCase()));
  }

  const existing = owner.querySelector(".ml-lang-header");
  if (langCodes.size === 0) {
    existing?.remove();
    return;
  }


  if (existing) {
    // Check if languages match. If so, just update active states.
    const pills = Array.from(existing.querySelectorAll(".ml-lang-pill"));
    const existingCodes = new Set(pills.map(p => p.getAttribute("data-lang")).filter(Boolean) as string[]);

    const expectedCodes = new Set(langCodes);
    if (langCodes.size > 1) expectedCodes.add("ALL");

    let match = existingCodes.size === expectedCodes.size;
    if (match) {
      for (const code of expectedCodes) {
        if (!existingCodes.has(code)) {
          match = false;
          break;
        }
      }
    }

    if (match) {
      // Just update active highlights
      pills.forEach((pill) => {
        const code = pill.getAttribute("data-lang");
        if (!code) return;
        const isActive = (active === "ALL") ? code === "ALL" : active.toLowerCase() === code.toLowerCase();
        if (isActive) {
          pill.classList.add("ml-lang-pill--active");
        } else {
          pill.classList.remove("ml-lang-pill--active");
        }
      });
      positionHeader(existing as HTMLElement, owner);
      return;
    } else {
      existing.remove();
    }
  }

  const header = document.createElement("div");
  header.className = "ml-lang-header";

  // ALL pill — always present when there are multiple language codes.
  if (langCodes.size > 1) {
    header.appendChild(
      createHeaderPill("ALL", "ALL", active === "ALL", (code) => plugin.setLanguageForActiveFile(code)),
    );
  }

  // One pill per language found in the document.
  for (const code of langCodes) {
    const lang = plugin.settings.languages.find(
      (l) => l.code.toLowerCase() === code.toLowerCase(),
    );
    const label = lang ? lang.label : code;
    const isActive = active !== "ALL" && active.toLowerCase() === code.toLowerCase();
    header.appendChild(
      createHeaderPill(code, label, isActive, (c) => plugin.setLanguageForActiveFile(c)),
    );
  }

  positionHeader(header, owner);
}

function positionHeader(header: HTMLElement, owner: Element) {
  // Insert right below frontmatter or title if possible
  const frontmatter = owner.querySelector(".frontmatter-container, .metadata-container");
  if (frontmatter) {
    const wrap = frontmatter.closest(".markdown-preview-section");
    const target = (wrap && wrap.parentElement === owner) ? wrap : frontmatter;
    if (header.previousElementSibling !== target) {
      target.after(header);
    }
  } else {
    const title = owner.querySelector(".mod-header, .inline-title");
    if (title) {
      const wrap = title.closest(".markdown-preview-section");
      const target = (wrap && wrap.parentElement === owner) ? wrap : title;
      if (header.previousElementSibling !== target) {
        target.after(header);
      }
    } else {
      if (owner.firstElementChild !== header) {
        owner.prepend(header);
      }
    }
  }
}

function createHeaderPill(
  code: string,
  label: string,
  isActive: boolean,
  onSwitch: (code: string) => void,
): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "ml-lang-pill" + (isActive ? " ml-lang-pill--active" : "");
  pill.textContent = label;
  pill.setAttribute("data-lang", code);
  pill.addEventListener("click", () => onSwitch(code));
  return pill;
}
