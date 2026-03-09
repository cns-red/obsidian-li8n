/** Frontmatter language override resolution for markdown files. */

import { MarkdownView, WorkspaceLeaf } from "obsidian";

export function resolveFrontmatterLanguage(
  leaf: WorkspaceLeaf,
  getFrontmatterLang: (view: MarkdownView) => string | undefined,
  knownLanguages: string[]
): { view: MarkdownView; lang: string } | null {
  const view = leaf.view;
  if (!(view instanceof MarkdownView) || !view.file) return null;

  const lang = getFrontmatterLang(view);
  if (!lang) return null;
  if (lang !== "ALL" && !knownLanguages.includes(lang)) return null;
  return { view, lang };
}
