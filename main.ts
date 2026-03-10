/** Entry point that wires settings, UI, language state, and editor integrations. */

import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  WorkspaceLeaf,
  TAbstractFile,
} from "obsidian";

import {
  DEFAULT_SETTINGS,
  MultilingualNotesSettings,
  MultilingualNotesSettingTab,
} from "./src/settings";

import {
  registerReadingModeProcessor,
  clearBlockCache,
  parseLangBlocks,
} from "./src/markdownProcessor";
import { buildEditorExtension, setActiveLangEffect } from "./src/editorExtension";
import { detectObsidianLocale, initializeI18n, t } from "./src/i18n";
import {
  getInsertionLanguageCode,
  insertLangBlock,
  insertLangBlockForLanguage,
  wrapSelectionInLangBlock,
} from "./src/commands/languageBlocks";
import { buildStatusBar, showLanguageMenu } from "./src/ui/statusBar";
import { applyOutlineFilter, ensureOutlineControl } from "./src/ui/outlineFilter";
import { resolveFrontmatterLanguage } from "./src/language-state/frontmatter";
import { TranslationModal } from "./src/ui/translationModal";
import { CompareManager } from "./src/compareManager";

export default class MultilingualNotesPlugin extends Plugin {
  settings!: MultilingualNotesSettings;
  private statusBarEl!: HTMLElement;
  private ribbonEl!: HTMLElement;
  private languageRefreshToken = 0;
  public leafLanguageOverrides = new WeakMap<WorkspaceLeaf, { code: string, filePath: string }>();
  public compareManager!: CompareManager;

