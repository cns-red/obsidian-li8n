/** Frontmatter language override resolution for markdown files. */

import { MarkdownView, WorkspaceLeaf } from "obsidian";

export function resolveFrontmatterLanguage(
  leaf: WorkspaceLeaf,
  getFrontmatterLang: (view: MarkdownView) => string | undefined,
  knownLanguages: string[]
): { view: MarkdownView; lang: string } | null {
  const view = leaf.view;
  if (!(view instanceof MarkdownView) || !view.file) return null;

  const rawLang = getFrontmatterLang(view);
  if (!rawLang) return null;
  if (rawLang === "ALL") return { view, lang: "ALL" };

  const matched = knownLanguages.find((code) => code.toLowerCase() === rawLang.toLowerCase());
  if (!matched) return null;
  return { view, lang: matched };
}
