import { MarkdownPostProcessorContext, MarkdownRenderChild, WorkspaceLeaf } from "obsidian";
import type MultilingualNotesPlugin from "../main";
import { isLanguageBlockClose, langCodeIncludes, matchLanguageBlockOpen } from "./syntax";

// RAF polling queue: Obsidian's virtual scroller generates detached elements before DOM mount.
// Park them here and re-evaluate once they land in the real DOM.
const pendingMountElements = new Set<{ el: HTMLElement, evaluate: () => void }>();
let isMountPolling = false;

// Handler registry: maps each processed element to its evaluateVisibility closure so we can
// directly sweep all in-DOM sections when the active language changes, without relying solely
// on rerender(true) which only re-processes sections currently in the virtual-scroller viewport.
const elementHandlers = new WeakMap<HTMLElement, (active: string) => void>();

// Tracks which .inline-title elements have already had the rename-guard listeners attached,
// so we never add them more than once per element lifetime.
const titlesWithListeners = new WeakSet<HTMLElement>();

/**
 * Re-apply visibility to every previously-registered section element inside `containerEl`.
 * Call this immediately before rerender(true) on language switch so that off-screen DOM
 * sections (outside the virtual-scroller viewport) get the correct state right away.
 *
 * Also eagerly updates elements in `pendingMountElements` — sections that Obsidian's
 * virtual scroller has pre-rendered into a detached fragment but not yet attached to the
 * live DOM.  Without this pass those elements would mount with a stale visibility class
 * (set at post-processor time with the old language) and only be corrected one RAF later,
 * producing the "only part of the block shows / blank then appears" artefact.
 */
export function sweepSectionVisibility(containerEl: Element, active: string): void {
  containerEl.querySelectorAll<HTMLElement>("[data-mi18n]").forEach((el) => {
    const handler = elementHandlers.get(el);
    if (handler) handler(active);
  });

  // Cover elements that are pre-rendered but haven't entered the live DOM yet.
  for (const item of pendingMountElements) {
    const handler = elementHandlers.get(item.el);
    if (handler) handler(active);
  }
}

function pollPendingMounts() {
  if (pendingMountElements.size === 0) {
    isMountPolling = false;
    return;
  }
  for (const item of pendingMountElements) {
    if (document.body.contains(item.el)) {
      item.evaluate();
      pendingMountElements.delete(item);
    }
  }
  requestAnimationFrame(pollPendingMounts);
}

export interface LangBlock {
  langCode: string;
  /** 0-based line index of the open marker. */
  openLine: number;
  openVisible: boolean;
  /** 0-based line index of the close marker; -1 if unclosed. */
  closeLine: number;
  closeVisible: boolean;
  /** Character offsets: start/end span the full block including markers. */
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}

function isVisibleMarkerLine(line: string): boolean {
  const text = line.trim();
  if (/^\[\/\/\]:\s*#\s*\(/.test(text)) return false;
  if (/^%%.*%%$/.test(text)) return false;
  return true;
}

// Block cache: "sourcePath|quickHash(source)" → parsed blocks.
const blockCache = new Map<string, LangBlock[]>();

export function clearBlockCache(): void {
  blockCache.clear();
}

function quickHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  return hash;
}

/** Case-insensitive match; active "ALL" or block tagged "all" both show in every view. */
export function langMatch(blockLang: string, active: string): boolean {
  if (active === "ALL") return true;
  if (langCodeIncludes(blockLang, "all")) return true;
  return langCodeIncludes(blockLang, active);
}

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

export function extractAvailableLanguagesFromBlocks(blocks: LangBlock[], configuredLanguages: { code: string }[]): Set<string> {
  const existing = new Set<string>();
  let hasAll = false;
  for (const block of blocks) {
    block.langCode.split(/\s+/).filter(Boolean).forEach((c) => {
      const lower = c.toLowerCase();
      if (lower === "all") hasAll = true;
      else existing.add(lower);
    });
  }
  if (hasAll) {
    configuredLanguages.forEach((l) => existing.add(l.code.toLowerCase()));
  }
  return existing;
}