  async onload(): Promise<void> {
    await this.loadSettings();
    initializeI18n(detectObsidianLocale(this.app));
    this.compareManager = new CompareManager(this.app, this);

    registerReadingModeProcessor(this);
    this.registerEditorExtension(
      buildEditorExtension({
        getActiveLanguage: () => this.getEffectiveLanguageForActiveLeaf(),
        getHideMode: () => this.settings.hideInEditor,
      })
    );

    this.ribbonEl = this.addRibbonIcon("languages", t("ribbon.switch_language"), (evt: MouseEvent) => {
      this.showLanguageMenu(evt);
    });
    this.ribbonEl.addClass("ml-ribbon-button");
    this.refreshRibbon();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.order = "999";
    this.statusBarEl.addClass("ml-status-bar");
    this.refreshStatusBar();

    this.addSettingTab(new MultilingualNotesSettingTab(this.app, this));
    this.registerCommands();

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        this.addEditorContextMenuItems(menu, editor);
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        import("obsidian").then(({ TFile }) => {
          if (file instanceof TFile && file.extension === "md") {
            menu.addItem((item) => {
              item.setTitle(t("menu.multilingual") || "Multilingual").setIcon("languages");
              const submenu = (item as any).setSubmenu() as Menu;

              submenu.addItem((exportItem) => {
                exportItem.setTitle(t("menu.export") || "Export").setIcon("download");
                const exportSubmenu = (exportItem as any).setSubmenu() as Menu;

                for (const lang of this.settings.languages) {
                  exportSubmenu.addItem((langItem) => {
                    langItem.setTitle(lang.label);
                    langItem.onClick(async () => {
                      const content = await this.app.vault.read(file);
                      const blocks = parseLangBlocks(content);
                      const existing = new Set<string>();
                      blocks.forEach(b => b.langCode.split(/\s+/).forEach(c => existing.add(c.toLowerCase())));

                      if (!existing.has(lang.code.toLowerCase()) && existing.size > 0) {
                        new Notice(`No ${lang.label} block found. Exporting shared content only.`);
                      }
                      const extracted = this.extractLanguageContent(content, lang.code);
                      this.downloadAsFile(`${file.basename}-${lang.code}.md`, extracted);
                    });
                  });
                }
              });
            });
          }
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        if (!leaf) return;
        this.applyFrontmatterOverride(leaf);
        setTimeout(() => this.filterOutlineView(), 0);
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        // Skip global re-render bursts while CompareManager is actively
        // constructing splits — each new leaf triggers layout-change, and
        // refreshAllViews() during setup would corrupt the primary leaf's
        // language state before the secondary leaf overrides are registered.
        if (this.compareManager.isSettingUp) return;
        clearBlockCache();
        this.refreshAllViews();
        setTimeout(() => this.filterOutlineView(), 0);
      })
    );
  }

  onunload(): void { }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.languages || this.settings.languages.length === 0) {
      this.settings.languages = DEFAULT_SETTINGS.languages;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async setActiveLanguage(code: string): Promise<void> {
    this.settings.activeLanguage = this.resolveLanguageCode(code);
    await this.saveSettings();
    clearBlockCache();
    this.refreshStatusBar();
    this.refreshAllViews();
    this.scheduleStabilizedRefresh();
    this.filterOutlineView();
  }

  /**
   * Set immediately before calling newLeaf.openFile() in CompareManager so that
   * post-processors running synchronously during that call can use it as a hint
   * for detached elements (before they are mounted to a leaf's DOM).
   * Always null outside of a compare-leaf spawn.
   */
  spawningLanguage: string | null = null;

  getEffectiveLanguageForLeaf(leaf: WorkspaceLeaf | null): string {
    if (!leaf) return this.settings.activeLanguage;
    const override = this.leafLanguageOverrides.get(leaf);

    // If the leaf has navigated to a different file, ignore the override
    if (override && leaf.view instanceof MarkdownView && leaf.view.file) {
      if (override.filePath === leaf.view.file.path) {
        return override.code;
      }
    } else if (override && (!leaf.view || !(leaf.view instanceof MarkdownView))) {
      // Keep it if it's not a markdown file/fully loaded yet, it might still be loading
      return override.code;
    }

    return this.settings.activeLanguage;
  }

  getEffectiveLanguageForActiveLeaf(): string {
    const leaf = this.app.workspace.getMostRecentLeaf();
    return this.getEffectiveLanguageForLeaf(leaf);
  }

  getLanguageForElement(el: HTMLElement, sourcePath?: string): string {
    // ── 1. Element is genuinely in the DOM ──────────────────────────────────
    // Walk all leaves and use contains() to find the owning leaf.
    // This is the reliable path; it works regardless of how deeply nested
    // leaf.view.containerEl is relative to the .workspace-leaf root.
    if (el.isConnected) {
      let foundLeaf: WorkspaceLeaf | null = null;
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (!foundLeaf && leaf.view.containerEl?.contains(el)) {
          foundLeaf = leaf;
        }
      });
      if (foundLeaf) return this.getEffectiveLanguageForLeaf(foundLeaf);
    }

    // ── 2. Element is detached (virtual-scroller lazy-render) ───────────────
    // The polling queue in markdownProcessor.ts will re-evaluate once mounted.
    // Use available hints to make the best initial guess and minimise flicker.

    // 2a. Active compare-leaf spawn — the plugin sets this before openFile().
    if (this.spawningLanguage) {
      return this.spawningLanguage;
    }

    // 2b. Exactly one leaf has this file open — unambiguous.
    if (sourcePath) {
      const leaves = this.app.workspace.getLeavesOfType("markdown")
        .filter(l => (l.view as any).file?.path === sourcePath);
      if (leaves.length === 1) {
        return this.getEffectiveLanguageForLeaf(leaves[0]);
      }
      if (leaves.length > 1) {
        // Multiple splits of the same file (compare session).
        // Use the most-recently-focused split as a best-effort guess;
        // the polling queue will correct any mismatch once the element mounts.
        const recentLeaf = this.app.workspace.getMostRecentLeaf();
        if (recentLeaf && leaves.includes(recentLeaf)) {
          return this.getEffectiveLanguageForLeaf(recentLeaf);
        }
        // recentLeaf is outside our splits — fall back to the first split.
        return this.getEffectiveLanguageForLeaf(leaves[0]);
      }
    }

    // ── 3. Absolute fallback ────────────────────────────────────────────────
    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    if (activeLeaf) return this.getEffectiveLanguageForLeaf(activeLeaf);
    return this.settings.activeLanguage;
  }

  private resolveLanguageCode(code: string): string {
    if (code === "ALL") return "ALL";
    const matched = this.settings.languages.find((lang) => lang.code.toLowerCase() === code.toLowerCase());
    return matched?.code ?? code;
  }

  async setLanguageForSpecificLeaf(leaf: WorkspaceLeaf, code: string): Promise<void> {
    const resolvedCode = this.resolveLanguageCode(code);
    const view = leaf.view;
    let filePath = "";
    if (view instanceof MarkdownView && view.file) {
      filePath = view.file.path;
    } else if ((view as any)?.file?.path) {
      filePath = (view as any).file.path;
    }

    this.leafLanguageOverrides.set(leaf, { code: resolvedCode, filePath });

    // Immediately force all UI pills inside this leaf to visually update.
    // This bypasses Obsidian's async chunk caching mechanics which may drop detached chunks.
    if (leaf.view && leaf.view.containerEl) {
      const pills = leaf.view.containerEl.querySelectorAll(".ml-lang-pill, .ml-outline-pill");
      pills.forEach((pill) => {
        const pillCode = pill.getAttribute("data-lang");
        if (!pillCode) return;
        const isActive = (resolvedCode === "ALL") ? pillCode === "ALL" : resolvedCode.toLowerCase() === pillCode.toLowerCase();
        if (isActive) {
          if (pill.classList.contains("ml-outline-pill")) {
            pill.classList.add("ml-outline-pill--active");
          } else {
            pill.classList.add("ml-lang-pill--active");
          }
        } else {
          pill.classList.remove("ml-outline-pill--active", "ml-lang-pill--active");
        }
      });
    }

    // Only re-render the exact leaf that changed language.
    // We explicitly avoid calling clearBlockCache() and refreshAllViews() here to 
    // strictly isolate independent compare splits.
    if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") {
      leaf.view.previewMode.rerender(true);
      // Ensures that any heavily bogged async updates settle their post-processors
      setTimeout(() => {
        if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") {
          leaf.view.previewMode.rerender(true);
        }
      }, 150);
    }

    this.refreshStatusBar();
    this.filterOutlineView();
  }

  async setLanguageForActiveLeaf(code: string): Promise<void> {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return;
    return this.setLanguageForSpecificLeaf(leaf, code);
  }

  private scheduleStabilizedRefresh(): void {
    const token = ++this.languageRefreshToken;
    window.setTimeout(() => {
      if (token !== this.languageRefreshToken) return;
      this.refreshAllViews();
    }, 80);
  }

  private resetPreviewDisplayState(view: MarkdownView): void {
    const previewRoot = view.containerEl.querySelector(".markdown-preview-view");
    if (!previewRoot) return;

    previewRoot.querySelectorAll<HTMLElement>(".ml-language-hidden").forEach((node) => {
      node.classList.remove("ml-language-hidden");
    });
  }

  refreshAllViews(): void {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.getMode() === "preview") {
        this.resetPreviewDisplayState(view);
        (view as any).previewMode?.rerender(true);
        return;
      }
      const cm = (view.editor as any)?.cm as any;
      if (cm && typeof cm.dispatch === "function") {
        cm.dispatch({ effects: [setActiveLangEffect.of(this.getEffectiveLanguageForLeaf(leaf))] });
      }
    });
  }

  filterOutlineView(): void {
    const outlineLeaves = this.app.workspace.getLeavesOfType("outline");
    if (outlineLeaves.length === 0) return;

    const resetAll = () => {
      for (const leaf of outlineLeaves) {
        leaf.view.containerEl.querySelectorAll<HTMLElement>(".tree-item").forEach((el) => {
          el.style.display = "";
        });
      }
    };

    const activeFile = this.app.workspace.getActiveFile();
    const active = this.getEffectiveLanguageForActiveLeaf();

    if (!activeFile) {
      ensureOutlineControl(outlineLeaves, this.settings, async (code) => {
        await this.setLanguageForActiveLeaf(code);
      }, active, new Set()); // Hide pills if no active file
      resetAll();
      return;
    }

    const normalizedPresentCodes = new Set<string>();

    const headings = this.app.metadataCache.getFileCache(activeFile)?.headings;

    let sourceText: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (sourceText !== null) return;
      const view = leaf.view as any;
      if (view?.file?.path === activeFile.path && typeof view?.editor?.getValue === "function") {
        sourceText = view.editor.getValue() as string;
      }
    });

    const processWithText = (text: string) => {
      // Find present languages
      const blocks = parseLangBlocks(text);
      for (const block of blocks) {
        block.langCode.split(/\s+/).filter(Boolean).forEach((c) => normalizedPresentCodes.add(c.toLowerCase()));
      }

      ensureOutlineControl(outlineLeaves, this.settings, async (code) => {
        await this.setLanguageForActiveLeaf(code);
      }, active, normalizedPresentCodes);

      if (active === "ALL" || !headings || headings.length === 0) {
        resetAll();
        return;
      }

      applyOutlineFilter(outlineLeaves, headings, text, active, this.settings.defaultLanguage);
    };

    if (sourceText !== null) {
      processWithText(sourceText);
    } else {
      this.app.vault.cachedRead(activeFile).then(processWithText);
    }
  }

  refreshRibbon(): void {
    this.ribbonEl.style.display = this.settings.showRibbon ? "" : "none";
  }

  refreshStatusBar(): void {
    this.statusBarEl.style.display = this.settings.showStatusBar ? "" : "none";
    if (this.settings.showStatusBar) {
      buildStatusBar(
        this.statusBarEl,
        this.settings,
        () => {
          import("./src/ui/compareModal").then(({ ComparisonModal }) => {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) return;

            const openModal = (source: string) => {
              const blocks = parseLangBlocks(source);
              const s = new Set<string>();
              blocks.forEach(b => b.langCode.split(/\s+/).filter(Boolean).forEach(c => s.add(c.toLowerCase())));
              const parsedCodes = Array.from(s);
              const selectedLangs = this.compareManager.getActiveComparisonLanguages();
              if (selectedLangs.size === 0) {
                selectedLangs.add(this.getEffectiveLanguageForActiveLeaf());
              }
              new ComparisonModal(this.app, this, selectedLangs, parsedCodes).open();
            };

            // Try the editor first (available in edit mode and sometimes preview mode).
            // Fall back to a vault read — required when the note is in reading/preview
            // mode only (editor.getValue() returns undefined or the view is absent).
            const editorText = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.getValue();
            if (editorText != null) {
              openModal(editorText);
            } else {
              this.app.vault.cachedRead(activeFile).then(openModal);
            }
          });
        },
        this.getEffectiveLanguageForActiveLeaf()
      );
    }
  }

  private showLanguageMenu(evt: MouseEvent): void {
    showLanguageMenu(evt, this.settings, async (code) => this.setActiveLanguage(code));
  }

  private registerCommands(): void {
    for (const lang of this.settings.languages) {
      this.addCommand({
        id: `switch-lang-${lang.code}`,
        name: t("command.switch_language", { label: lang.label }),
        callback: async () => {
          await this.setActiveLanguage(lang.code);
          new Notice(t("notice.language_switched", { label: lang.label }));
        },
      });
    }

    this.addCommand({
      id: "switch-lang-ALL",
      name: t("command.switch_show_all"),
      callback: async () => {
        await this.setActiveLanguage("ALL");
        new Notice(t("notice.showing_all_blocks"));
      },
    });

    this.addCommand({
      id: "cycle-language",
      name: t("command.cycle_next"),
      hotkeys: [{ modifiers: ["Alt"], key: "l" }],
      callback: async () => this.cycleLanguage(),
    });

    this.addCommand({
      id: "insert-lang-block",
      name: t("command.insert_lang_block"),
      editorCallback: (editor: Editor) => {
        insertLangBlock(editor, this.getInsertionLanguageCode());
      },
    });

    this.addCommand({
      id: "smart-insert-lang-block",
      name: t("command.smart_insert"),
      hotkeys: [{ modifiers: ["Alt"], key: "i" }],
      editorCallback: (editor: Editor) => {
        this.smartInsertLanguageBlock(editor);
      },
    });

    this.addCommand({
      id: "wrap-selection-in-lang-block",
      name: t("command.wrap_selection"),
      editorCallback: (editor: Editor) => {
        if (!wrapSelectionInLangBlock(editor, this.getInsertionLanguageCode())) {
          new Notice(t("notice.select_text_first"));
        }
      },
    });

    this.addCommand({
      id: "smart-translate",
      name: t("menu.smart_translate"),
      editorCallback: (editor: Editor) => this.openTranslationModal(editor),
    });

    this.addCommand({
      id: "insert-multilingual-template",
      name: t("command.insert_template"),
      editorCallback: (editor: Editor) => this.insertMultilingualTemplate(editor),
    });
  }

  private getInsertionLanguageCode(): string {
    return getInsertionLanguageCode(
      this.settings.activeLanguage,
      this.settings.languages[0]?.code ?? "en"
    );
  }

  private insertMultilingualTemplate(editor: Editor): void {
    const lines: string[] = [];
    for (const lang of this.settings.languages) {
      lines.push(`[//]: # (li8n ${lang.code})`);
      lines.push(`<!-- ${lang.label} content here -->`);
      lines.push("");
      lines.push("[//]: # (endli8n)");
      lines.push("");
    }
    editor.replaceRange(lines.join("\n"), editor.getCursor());
  }

  private async cycleLanguage(): Promise<void> {
    const codes = this.settings.languages.map((l) => l.code);
    const currentLang = this.getEffectiveLanguageForActiveLeaf();
    const idx = codes.findIndex((c) => c.toLowerCase() === currentLang.toLowerCase());
    const next = idx === -1 || idx === codes.length - 1 ? codes[0] : codes[idx + 1];

    await this.setLanguageForActiveLeaf(next);

    const label = this.settings.languages.find((l) => l.code === next)?.label ?? next;
    new Notice(t("notice.current_language", { label }));
  }

  private addEditorContextMenuItems(menu: Menu, editor: Editor): void {
    menu.addItem((item) => {
      item.setTitle(t("menu.multilingual")).setIcon("languages");
      const submenu = (item as any).setSubmenu() as Menu;

      submenu.addItem((subItem) => {
        subItem.setTitle(t("menu.wrap")).setIcon("wrap-text").onClick(() => {
          if (!wrapSelectionInLangBlock(editor, this.getInsertionLanguageCode())) {
            new Notice(t("notice.select_text_first"));
          }
        });
      });

      submenu.addItem((subItem) => {
        subItem.setTitle(t("menu.smart_translate") || "Smart Translation").setIcon("bot").onClick(() => this.openTranslationModal(editor));
      });

      submenu.addItem((subItem) => {
        subItem.setTitle(t("menu.copy") || "Copy").setIcon("copy");
        const copySubmenu = (subItem as any).setSubmenu() as Menu;
        const existingLanguages = this.detectExistingLanguages(editor);

        if (existingLanguages.size === 0) {
          copySubmenu.addItem((langItem) => {
            langItem.setTitle(t("notice.fully_internationalized") || "No language blocks");
            langItem.setDisabled(true);
          });
        } else {
          for (const langCode of Array.from(existingLanguages)) {
            const lang = this.settings.languages.find(l => l.code.toLowerCase() === langCode) || { label: langCode, code: langCode };
            copySubmenu.addItem((langItem) => {
              langItem.setTitle(lang.label);
              langItem.onClick(() => {
                const extracted = this.extractLanguageContent(editor.getValue(), lang.code);
                navigator.clipboard.writeText(extracted).then(() => {
                  new Notice((t("notice.copied") || "Copied!") + ` (${lang.label})`);
                });
              });
            });
          }
        }
      });

      submenu.addItem((subItem) => {
        subItem.setTitle(t("menu.smart_insert") || "Smart Insert").setIcon("sparkles").onClick(() => this.smartInsertLanguageBlock(editor));
      });

      submenu.addItem((subItem) => {
        subItem.setTitle(t("menu.manual_insert")).setIcon("list");
        const langSubmenu = (subItem as any).setSubmenu() as Menu;
        const existingLanguages = this.detectExistingLanguages(editor);

        for (const lang of this.settings.languages) {
          const exists = existingLanguages.has(lang.code);
          langSubmenu.addItem((langItem) => {
            langItem.setTitle(lang.label);
            if (exists) {
              langItem.setDisabled(true);
              setTimeout(() => {
                const el = (langItem as any).dom as HTMLElement;
                if (!el) return;
                el.style.opacity = "0.4";
                el.style.cursor = "not-allowed";
                const titleEl = el.querySelector(".menu-item-title");
                if (titleEl) titleEl.textContent = t("menu.existing_lang_prefix", { label: lang.label });
              }, 0);
            } else {
              langItem.onClick(() => insertLangBlockForLanguage(editor, lang.code));
            }
          });
        }
      });
    });

    setTimeout(() => {
      const menuDom = (menu as any).dom as HTMLElement;
      if (!menuDom) return;
      const allItems = Array.from(menuDom.querySelectorAll<HTMLElement>(".menu-item"));
      const ourItem = allItems.find((el) => el.querySelector(".lucide-languages") || el.querySelector("[data-icon='languages']"));
      const insertItem = allItems.find((el) => el.querySelector(".lucide-list-plus") || el.querySelector("[data-icon='list-plus']"));
      if (ourItem && insertItem) {
        ourItem.remove();
        insertItem.after(ourItem);
      }
    }, 0);
  }

  public extractLanguageContent(source: string, targetLangCode: string): string {
    const blocks = parseLangBlocks(source);
    if (blocks.length === 0) return source;

    let result = "";
    let cursor = 0;

    // langMatch uses the same logic as markdownProcessor, import not direct but we can inline it here or import it 
    // Wait, parseLangBlocks already gives us the exact bounds. Let's define langMatch locally just in case.
    const langMatch = (blockLangs: string, target: string) => {
      const lowerTarget = target.toLowerCase();
      return blockLangs.split(/\s+/).some((code) => code.toLowerCase() === lowerTarget);
    };

    for (const block of blocks) {
      if (block.start > cursor) {
        result += source.slice(cursor, block.start);
      }

      if (langMatch(block.langCode, targetLangCode)) {
        result += source.slice(block.innerStart, block.innerEnd);
      }

      cursor = block.end;
    }

    if (cursor < source.length) {
      result += source.slice(cursor);
    }

    return result;
  }

  private downloadAsFile(filename: string, content: string): void {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private detectExistingLanguages(editor: Editor): Set<string> {
    const blocks = parseLangBlocks(editor.getValue());
    const existing = new Set<string>();
    for (const block of blocks) {
      block.langCode.split(/\s+/).forEach((code) => existing.add(code.toLowerCase()));
    }
    return existing;
  }

  private smartInsertLanguageBlock(editor: Editor): void {
    const existingLangs = this.detectExistingLanguages(editor);
    const nextLang = this.settings.languages.find((lang) => !existingLangs.has(lang.code));
    if (nextLang) {
      insertLangBlockForLanguage(editor, nextLang.code);
      new Notice(t("notice.inserted_block", { label: nextLang.label }));
    } else {
      new Notice(t("notice.fully_internationalized"), 3000);
    }
  }

  private openTranslationModal(editor: Editor): void {
    const text = editor.getValue();
    const cursor = editor.getCursor();
    const cursorOffset = editor.posToOffset(cursor);
    const blocks = parseLangBlocks(text);

    let activeBlock = blocks.find((b) => cursorOffset >= b.start && cursorOffset <= b.end);
    let sourceContent = "";
    let activeLangCode = "";

    if (activeBlock) {
      sourceContent = text.slice(activeBlock.innerStart, activeBlock.innerEnd);
      activeLangCode = activeBlock.langCode.split(/\s+/)[0].toLowerCase();
    } else {
      // If not in a block, try to guess the active language, or just use the first block found
      if (blocks.length > 0) {
        activeBlock = blocks[0];
        sourceContent = text.slice(activeBlock.innerStart, activeBlock.innerEnd);
        activeLangCode = activeBlock.langCode.split(/\s+/)[0].toLowerCase();
      }
    }

    if (!sourceContent.trim() && blocks.length === 0) {
      new Notice("Cannot translate empty note without language blocks.");
      return;
    }

    const existingLanguages = this.detectExistingLanguages(editor);
    const modal = new TranslationModal(this.app, this, sourceContent, activeLangCode, existingLanguages);
    modal.onInsertCallback = (translatedText, targetLangCode) => {
      // Find where to insert. We can use the end of the active block.
      const pos = editor.offsetToPos(activeBlock!.end);
      let insertionContent = `\n\n:::lang ${targetLangCode}\n${translatedText}\n:::`;

      // Attempt to guess the boundary syntax based on the source block if possible
      const sourceOpenTag = text.slice(activeBlock!.start, activeBlock!.innerStart).trim();
      if (sourceOpenTag.startsWith("[//]:")) {
        insertionContent = `\n\n[//]: # (li8n ${targetLangCode})\n${translatedText}\n[//]: # (endli8n)`;
      } else if (sourceOpenTag.startsWith("{%")) {
        insertionContent = `\n\n{% li8n ${targetLangCode} %}\n${translatedText}\n{% endli8n %}`;
      } else if (sourceOpenTag.startsWith("%%")) {
        insertionContent = `\n\n%% li8n ${targetLangCode} %%\n${translatedText}\n%% endli8n %%`;
      }

      editor.replaceRange(insertionContent, pos);
    };
    modal.open();
  }

  private applyFrontmatterOverride(leaf: WorkspaceLeaf): void {
    const resolved = resolveFrontmatterLanguage(
      leaf,
      (view) => this.app.metadataCache.getFileCache(view.file!)?.frontmatter?.lang,
      this.settings.languages.map((l) => l.code)
    );
    if (!resolved || !resolved.view.file) return;

    this.leafLanguageOverrides.set(leaf, { code: this.resolveLanguageCode(resolved.lang), filePath: resolved.view.file.path });
    this.refreshStatusBar();
    // Guard by mode so preview refresh never touches editor APIs.
    // Side effect: only the current leaf is refreshed during override application.
    setTimeout(() => {
      if (resolved.view.getMode() === "preview") {
        clearBlockCache();
        this.resetPreviewDisplayState(resolved.view);
        (resolved.view as any).previewMode?.rerender(true);
        return;
      }
      const cm = (resolved.view.editor as any)?.cm as any;
      if (cm && typeof cm.dispatch === "function") {
        cm.dispatch({ effects: [setActiveLangEffect.of(resolved.lang)] });
      }
    }, 50);
  }
}
