/**
 * Shared language-block syntax helpers used by both reading-mode and editor-mode.
 * Keep this file as the single source of truth for marker parsing.
 */

/** Open-marker patterns. Capture group 1 contains one or more language codes. */
const OPEN_PATTERNS: RegExp[] = [
  /^:::lang\s+([\w-]+(?:\s+[\w-]+)*)\s*$/,
  /^\{%-?\s*i8n\s+([\w-]+(?:\s+[\w-]+)*)\s*-?%\}$/i,
  /^\[\/\/\]:\s*#\s*\(lang\s+([\w-]+(?:\s+[\w-]+)*)\)\s*$/i,
  /^%%\s*lang\s+([\w-]+(?:\s+[\w-]+)*)\s*%%$/i,
];

/** Close-marker patterns (accept canonical and legacy variants). */
const CLOSE_PATTERNS: RegExp[] = [
  /^:::\s*$/,
  /^\{%-?\s*endi8n\s*-?%\}$/i,
  /^\{%-?\s*endlang\s*-?%\}$/i,
  /^\{%-?\s*end\s*-?%\}$/i,
  /^\[\/\/\]:\s*#\s*\(\s*endlang\s*\)\s*$/i,
  /^\[\/\/\]:\s*#\s*\(\s*\)\s*$/i,
  /^\[\/\/\]:\s*#\s*\(\s*:::\s*\)\s*$/i,
  /^%%\s*endlang\s*%%$/i,
  /^%%\s*end\s*%%$/i,
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

/**
 * Case-insensitive language matching.
 * Supports space-separated marker codes like "en zh-CN".
 */
export function langMatch(blockLang: string, active: string): boolean {
  const activeNorm = active.trim().toLowerCase();
  if (activeNorm === "all") return true;

  return blockLang
    .split(/\s+/)
    .map((code) => code.trim().toLowerCase())
    .filter((code) => code.length > 0)
    .some((code) => code === activeNorm);
}
