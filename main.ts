/** Entry point that wires settings, UI, language state, and editor integrations. */

import {
  Editor,
  MarkdownView,
  Menu,
  MenuItem,
  Notice,
  Plugin,
  WorkspaceLeaf,
  TAbstractFile,
  TFile,
  debounce,
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
  extractAvailableLanguagesFromBlocks,
  langMatch,
  sweepSectionVisibility,
  applyInlineTitleOverride,
} from "./src/markdownProcessor";
import { buildEditorExtension, setActiveLangEffect } from "./src/editorExtension";
import { matchLanguageBlockOpen, isLanguageBlockClose } from "./src/syntax";
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
  public leafLanguageOverrides = new WeakMap<WorkspaceLeaf, { code: string, filePath: string }>();
  public compareManager!: CompareManager;
  /** Tracks each MarkdownView's last-known mode to detect edit→preview transitions. */
  private _viewModes = new WeakMap<MarkdownView, string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    initializeI18n(detectObsidianLocale(this.app));
    this.compareManager = new CompareManager(this.app, this);

    registerReadingModeProcessor(this);
    this.registerEditorExtension(
      buildEditorExtension({
        getActiveLanguage: () => this.getEffectiveLanguageForActiveLeaf(),
        getHideMode: () => this.settings.hideInEditor,
        isInScope: () => {
          const file = this.app.workspace.getActiveFile();
          return !file || this.isFileInScope(file.path);
        },
      })
    );

    this.ribbonEl = this.addRibbonIcon("languages", t("ribbon.switch_language"), (evt: MouseEvent) => {
      this.showLanguageMenu(evt);
    });
    this.ribbonEl.addClass("ml-ribbon-button");
    this.refreshRibbon();

    this.statusBarEl = this.addStatusBarItem();
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
        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) => {
            item.setTitle(t("menu.multilingual") || "Multilingual").setIcon("languages");
            const submenu = (item as unknown as { setSubmenu(): Menu }).setSubmenu();

            submenu.addItem((exportItem) => {
              exportItem.setTitle(t("menu.export") || "Export").setIcon("download");
              const exportSubmenu = (exportItem as unknown as { setSubmenu(): Menu }).setSubmenu();

              for (const lang of this.settings.languages) {
                exportSubmenu.addItem((langItem) => {
                  langItem.setTitle(lang.label);
                  langItem.onClick(async () => {
                    const content = await this.app.vault.read(file);
                    const blocks = parseLangBlocks(content);
                    const existing = extractAvailableLanguagesFromBlocks(blocks, this.settings.languages);

                    if (!existing.has(lang.code.toLowerCase()) && existing.size > 0) {
                      new Notice(t("notice.export_no_block").replace("{label}", lang.label));
                    }
                    const extracted = this.extractLanguageContent(content, lang.code);
                    this.downloadAsFile(`${file.basename}-${lang.code}.md`, extracted);
                  });
                });
              }
            });
          });
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        if (leaf) {
          this.applyFrontmatterOverride(leaf);
        }
        this.refreshStatusBar();
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
        // Block cache is keyed by content hash, so stale entries are never
        // returned — no need to clear on every layout-change.  Only clear
        // when content actually changes (editor-change) or settings change.
        this.refreshAllViews();
        setTimeout(() => this.filterOutlineView(), 0);
      })
    );

    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        debounce((editor: Editor, info: MarkdownView) => {
          this.normalizeMarkerSpacing(editor);
          void this.syncLangFrontmatter(editor, (info as unknown as { file: TFile | null }).file ?? null);
        }, 800, true)
      )
    );

    // Run on file open (covers files opened without editing).
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || file.extension !== "md") return;
        setTimeout(() => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view || view.file?.path !== file.path) return;
          this.normalizeMarkerSpacing(view.editor);
          void this.syncLangFrontmatter(view.editor, file);
        }, 0);
      })
    );

    // Run on edit→preview transition (user switches to reading mode).
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (!(leaf.view instanceof MarkdownView)) return;
          const view = leaf.view;
          const mode = view.getMode();
          const prev = this._viewModes.get(view);
          this._viewModes.set(view, mode);
          // Only fire on the exact moment of transition to preview.
          if (mode !== "preview" || prev === "preview") return;
          const file = view.file;
          if (!file) return;
          this.normalizeMarkerSpacing(view.editor);
          void this.syncLangFrontmatter(view.editor, file);
        });
      })
    );
  }

  onunload(): void { }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MultilingualNotesSettings>);
    if (!this.settings.languages || this.settings.languages.length === 0) {
      this.settings.languages = DEFAULT_SETTINGS.languages;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Returns false if `filePath` is excluded or outside the configured working directories. */
  public isFileInScope(filePath: string): boolean {
    const work = this.settings.workDirs.filter(Boolean);
    const excl = this.settings.excludeDirs.filter(Boolean);
    const underDir = (path: string, dir: string) =>
      path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");
    if (excl.some((d) => underDir(filePath, d))) return false;
    if (work.length === 0) return true;
    return work.some((d) => underDir(filePath, d));
  }

  async setActiveLanguage(code: string): Promise<void> {
    this.settings.activeLanguage = this.resolveLanguageCode(code);
    await this.saveSettings();
    this.refreshStatusBar();
    this.applyLanguageSweep();
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

  computeHasMissingLanguages(): boolean {
    const configuredCount = this.settings.languages.length;
    if (configuredCount === 0) return false;

    const editorText = this.app.workspace
        .getActiveViewOfType(MarkdownView)?.editor?.getValue();

    if (editorText != null) {
      const blocks = parseLangBlocks(editorText);
      // 没有任何语言块 → 不是多语言笔记，不提示
      if (blocks.length === 0) return false;
      const implemented = extractAvailableLanguagesFromBlocks(blocks, this.settings.languages);
      return implemented.size < configuredCount;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      const fm = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
      const langRaw = fm?.lang as unknown;
      const langCodes: string[] = langRaw
          ? (Array.isArray(langRaw) ? (langRaw as unknown[]).map(String) : [String(langRaw)])
          : [];
      // frontmatter 无 lang 字段 → 不是多语言笔记，不提示
      if (langCodes.length === 0) return false;
      return langCodes.length < configuredCount;
    }

    return false;
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
        .filter(l => (l.view as unknown as { file?: { path: string } }).file?.path === sourcePath);
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

  setLanguageForSpecificLeaf(leaf: WorkspaceLeaf, code: string): void {
    const resolvedCode = this.resolveLanguageCode(code);
    const view = leaf.view;
    let filePath = "";
    if (view instanceof MarkdownView && view.file) {
      filePath = view.file.path;
    } else if ((view as unknown as { file?: { path: string } })?.file?.path) {
      filePath = (view as unknown as { file: { path: string } }).file.path;
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

    // Apply to the exact leaf only — never touch other leaves to keep compare splits isolated.
    if (leaf.view instanceof MarkdownView) {
      if (leaf.view.getMode() === "preview") {
        const previewEl = leaf.view.containerEl.querySelector(".markdown-preview-view");
        if (previewEl) {
          (previewEl as HTMLElement).scrollTop = 0;
          // Sweep first for immediate visual feedback on in-DOM sections,
          // then force a full rerender so the virtual scroller's off-screen
          // cached sections are rebuilt with the correct language.
          sweepSectionVisibility(previewEl, resolvedCode);
          applyInlineTitleOverride(previewEl, filePath, resolvedCode, this);
          (leaf.view as MarkdownView).previewMode.rerender(true);
        }
      } else {
        const cm = (leaf.view.editor as unknown as { cm?: { dispatch: (tr: unknown) => void } })?.cm;
        if (cm && typeof cm.dispatch === "function") {
          cm.dispatch({ effects: [setActiveLangEffect.of(resolvedCode)] });
        }
      }
    }

    this.refreshStatusBar();
    this.filterOutlineView();
  }

  setLanguageForActiveLeaf(code: string): void {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return;
    this.setLanguageForSpecificLeaf(leaf, code);
  }

  /**
   * Re-apply language visibility across all leaves.  Sweep first for instant
   * visual feedback, then rerender(true) to rebuild cached off-screen sections
   * that the sweep cannot reach.
   */
  private applyLanguageSweep(): void {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.getMode() === "preview") {
        const previewEl = view.containerEl.querySelector(".markdown-preview-view");
        const effectiveLang = this.getEffectiveLanguageForLeaf(leaf);
        if (previewEl) {
          (previewEl as HTMLElement).scrollTop = 0;
          sweepSectionVisibility(previewEl, effectiveLang);
          const fp = view.file?.path ?? "";
          if (fp) applyInlineTitleOverride(previewEl, fp, effectiveLang, this);
        }
        view.previewMode.rerender(true);
        return;
      }
      const cm = (view.editor as unknown as { cm?: { dispatch: (tr: unknown) => void } })?.cm;
      if (cm && typeof cm.dispatch === "function") {
        cm.dispatch({ effects: [setActiveLangEffect.of(this.getEffectiveLanguageForLeaf(leaf))] });
      }
    });
  }

  refreshAllViews(): void {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.getMode() === "preview") {
        const previewEl = view.containerEl.querySelector(".markdown-preview-view");
        if (previewEl) {
          sweepSectionVisibility(previewEl, this.getEffectiveLanguageForLeaf(leaf));
        }
        view.previewMode.rerender(true);
        return;
      }
      const cm = (view.editor as unknown as { cm?: { dispatch: (tr: unknown) => void } })?.cm;
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
          el.removeClass("ml-outline-hidden");
        });
      }
    };

    const activeFile = this.app.workspace.getActiveFile();
    const active = this.getEffectiveLanguageForActiveLeaf();

    if (!activeFile || !this.isFileInScope(activeFile.path)) {
      ensureOutlineControl(outlineLeaves, this.settings, (code) => {
        this.setLanguageForActiveLeaf(code);
      }, active, new Set());
      resetAll();
      return;
    }

    const headings = this.app.metadataCache.getFileCache(activeFile)?.headings;

    let sourceText: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (sourceText !== null) return;
      if (!(leaf.view instanceof MarkdownView)) return;
      if (leaf.view.file?.path === activeFile.path) {
        sourceText = leaf.view.editor.getValue();
      }
    });

    const processWithText = (text: string) => {
      // Find present languages
      const blocks = parseLangBlocks(text);
      const normalizedPresentCodes = extractAvailableLanguagesFromBlocks(blocks, this.settings.languages);

      ensureOutlineControl(outlineLeaves, this.settings, (code) => {
        this.setLanguageForActiveLeaf(code);
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
      void this.app.vault.cachedRead(activeFile).then(processWithText);
    }
  }

  refreshRibbon(): void {
    this.ribbonEl.toggleClass("ml-hidden", !this.settings.showRibbon);
  }

  refreshStatusBar(): void {
    this.statusBarEl.toggleClass("ml-hidden", !this.settings.showStatusBar);
    if (this.settings.showStatusBar) {
      buildStatusBar(
        this.statusBarEl,
        this.settings,
        (evt) => {
          const activeFile = this.app.workspace.getActiveFile();
          if (!activeFile) return;

          const openLangMenu = (source: string) => {
            const blocks = parseLangBlocks(source);
            const parsedCodes = extractAvailableLanguagesFromBlocks(blocks, this.settings.languages);
            showLanguageMenu(evt, this.settings, (code) => {
              this.setLanguageForActiveLeaf(code);
              this.refreshStatusBar();
              return Promise.resolve();
            }, parsedCodes, this.getEffectiveLanguageForActiveLeaf());
          };

          const editorText = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor?.getValue();
          if (editorText != null) {
            openLangMenu(editorText);
          } else {
            void this.app.vault.cachedRead(activeFile).then(openLangMenu);
          }
        },
        () => {
          void import("./src/ui/compareModal").then(({ ComparisonModal }) => {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) return;

            const openModal = (source: string) => {
              const blocks = parseLangBlocks(source);
              const parsedCodes = Array.from(extractAvailableLanguagesFromBlocks(blocks, this.settings.languages));
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
              void this.app.vault.cachedRead(activeFile).then(openModal);
            }
          });
        },
        this.getEffectiveLanguageForActiveLeaf(), this.computeHasMissingLanguages()
      );
    }
  }

  private showLanguageMenu(evt: MouseEvent): void {
    showLanguageMenu(evt, this.settings, (code) => this.setActiveLanguage(code));
  }

  private registerCommands(): void {
    for (const lang of this.settings.languages) {
      this.addCommand({
        id: `switch-lang-${lang.code}`,
        name: t("command.switch_language", { label: lang.label }),
        callback: () => {
          void this.setActiveLanguage(lang.code).then(() => {
            new Notice(t("notice.language_switched", { label: lang.label }));
          });
        },
      });
    }

    this.addCommand({
      id: "switch-lang-ALL",
      name: t("command.switch_show_all"),
      callback: () => {
        void this.setActiveLanguage("ALL").then(() => {
          new Notice(t("notice.showing_all_blocks"));
        });
      },
    });

    this.addCommand({
      id: "cycle-language",
      name: t("command.cycle_next"),
      callback: () => { this.cycleLanguage(); },
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
      lines.push(`[//]: # (lang ${lang.code})`);
      lines.push(`<!-- ${lang.label} content here -->`);
      lines.push("");
      lines.push("[//]: # (endlang)");
      lines.push("");
    }
    editor.replaceRange(lines.join("\n"), editor.getCursor());
  }

  private cycleLanguage(): void {
    const codes = this.settings.languages.map((l) => l.code);
    const currentLang = this.getEffectiveLanguageForActiveLeaf();
    const idx = codes.findIndex((c) => c.toLowerCase() === currentLang.toLowerCase());
    const next = idx === -1 || idx === codes.length - 1 ? codes[0] : codes[idx + 1];

    this.setLanguageForActiveLeaf(next);

    const label = this.settings.languages.find((l) => l.code === next)?.label ?? next;
    new Notice(t("notice.current_language", { label }));
  }

  private addEditorContextMenuItems(menu: Menu, editor: Editor): void {
    menu.addItem((item) => {
      item.setTitle(t("menu.multilingual")).setIcon("languages");
      item.setSection("action");
      const submenu = (item as unknown as { setSubmenu(): Menu }).setSubmenu();

      // Track the currently visible language picker so we can close it when
      // the user moves to a different item. Avoids Obsidian's sibling-submenu
      // tracking bug by managing visibility ourselves (no setSubmenu on pickers).
      let activeLangMenu: Menu | null = null;

      const closeLangMenu = () => {
        if (activeLangMenu) { activeLangMenu.hide(); activeLangMenu = null; }
      };

      type MenuItemInternal = { dom: HTMLElement };

      /** Wrap a plain item so that hovering it closes any open lang picker. */
      const plain = (build: (s: MenuItem) => void) => {
        submenu.addItem((s) => {
          build(s);
          setTimeout(() => {
            const el = (s as unknown as MenuItemInternal).dom;
            el?.addEventListener("mouseenter", closeLangMenu);
          }, 0);
        });
      };

      /**
       * Item that shows a language-picker Menu to its right on hover.
       * Does NOT call setSubmenu() — that's what causes Obsidian to lock the
       * first hovered sibling's submenu for all subsequent hover events.
       */
      const picker = (title: string, icon: string, buildItems: (m: Menu) => void) => {
        submenu.addItem((s) => {
          s.setTitle(title).setIcon(icon);
          setTimeout(() => {
            const el = (s as unknown as MenuItemInternal).dom;
            if (!el) return;
            el.classList.add("ml-picker-item");
            el.addEventListener("mouseenter", () => {
              closeLangMenu();
              const langMenu = new Menu();
              buildItems(langMenu);
              const r = el.getBoundingClientRect();
              langMenu.showAtPosition({ x: r.right + window.scrollX, y: r.top + window.scrollY });
              activeLangMenu = langMenu;
            });
          }, 0);
        });
      };

      plain((s) => s.setTitle(t("menu.wrap")).setIcon("code").onClick(() => {
        if (!wrapSelectionInLangBlock(editor, this.getInsertionLanguageCode()))
          new Notice(t("notice.select_text_first"));
      }));

      picker(t("menu.copy") || "Copy", "copy", (m) => {
        const existing = this.detectExistingLanguages(editor);
        if (existing.size === 0) {
          m.addItem((i) => i.setTitle(t("notice.fully_internationalized") || "No language blocks").setDisabled(true));
          return;
        }
        for (const langCode of Array.from(existing)) {
          const lang = this.settings.languages.find(l => l.code.toLowerCase() === langCode) || { label: langCode, code: langCode };
          m.addItem((i) => i.setTitle(lang.label).onClick(() => {
            const extracted = this.extractLanguageContent(editor.getValue(), lang.code);
            void navigator.clipboard.writeText(extracted).then(() => {
              new Notice(t("notice.copied") + ` (${lang.label})`);
            });
          }));
        }
      });

      picker(t("menu.paste_as") || "Paste as...", "between-horizontal-start", (m) => {
        const existing = this.detectExistingLanguages(editor);
        for (const lang of this.settings.languages) {
          const exists = existing.has(lang.code.toLowerCase());
          m.addItem((i) => {
            i.setTitle(lang.label);
            if (exists) { i.setDisabled(true); return; }
            i.onClick(() => {
              void navigator.clipboard.readText().then((text) => {
                if (!text) { new Notice(t("notice.clipboard_empty")); return; }
                const wrapped = `\n\n:::lang ${lang.code}\n${text}\n:::\n\n`;
                const cursor = editor.getCursor();
                editor.replaceRange(wrapped, cursor);
                new Notice(t("notice.pasted") + ` (${lang.label})`);
                editor.setCursor({ line: cursor.line + wrapped.split('\n').length - 1, ch: 0 });
              }).catch(() => { new Notice(t("notice.clipboard_read_error")); });
            });
          });
        }
      });

      picker(t("menu.delete") || "Delete", "trash-2", (m) => {
        const existing = this.detectExistingLanguages(editor);
        if (existing.size === 0) {
          m.addItem((i) => i.setTitle(t("notice.fully_internationalized") || "No language blocks").setDisabled(true));
          return;
        }
        for (const langCode of Array.from(existing)) {
          const lang = this.settings.languages.find(l => l.code.toLowerCase() === langCode) || { label: langCode, code: langCode };
          m.addItem((i) => i.setTitle(lang.label).onClick(() => {
            const source = editor.getValue();
            const blocks = parseLangBlocks(source);
            const toRemove = blocks.filter(b =>
              b.langCode.split(/\s+/).some(c => c.toLowerCase() === lang.code.toLowerCase() || c.toLowerCase() === "all")
            );
            if (toRemove.length === 0) return;
            toRemove.reverse().forEach(b =>
              editor.replaceRange("", editor.offsetToPos(b.start), editor.offsetToPos(b.end))
            );
            new Notice((t("notice.deleted") || "Deleted!") + ` (${lang.label})`);
          }));
        }
      });

      picker(t("menu.manual_insert"), "circle-fading-plus", (m) => {
        const existing = this.detectExistingLanguages(editor);
        for (const lang of this.settings.languages) {
          const exists = existing.has(lang.code.toLowerCase());
          m.addItem((i) => {
            i.setTitle(exists ? t("menu.existing_lang_prefix", { label: lang.label }) : lang.label);
            if (exists) { i.setDisabled(true); return; }
            i.onClick(() => insertLangBlockForLanguage(editor, lang.code));
          });
        }
      });

      plain((s) => s.setTitle(t("menu.smart_insert") || "Smart Insert").setIcon("sparkles").onClick(() => this.smartInsertLanguageBlock(editor)));
      plain((s) => s.setTitle(t("menu.smart_translate") || "Smart Translation").setIcon("bot").onClick(() => this.openTranslationModal(editor)));
    });
  }

  public extractLanguageContent(source: string, targetLangCode: string): string {
    const blocks = parseLangBlocks(source);
    if (blocks.length === 0) return source;

    let result = "";
    let cursor = 0;

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


  private normalizeMarkerSpacing(editor: Editor): void {
    const content = editor.getValue();
    // Quick bailout: only run on notes that actually contain lang markers.
    if (!content.includes('lang')) return;

    const lines = content.split('\n');
    const insertions: Array<{ line: number; ch: number }> = [];
    let inCodeFence = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Track fenced code blocks so we don't touch marker-like text inside them.
      if (/^(`{3,}|~{3,})/.test(trimmed)) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) continue;

      const isMarker =
        matchLanguageBlockOpen(trimmed) !== null ||
        isLanguageBlockClose(trimmed);
      if (!isMarker) continue;

      // Needs blank line before?
      if (i > 0 && lines[i - 1].trim() !== '') {
        insertions.push({ line: i, ch: 0 });
      }
      // Needs blank line after?
      if (i < lines.length - 1 && lines[i + 1].trim() !== '') {
        insertions.push({ line: i, ch: lines[i].length });
      }
    }

    if (insertions.length === 0) return;

    // Apply bottom-to-top so earlier line numbers stay valid after each insert.
    insertions.sort((a, b) => b.line - a.line || b.ch - a.ch);
    for (const { line, ch } of insertions) {
      editor.replaceRange('\n', { line, ch });
    }
  }

  private async syncLangFrontmatter(editor: Editor, file: TFile | null): Promise<void> {
    if (!file) return;

    const content = editor.getValue();
    const blocks = parseLangBlocks(content);
    const langs = extractAvailableLanguagesFromBlocks(blocks, this.settings.languages);

    // Map lowercase codes back to the properly-cased codes from settings.
    const codes = Array.from(langs)
      .filter(c => c !== 'all')
      .map(lower => this.settings.languages.find(l => l.code.toLowerCase() === lower)?.code ?? lower)
      .sort();

    // Use metadata cache to check current value — avoids a disk read.
    const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const cachedLang = cached?.lang as unknown;
    const current: string[] = cachedLang
      ? (Array.isArray(cachedLang) ? (cachedLang as unknown[]).map(String).sort() : [String(cachedLang)])
      : [];

    if (JSON.stringify(codes) === JSON.stringify(current)) return;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const fmRecord = fm as Record<string, unknown>;
      if (codes.length === 0) {
        delete fmRecord['lang'];
      } else {
        fmRecord['lang'] = codes;
      }
    });
  }

  private downloadAsFile(filename: string, content: string): void {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.classList.add("ml-hidden");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private detectExistingLanguages(editor: Editor): Set<string> {
    const blocks = parseLangBlocks(editor.getValue());
    return extractAvailableLanguagesFromBlocks(blocks, this.settings.languages);
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
      new Notice(t("notice.translate_empty_note"));
      return;
    }

    const existingLanguages = this.detectExistingLanguages(editor);
    const modal = new TranslationModal(this.app, this, text, activeLangCode, existingLanguages);
    modal.onInsertCallback = (translatedText, targetLangCode) => {
      // Find where to insert. We can use the end of the active block.
      const pos = editor.offsetToPos(activeBlock!.end);
      let insertionContent = `\n\n:::lang ${targetLangCode}\n${translatedText}\n:::`;

      // Attempt to guess the boundary syntax based on the source block if possible
      const sourceOpenTag = text.slice(activeBlock!.start, activeBlock!.innerStart).trim();
      if (sourceOpenTag.startsWith("[//]:")) {
        insertionContent = `\n\n[//]: # (lang ${targetLangCode})\n${translatedText}\n[//]: # (endlang)`;
      } else if (sourceOpenTag.startsWith("{%")) {
        insertionContent = `\n\n{% lang ${targetLangCode} %}\n${translatedText}\n{% endlang %}`;
      } else if (sourceOpenTag.startsWith("%%")) {
        insertionContent = `\n\n%% lang ${targetLangCode} %%\n${translatedText}\n%% endlang %%`;
      }

      editor.replaceRange(insertionContent, pos);
    };
    modal.open();
  }

  private applyFrontmatterOverride(leaf: WorkspaceLeaf): void {
    // Never let per-file view preferences interfere with comparison splits —
    // each leaf in a comparison session has its language set explicitly.
    if (this.compareManager.isComparisonLeaf(leaf)) return;

    const resolved = resolveFrontmatterLanguage(
      leaf,
      (view) => {
        const fm = this.app.metadataCache.getFileCache(view.file!)?.frontmatter;
        return fm?.lang_view as string | undefined;
      },
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
        const previewEl = resolved.view.containerEl.querySelector(".markdown-preview-view");
        if (previewEl) sweepSectionVisibility(previewEl, resolved.lang);
        resolved.view.previewMode.rerender(true);
        return;
      }
      const cm = (resolved.view.editor as unknown as { cm?: { dispatch: (tr: unknown) => void } })?.cm;
      if (cm && typeof cm.dispatch === "function") {
        cm.dispatch({ effects: [setActiveLangEffect.of(resolved.lang)] });
      }
    }, 50);
  }
}
