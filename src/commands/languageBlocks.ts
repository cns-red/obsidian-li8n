/** Language-block insertion helpers used by command callbacks. */

import { Editor } from "obsidian";
import { buildCommentLangBlock } from "../syntax";

export function getInsertionLanguageCode(activeLanguage: string, fallback: string): string {
  if (activeLanguage !== "ALL") return activeLanguage;
  return fallback;
}

export function insertLangBlock(editor: Editor, langCode: string): void {
  const cursor = editor.getCursor();
  editor.replaceRange(buildCommentLangBlock(langCode), cursor);
  editor.setCursor({ line: cursor.line + 1, ch: 0 });
}

export function wrapSelectionInLangBlock(editor: Editor, langCode: string): boolean {
  const selection = editor.getSelection();
  if (!selection) return false;
  editor.replaceSelection(buildCommentLangBlock(langCode, selection));
  return true;
}

export function insertLangBlockForLanguage(editor: Editor, langCode: string): void {
  const lastLine = editor.lastLine();
  const lastLineContent = editor.getLine(lastLine);
  const leadingBreak = lastLineContent.trim() === "" ? "" : "\n";
  const snippet = `${leadingBreak}\n${buildCommentLangBlock(langCode)}`;
  const endPos = { line: lastLine, ch: lastLineContent.length };
  editor.setCursor(endPos);
  editor.replaceRange(snippet, endPos);
  const contentLine = lastLine + (lastLineContent.trim() === "" ? 2 : 3);
  editor.setCursor({ line: contentLine, ch: 0 });
  editor.scrollIntoView(
    { from: { line: contentLine, ch: 0 }, to: { line: contentLine, ch: 0 } },
    true
  );
}