export function registerReadingModeProcessor(plugin: MultilingualNotesPlugin): void {
  plugin.registerMarkdownPostProcessor(
    (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      if (!plugin.isFileInScope(ctx.sourcePath)) return;
      const selfFile = plugin.app.vault.getFileByPath(ctx.sourcePath);
      if (selfFile && plugin.app.metadataCache.getFileCache(selfFile)?.frontmatter?.lang_ignore === true) return;
      const info = ctx.getSectionInfo(el);
      if (!info) return;

      const { text: source, lineStart, lineEnd } = info;
      const initialActive = plugin.getLanguageForElement(el, ctx.sourcePath);
      const defaultLang = plugin.settings.defaultLanguage;
      const showLangHeader = plugin.settings.showLangHeader;

      const cacheKey = `${ctx.sourcePath}|${quickHash(source)}`;
      const blocks = blockCache.get(cacheKey) || (() => {
        const parsed = parseLangBlocks(source);
        blockCache.set(cacheKey, parsed);
        return parsed;
      })();

      let evaluateVisibility = (active: string) => {
        el.classList.remove("ml-language-hidden");
      };

      if (blocks.length === 0) {
        evaluateVisibility = (active: string) => {
          if (active !== "ALL" && !langMatch(active, defaultLang)) {
            el.classList.add("ml-language-hidden");
          } else {
            el.classList.remove("ml-language-hidden");
          }
        };
      } else {
        for (const block of blocks) {
          if (lineStart === block.openLine) {
            evaluateVisibility = (active: string) => {
              if (!block.openVisible) return;
              const isActive = active === "ALL" || langMatch(block.langCode, active);
              if (lineEnd > block.openLine) {
                if (isActive) el.classList.remove("ml-language-hidden");
                else el.classList.add("ml-language-hidden");
                return;
              }
              el.classList.add("ml-language-hidden");
            };
            break;
          }

          if (block.closeLine >= 0 && lineStart === block.closeLine) {
            evaluateVisibility = (active: string) => {
              if (block.closeVisible) el.classList.add("ml-language-hidden");
            };
            break;
          }

          const afterOpen = lineStart > block.openLine;
          const beforeClose = block.closeLine < 0 || lineStart < block.closeLine;
          if (afterOpen && beforeClose) {
            evaluateVisibility = (active: string) => {
              const isActive = active === "ALL" || langMatch(block.langCode, active);
              if (!isActive) {
                el.classList.add("ml-language-hidden");
              } else {
                el.classList.remove("ml-language-hidden");
                if (block.closeLine >= 0 && lineEnd >= block.closeLine) {
                  removeCloseMarkerFromElement(el);
                }
              }
            };
            break;
          }
        }
      }

      // Register handler so sweepSectionVisibility can directly update this element
      // when the active language changes (handles off-screen virtual-scroller sections).
      el.dataset.mi18n = "1";
      elementHandlers.set(el, evaluateVisibility);

      evaluateVisibility(initialActive);
      {
        const sizer = el.closest(".markdown-preview-sizer");
        if (sizer) applyInlineTitleOverride(sizer, ctx.sourcePath, initialActive, plugin);
      }
      if (blocks.length > 0 && showLangHeader) {
        ensureLangHeader(el, blocks, plugin, initialActive);
      } else {
        const owner = el.closest(".markdown-preview-sizer");
        owner?.querySelector(".ml-lang-header")?.remove();
      }

      const child = new MarkdownRenderChild(el);
      const queueItem = {
        el,
        evaluate: () => {
          const mountedActive = plugin.getLanguageForElement(el, ctx.sourcePath);
          evaluateVisibility(mountedActive);
          {
            const sizer = el.closest(".markdown-preview-sizer");
            if (sizer) applyInlineTitleOverride(sizer, ctx.sourcePath, mountedActive, plugin);
          }
          if (blocks.length > 0 && showLangHeader) {
            ensureLangHeader(el, blocks, plugin, mountedActive);
          } else {
            const owner = el.closest(".markdown-preview-sizer");
            owner?.querySelector(".ml-lang-header")?.remove();
          }
        }
      };

      child.onload = () => {
        if (document.body.contains(el)) {
          queueItem.evaluate();
        } else {
          pendingMountElements.add(queueItem);
          if (!isMountPolling) {
            isMountPolling = true;
            requestAnimationFrame(pollPendingMounts);
          }
        }
      };

      child.onunload = () => {
        pendingMountElements.delete(queueItem);
        elementHandlers.delete(el);
      };

      ctx.addChild(child);
    },
    100
  );
}

