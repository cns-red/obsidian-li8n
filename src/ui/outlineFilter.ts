/** Outline filtering utilities to mirror active-language visibility. */

import { WorkspaceLeaf } from "obsidian";
import { langMatch, parseLangBlocks } from "../markdownProcessor";

type HeadingInfo = { heading: string; position: { start: { line: number } } };

export function applyOutlineFilter(
  outlineLeaves: WorkspaceLeaf[],
  headings: HeadingInfo[],
  source: string,
  active: string,
  defaultLanguage: string,
): void {
  const blocks = parseLangBlocks(source);
  const visible: boolean[] = headings.map((h) => {
    const line = h.position.start.line;
    if (blocks.length === 0) return langMatch(active, defaultLanguage);
    for (const block of blocks) {
      if (line > block.openLine && (block.closeLine < 0 || line < block.closeLine)) {
        return langMatch(block.langCode, active);
      }
    }
    return true;
  });

  for (const leaf of outlineLeaves) {
    const items = Array.from(leaf.view.containerEl.querySelectorAll<HTMLElement>(".tree-item"));
    items.forEach((item, i) => {
      item.style.display = i < visible.length && !visible[i] ? "none" : "";
    });
  }
}
