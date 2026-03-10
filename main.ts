/** Entry point that wires settings, UI, language state, and editor integrations. */

import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  WorkspaceLeaf,
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

export default class MultilingualNotesPlugin extends Plugin {
  settings!: MultilingualNotesSettings;
  private statusBarEl!: HTMLElement;
  private ribbonEl!: HTMLElement;
  private languageRefreshToken = 0;
  private fileLanguageOverrides = new Map<string, string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    initializeI18n(detectObsidianLocale(this.app));

    registerReadingModeProcessor(this);
    this.registerEditorExtension(
      buildEditorExtension({
        getActiveLanguage: () => this.getEffectiveLanguageForActiveFile(),
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
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        if (!leaf) return;
        this.applyFrontmatterOverride(leaf);
        setTimeout(() => this.filterOutlineView(), 0);
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
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

  getEffectiveLanguageForPath(path?: string): string {
    if (!path) return this.settings.activeLanguage;
    return this.fileLanguageOverrides.get(path) ?? this.settings.activeLanguage;
  }

  getEffectiveLanguageForActiveFile(): string {
    return this.getEffectiveLanguageForPath(this.app.workspace.getActiveFile()?.path);
  }

  private resolveLanguageCode(code: string): string {
    if (code === "ALL") return "ALL";
    const matched = this.settings.languages.find((lang) => lang.code.toLowerCase() === code.toLowerCase());
    return matched?.code ?? code;
  }

  async setLanguageForActiveFile(code: string): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    this.fileLanguageOverrides.set(activeFile.path, this.resolveLanguageCode(code));
    clearBlockCache();
    this.refreshStatusBar();
    this.refreshAllViews();
    this.scheduleStabilizedRefresh();
    this.filterOutlineView();
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

    previewRoot.querySelectorAll<HTMLElement>("[style]").forEach((node) => {
      if (node.style.display) {
        node.style.display = "";
      }
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
        cm.dispatch({ effects: [setActiveLangEffect.of(this.getEffectiveLanguageForPath(view.file?.path))] });
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
    const active = this.getEffectiveLanguageForActiveFile();

    if (!activeFile) {
      ensureOutlineControl(outlineLeaves, this.settings, async (code) => {
        await this.setLanguageForActiveFile(code);
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
        await this.setLanguageForActiveFile(code);
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
      buildStatusBar(this.statusBarEl, this.settings, (evt: MouseEvent) => this.showLanguageMenu(evt), this.getEffectiveLanguageForActiveFile());
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
      lines.push(`[//]: # (lang ${lang.code})`);
      lines.push(`<!-- ${lang.label} content here -->`);
      lines.push("");
      lines.push("[//]: # (endlang)");
      lines.push("");
    }
    editor.replaceRange(lines.join("\n"), editor.getCursor());
  }

  private async cycleLanguage(): Promise<void> {
    const codes = this.settings.languages.map((l) => l.code);
    const idx = codes.indexOf(this.settings.activeLanguage);
    const next = idx === -1 || idx === codes.length - 1 ? codes[0] : codes[idx + 1];
    await this.setActiveLanguage(next);
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
        subItem.setTitle(t("menu.smart_translate")).setIcon("bot").onClick(() => this.openTranslationModal(editor));
      });

      submenu.addItem((subItem) => {
        subItem.setTitle(t("menu.smart_insert")).setIcon("sparkles").onClick(() => this.smartInsertLanguageBlock(editor));
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
        insertionContent = `\n\n[//]: # (lang ${targetLangCode})\n${translatedText}\n[//]: # (endlang)`;
      } else if (sourceOpenTag.startsWith("{%")) {
        insertionContent = `\n\n{% i8n ${targetLangCode} %}\n${translatedText}\n{% endi8n %}`;
      } else if (sourceOpenTag.startsWith("%%")) {
        insertionContent = `\n\n%% lang ${targetLangCode} %%\n${translatedText}\n%% end %%`;
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

    this.fileLanguageOverrides.set(resolved.view.file.path, this.resolveLanguageCode(resolved.lang));
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
