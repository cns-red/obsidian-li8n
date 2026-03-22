/** Outline panel filtering and language-selector bar injection. */

import { WorkspaceLeaf } from "obsidian";
import { langMatch, parseLangBlocks } from "../markdownProcessor";
import type { MultilingualNotesSettings } from "../settings";

type HeadingInfo = { heading: string; position: { start: { line: number } } };

export function applyOutlineFilter(
  outlineLeaves: WorkspaceLeaf[],
  headings: HeadingInfo[],
  source: string,
  active: string,
  defaultLanguage: string,
): void {
  const blocks = parseLangBlocks(source);

  // Pre-compute visibility for each heading by checking which block it falls in.
  // Headings outside all blocks but after the first block opening are treated
  // as default-language content (matching the reading-mode logic).
  const firstBlockStart = blocks.length > 0 ? blocks[0].openLine : -1;

  const visible: boolean[] = headings.map((h) => {
    const line = h.position.start.line;
    if (blocks.length === 0) return langMatch(defaultLanguage, active);
    for (const block of blocks) {
      if (line > block.openLine && (block.closeLine < 0 || line < block.closeLine)) {
        return langMatch(block.langCode, active);
      }
    }
    // Heading is outside all blocks.
    // Before the first block → always visible (frontmatter area).
    if (line < firstBlockStart) return true;
    // After the first block → treat as default-language content.
    if (active === "ALL") return true;
    return active.toLowerCase() === defaultLanguage.toLowerCase();
  });

  for (const leaf of outlineLeaves) {
    const items = Array.from(
      leaf.view.containerEl.querySelectorAll<HTMLElement>(".tree-item"),
    );

    if (items.length === headings.length) {
      // Fast path: counts match — direct index mapping.
      items.forEach((item, i) => {
        item.toggleClass("ml-outline-hidden", !visible[i]);
      });
    } else {
      // Fallback: counts differ (Obsidian may insert non-heading tree items
      // or exclude some headings).  Match sequentially by heading text.
      let hIdx = 0;
      for (const item of items) {
        if (hIdx >= headings.length) break;
        const text =
          item.querySelector(".tree-item-inner")?.textContent?.trim() ?? "";
        if (text === headings[hIdx].heading.trim()) {
          item.toggleClass("ml-outline-hidden", !visible[hIdx]);
          hIdx++;
        }
      }
    }
  }
}

export function ensureOutlineControl(
  outlineLeaves: WorkspaceLeaf[],
  settings: MultilingualNotesSettings,
  onSwitch: (code: string) => void,
  activeLanguage: string,
  presentCodes?: Set<string>,
): void {
  for (const leaf of outlineLeaves) {
    const containerEl = leaf.view.containerEl;

    containerEl.querySelector(".ml-outline-lang-bar")?.remove();

    if (presentCodes && presentCodes.size === 0) continue;

    const bar = document.createElement("div");
    bar.className = "ml-outline-lang-bar";

    const active = activeLanguage;

    if (!presentCodes || presentCodes.size > 1) {
      bar.appendChild(createOutlinePill("ALL", "ALL", active === "ALL", onSwitch));
    }

    const codesToRender = presentCodes
      ? settings.languages.filter(l => Array.from(presentCodes).some(pc => pc.toLowerCase() === l.code.toLowerCase()))
      : settings.languages;

    for (const lang of codesToRender) {
      bar.appendChild(
        createOutlinePill(lang.code, lang.label, active.toLowerCase() === lang.code.toLowerCase(), onSwitch),
      );
    }

    const viewContent = containerEl.querySelector<HTMLElement>(".view-content");
    if (viewContent) {
      viewContent.before(bar);
    } else {
      containerEl.prepend(bar);
    }
  }
}

function createOutlinePill(
  code: string,
  label: string,
  isActive: boolean,
  onSwitch: (code: string) => void,
): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "ml-outline-pill" + (isActive ? " ml-outline-pill--active" : "");
  pill.textContent = label;
  pill.setAttribute("data-lang", code);
  pill.addEventListener("click", () => onSwitch(code));
  return pill;
}