/** Remove rendered close-marker text from mixed-content elements. */
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
      parent.classList.add("ml-language-hidden");
    } else {
      node.parentNode?.removeChild(node);
    }
  }

  if (el.textContent?.trim() === "") {
    el.classList.add("ml-language-hidden");
  }
}

/**
 * Update the `.inline-title` element to reflect the active language.
 *
 * Reads `title` (default language) and `title_<lang>` (other languages) from
 * the note's frontmatter. Only acts when:
 *  - The note has a `lang` field (i.e. it's a multilingual note), AND
 *  - The note has a `title` frontmatter field.
 *
 * The "default language" is the plugin-level `settings.defaultLanguage`,
 * NOT the per-file `lang_view`.  When active is "ALL" the base `title` is used.
 *
 * ### Rename-guard
 * `.inline-title` is a `contenteditable` element.  Obsidian attaches a blur
 * listener that reads its `textContent` and renames the file when the value
 * differs from the current basename.  Because this function overwrites
 * `textContent` with a translated title, any click-then-release on that element
 * would silently rename the file.
 *
 * Strategy (better than a hard lock):
 *  1. Keep `contentEditable="false"` while showing the translated title — prevents
 *     accidental renames from mere clicks.
 *  2. On `mousedown`: restore `textContent` to the real file basename and re-enable
 *     editing.  The user now sees the actual filename and can rename normally.
 *  3. On `blur` (one tick after Obsidian's own handler): re-apply the translated
 *     title so it appears again immediately after the user finishes.
 *
 * We track our ownership with `data-ml-title-override` and use `titlesWithListeners`
 * to attach these handlers exactly once per element lifetime.
 */
export function applyInlineTitleOverride(
  ownerEl: Element,
  sourcePath: string,
  activeLanguage: string,
  plugin: import("../main").default,
): void {
  const titleEl = ownerEl.querySelector<HTMLElement>(".inline-title");
  if (!titleEl) return;

  const file = plugin.app.vault.getFileByPath(sourcePath);
  if (!file) return;

  /**
   * Undo everything this function previously applied, returning the element to
   * Obsidian's full control (editable, showing the real file basename).
   */
  const clearOverride = () => {
    if (titleEl.dataset.mlTitleOverride === "1") {
      delete titleEl.dataset.mlTitleOverride;
      titleEl.contentEditable = "true";
      titleEl.textContent = file.basename;
    }
  };

  if (!plugin.settings.overrideInlineTitle) {
    clearOverride();
    return;
  }

  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const baseTitle = fm?.title as string | undefined;
  if (!baseTitle) {
    clearOverride(); // `title` frontmatter was removed — hand control back
    return;
  }

  const isDefault =
    activeLanguage === "ALL" ||
    activeLanguage.toLowerCase() === plugin.settings.defaultLanguage.toLowerCase();

  const newTitle = isDefault
    ? baseTitle
    : ((fm?.[`title_${activeLanguage}`] as string | undefined) ?? baseTitle);

  if (titleEl.textContent !== newTitle) {
    titleEl.textContent = newTitle;
  }

  // Always keep the current source path on the element so listeners can resolve
  // the right file even when Obsidian reuses the same .inline-title DOM node
  // across navigations within the same leaf (it updates textContent in place
  // rather than recreating the element, which would make closure-captured
  // sourcePath / file values stale for every file after the first).
  titleEl.dataset.mlSourcePath = sourcePath;

  // Attach the rename-guard interaction handlers once per element lifetime.
  if (!titlesWithListeners.has(titleEl)) {
    titlesWithListeners.add(titleEl);

    // mousedown fires before the browser focuses the element, so we can swap
    // the content and re-enable editing before Obsidian sees any input.
    // Read sourcePath from the data attribute — NOT the stale closure variable —
    // so this always reflects the file currently displayed in the element.
    titleEl.addEventListener("mousedown", () => {
      if (titleEl.dataset.mlTitleOverride !== "1") return; // already in native mode
      const currentPath = titleEl.dataset.mlSourcePath;
      const liveFile = currentPath ? plugin.app.vault.getFileByPath(currentPath) : null;
      delete titleEl.dataset.mlTitleOverride;
      titleEl.contentEditable = "true";
      titleEl.textContent = liveFile?.basename ?? "";
    });

    // After blur: wait one tick so Obsidian's own blur handler (which reads
    // textContent and may rename the file) runs first, then re-apply our title.
    // Find ownerEl dynamically so this works even if the sizer was replaced since
    // the listeners were first attached.
    titleEl.addEventListener("blur", () => {
      setTimeout(() => {
        if (!titleEl.isConnected) return;
        const currentPath = titleEl.dataset.mlSourcePath;
        if (!currentPath) return;
        const currentOwner = titleEl.closest(".markdown-preview-sizer");
        if (!currentOwner) return;
        const lang = plugin.getLanguageForElement(titleEl, currentPath);
        applyInlineTitleOverride(currentOwner, currentPath, lang, plugin);
      }, 0);
    });
  }

  // Set / maintain the non-editable lock while our override is active.
  if (titleEl.dataset.mlTitleOverride !== "1") {
    titleEl.dataset.mlTitleOverride = "1";
    titleEl.contentEditable = "false";
  }
}

