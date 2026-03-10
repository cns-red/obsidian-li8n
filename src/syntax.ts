/**
 * Shared language-block syntax helpers used by parser and editor commands.
 * Keep this module as the single source of truth for markers and templates.
 */

export const COMMENT_OPEN_PREFIX = "[//]: # (li8n ";
export const COMMENT_CLOSE_MARKER = "[//]: # (endli8n)";

/** Open-marker patterns. Capture group 1 contains one or more language codes. */
export const OPEN_PATTERNS: RegExp[] = [
  /^:::li8n\s+([\w-]+(?:\s+[\w-]+)*)\s*$/,
  /^\{%-?\s*li8n\s+([\w-]+(?:\s+[\w-]+)*)\s*-?%\}$/i,
  /^\[\/\/\]:\s*#\s*\(li8n\s+([\w-]+(?:\s+[\w-]+)*)\)\s*$/i,
  /^%%\s*li8n\s+([\w-]+(?:\s+[\w-]+)*)\s*%%$/i,
];

/** Close-marker patterns (canonical + legacy aliases). */
export const CLOSE_PATTERNS: RegExp[] = [
  /^:::\s*$/,
  /^\{%-?\s*endli8n\s*-?%\}$/i,
  /^\[\/\/\]:\s*#\s*\(\s*endli8n\s*\)\s*$/i,
  /^\[\/\/\]:\s*#\s*\(\s*:::\s*\)\s*$/i,
  /^%%\s*endli8n\s*%%$/i,
  /^%%\s*:::\s*%%$/i,
];

export function matchLanguageBlockOpen(line: string): string | null {
  const text = line.trim();
  for (const re of OPEN_PATTERNS) {
    const match = re.exec(text);
    if (match) return match[1].trim();
  }
  return null;
}

export function isLanguageBlockClose(line: string): boolean {
  const text = line.trim();
  return CLOSE_PATTERNS.some((re) => re.test(text));
}

export function buildCommentLangBlock(langCode: string, body = ""): string {
  const content = body.length > 0 ? `\n${body}\n` : "\n\n";
  return `${COMMENT_OPEN_PREFIX}${langCode})${content}\n${COMMENT_CLOSE_MARKER}`;
}

export function langCodeIncludes(blockLang: string, active: string): boolean {
  const activeNorm = active.toLowerCase();
  return blockLang.split(/\s+/).some((code) => code.toLowerCase() === activeNorm);
}