/** Inject a language-selector pill bar at the top of the preview sizer. */
function ensureLangHeader(
  el: HTMLElement,
  blocks: LangBlock[],
  plugin: MultilingualNotesPlugin,
  active: string,
): void {
  const owner = el.closest(".markdown-preview-sizer");
  if (!owner) return; // detached fragment — onload will retry

  const langCodes = extractAvailableLanguagesFromBlocks(blocks, plugin.settings.languages);

  const existing = owner.querySelector(".ml-lang-header");
  if (langCodes.size === 0) {
    existing?.remove();
    return;
  }

  if (existing) {
    const pills = Array.from(existing.querySelectorAll(".ml-lang-pill"));
    const existingCodes = new Set(pills.map(p => p.getAttribute("data-lang")).filter(Boolean) as string[]);

    const expectedCodes = new Set(langCodes);
    if (langCodes.size > 1) expectedCodes.add("ALL");

    let match = existingCodes.size === expectedCodes.size;
    if (match) {
      for (const code of expectedCodes) {
        if (!existingCodes.has(code)) { match = false; break; }
      }
    }

    if (match) {
      pills.forEach((pill) => {
        const code = pill.getAttribute("data-lang");
        if (!code) return;
        const isActive = (active === "ALL") ? code === "ALL" : active.toLowerCase() === code.toLowerCase();
        pill.classList.toggle("ml-lang-pill--active", isActive);
      });
      return;
    } else {
      existing.remove();
    }
  }

  const header = document.createElement("div");
  header.className = "ml-lang-header";

  const onSwitch = (code: string) => {
    let targetLeaf: WorkspaceLeaf | null = null;
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!targetLeaf && leaf.view.containerEl?.contains(owner)) {
        targetLeaf = leaf;
      }
    });

    if (targetLeaf) {
      plugin.setLanguageForSpecificLeaf(targetLeaf, code);
    } else {
      plugin.setLanguageForActiveLeaf(code);
    }
  };

  if (langCodes.size > 1) {
    header.appendChild(createHeaderPill("ALL", "ALL", active === "ALL", onSwitch));
  }

  for (const code of langCodes) {
    const lang = plugin.settings.languages.find(
      (l) => l.code.toLowerCase() === code.toLowerCase(),
    );
    const label = lang ? lang.label : code;
    const isActive = active !== "ALL" && active.toLowerCase() === code.toLowerCase();
    header.appendChild(createHeaderPill(code, label, isActive, onSwitch));
  }

  positionHeader(header, owner);
}

function positionHeader(header: HTMLElement, owner: Element): void {
  // Prefer inserting before the metadata/properties section.
  const meta = owner.querySelector(".metadata-container, .frontmatter-container");
  if (meta) {
    const metaSection = meta.closest(".markdown-preview-section");
    if (metaSection && metaSection.parentElement === owner) {
      if (header.nextElementSibling !== metaSection) {
        metaSection.before(header);
      }
      return;
    }
  }

  // Fall back to after the inline-title section.
  const title = owner.querySelector(".inline-title");
  if (title) {
    const section = title.closest(".markdown-preview-section");
    const anchor = (section && section.parentElement === owner) ? section : title;
    if (header.previousElementSibling !== anchor) {
      anchor.after(header);
    }
    return;
  }

  // Last resort: prepend.
  if (owner.firstElementChild !== header) {
    owner.prepend(header);
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
