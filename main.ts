/**
 * main.ts  –  Multilingual Notes Plugin
 *
 * Entry point for the Obsidian community plugin.
 * Wires together: settings, reading-mode post-processor,
 * editing-mode CodeMirror 6 extension, ribbon button,
 * status bar UI, and Command Palette commands.
 */

import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin, setIcon,
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
  langMatch,
} from "./src/markdownProcessor";
import { buildEditorExtension, setActiveLangEffect } from "./src/editorExtension";
import { initializeI18n, t } from "./src/i18n";

export default class MultilingualNotesPlugin extends Plugin {
  settings!: MultilingualNotesSettings;

  /** Status-bar element holding the language switcher. */
  private statusBarEl!: HTMLElement;

  /** Ribbon button element. */
  private ribbonEl!: HTMLElement;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();
    initializeI18n((this.app as any)?.vault?.getConfig?.("locale"));

    // 1. Register the reading-mode post-processor.
    registerReadingModeProcessor(this);

    // 2. Register the CodeMirror 6 editor extension.
    this.registerEditorExtension(
      buildEditorExtension({
        getActiveLanguage: () => this.settings.activeLanguage,
        getHideMode: () => this.settings.hideInEditor,
      })
    );

    // 3. Ribbon icon — click opens a language-picker menu.
    this.ribbonEl = this.addRibbonIcon(
      "languages",
      t("ribbon.switch_language"),
      (evt: MouseEvent) => {
        this.showLanguageMenu(evt);
      }
    );
    this.ribbonEl.addClass("ml-ribbon-button");

    // 4. Status bar widget.
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.order = "999";
    this.statusBarEl.addClass("ml-status-bar");
    this.buildStatusBar();

    // 5. Settings tab.
    this.addSettingTab(new MultilingualNotesSettingTab(this.app, this));

    // 6. Command Palette commands.
    this.registerCommands();

    // 7. Context menu in editor.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        this.addEditorContextMenuItems(menu, editor);
      })
    );

    // 8. Per-note frontmatter override — re-evaluate on file open.
    //    Also, re-filter the Outline panel for the newly active file.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        if (!leaf) return;
        this.applyFrontmatterOverride(leaf);
        // Defer so Obsidian's outline has time to re-render for the new file.
        setTimeout(() => this.filterOutlineView(), 0);
      })
    );

    // Ensure cached block parsing never leaks across layout/mode switches.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        clearBlockCache();
        this.refreshAllViews();
        // Re-filter the Outline panel after layout settles (e.g. panel opened).
        setTimeout(() => this.filterOutlineView(), 0);
      })
    );
  }

  onunload(): void {
    // Nothing special needed; Obsidian cleans up registered components.
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Ensure language list is always valid
    if (!this.settings.languages || this.settings.languages.length === 0) {
      this.settings.languages = DEFAULT_SETTINGS.languages;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ─── Language switching ─────────────────────────────────────────────────

  /** Switch active language, persist, and refresh every open leaf. */
  async setActiveLanguage(code: string): Promise<void> {
    this.settings.activeLanguage = code;
    await this.saveSettings();
    // Invalidate the reading-mode block parse cache so the new language
    // is applied correctly on the next render pass.
    clearBlockCache();
    this.buildStatusBar();
    this.refreshAllViews();
    this.filterOutlineView();
  }

  /** Push a CM6 effect to all open editors so decorations recalculate. */
  refreshAllViews(): void {
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        const mode = view.getMode();
        if (mode === "preview") {
          // Reading mode: trigger re-render via previewMode only.
          // Never touch view.editor in preview mode; it can force a mode switch.
          (view as any).previewMode?.rerender(true);
        } else {
          // Live-preview / source mode: push CM6 state effect.
          const cm = (view.editor as any)?.cm as any;
          if (cm && typeof cm.dispatch === "function") {
            cm.dispatch({
              effects: [setActiveLangEffect.of(this.settings.activeLanguage)],
            });
          }
        }
      }
    });
  }

  // ─── Outline panel filtering ───────────────────────────────────────────

  /**
   * Hide heading items in the built-in Outline panel that belong to
   * language blocks other than the currently active one.
   *
   * The Outline panel is populated from the metadata cache (raw source),
   * so it ignores our display:none DOM changes — this method compensates
   * by directly manipulating the outline item DOM.
   *
   * Outline items are matched to headings by DOM depth-first order,
   * which equals the heading order in the document.
   */
  filterOutlineView(): void {
    const outlineLeaves = this.app.workspace.getLeavesOfType("outline");
    if (outlineLeaves.length === 0) return;

    const resetAll = () => {
      for (const leaf of outlineLeaves) {
        leaf.view.containerEl
          .querySelectorAll<HTMLElement>(".tree-item")
          .forEach(el => { el.style.display = ""; });
      }
    };

    const activeFile = this.app.workspace.getActiveFile();
    const active = this.settings.activeLanguage;

    if (!activeFile || active === "ALL") { resetAll(); return; }

    const fileCache = this.app.metadataCache.getFileCache(activeFile);
    const headings = fileCache?.headings;
    if (!headings || headings.length === 0) { resetAll(); return; }

    // Try to get source from an open editor (sync, no I/O).
    let sourceText: string | null = null;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (sourceText !== null) return;
      const view = leaf.view as any;
      if (
        view?.file?.path === activeFile.path &&
        typeof view?.editor?.getValue === "function"
      ) {
        sourceText = view.editor.getValue() as string;
      }
    });

    if (sourceText !== null) {
      this._applyOutlineFilter(outlineLeaves, headings, sourceText, active);
    } else {
      // Fall back to async vault read (file not currently open in an editor).
      this.app.vault.cachedRead(activeFile).then(text => {
        this._applyOutlineFilter(outlineLeaves, headings, text, active);
      });
    }
  }

  private _applyOutlineFilter(
    outlineLeaves: ReturnType<typeof this.app.workspace.getLeavesOfType>,
    headings: { heading: string; position: { start: { line: number } } }[],
    source: string,
    active: string,
  ): void {
    const blocks = parseLangBlocks(source);

    // Compute per-heading visibility (indexed same as headings array).
    const visible: boolean[] = headings.map(h => {
      const line = h.position.start.line;
      if (blocks.length === 0) {
        return langMatch(active, this.settings.defaultLanguage);
      }
      for (const block of blocks) {
        if (line > block.openLine && (block.closeLine < 0 || line < block.closeLine)) {
          return langMatch(block.langCode, active);
        }
      }
      return true; // outside all lang blocks → always visible
    });

    for (const leaf of outlineLeaves) {
      const items = Array.from(
        leaf.view.containerEl.querySelectorAll<HTMLElement>(".tree-item")
      );
      items.forEach((item, i) => {
        item.style.display = i < visible.length && !visible[i] ? "none" : "";
      });
    }
  }

  // ─── Status bar ────────────────────────────────────────────────────────

  buildStatusBar(): void {
    this.statusBarEl.empty();

    const wrapper = this.statusBarEl.createDiv("ml-status-wrapper");

    // Globe / language icon
    const icon = wrapper.createSpan("ml-status-icon");
    setIcon(icon, "languages");

    // Current language label (clickable)
    const label = wrapper.createSpan("ml-status-label");
    label.textContent = this.getActiveLabel();
    label.setAttribute("title", t("status_bar.click_to_switch"));
    label.style.cursor = "pointer";

    // Use direct onclick assignment to avoid duplicate handlers on rebuilds.
    this.statusBarEl.onclick = (e: MouseEvent) => {
      this.showLanguageMenu(e);
    };
  }

  refreshStatusBar(): void {
    this.buildStatusBar();
  }

  private getActiveLabel(): string {
    if (this.settings.activeLanguage === "ALL") return t("status_bar.all_languages");
    const lang = this.settings.languages.find(
      (l) => l.code === this.settings.activeLanguage
    );
    return lang ? lang.label : this.settings.activeLanguage;
  }

  // ─── Language picker menu ──────────────────────────────────────────────

  private showLanguageMenu(evt: MouseEvent): void {
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle(t("menu.show_all_languages"))
        .setChecked(this.settings.activeLanguage === "ALL")
        .onClick(async () => {
          await this.setActiveLanguage("ALL");
        });
    });

    menu.addSeparator();

    for (const lang of this.settings.languages) {
      menu.addItem((item) => {
        item
          .setTitle(lang.label)
          .setChecked(this.settings.activeLanguage === lang.code)
          .onClick(async () => {
            await this.setActiveLanguage(lang.code);
          });
      });
    }

    menu.showAtMouseEvent(evt);
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  private registerCommands(): void {
    // Switch language commands for each configured language.
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

    // Show all languages.
    this.addCommand({
      id: "switch-lang-ALL",
      name: t("command.switch_show_all"),
      callback: async () => {
        await this.setActiveLanguage("ALL");
        new Notice(t("notice.showing_all_blocks"));
      },
    });

    // Cycle through languages (keyboard-shortcut friendly).
    this.addCommand({
      id: "cycle-language",
      name: t("command.cycle_next"),
      hotkeys: [{ modifiers: ["Alt"], key: "l" }],
      callback: async () => {
        await this.cycleLanguage();
      },
    });

    // Insert language block at cursor.
    this.addCommand({
      id: "insert-lang-block",
      name: t("command.insert_lang_block"),
      editorCallback: (editor: Editor) => {
        this.insertLangBlock(editor);
      },
    });

    // Wrap current selection in language block.
    this.addCommand({
      id: "wrap-selection-in-lang-block",
      name: t("command.wrap_selection"),
      editorCallback: (editor: Editor) => {
        this.wrapSelectionInLangBlock(editor);
      },
    });

    // Insert a full multilingual template.
    this.addCommand({
      id: "insert-multilingual-template",
      name: t("command.insert_template"),
      editorCallback: (editor: Editor) => {
        this.insertMultilingualTemplate(editor);
      },
    });
  }

  // ─── Editor helpers ────────────────────────────────────────────────────

  private getInsertionLanguageCode(): string {
    if (this.settings.activeLanguage !== "ALL") return this.settings.activeLanguage;
    return this.settings.languages[0]?.code ?? "en";
  }

  private insertLangBlock(editor: Editor): void {
    const active = this.getInsertionLanguageCode();

    const snippet = `[//]: # (lang ${active})\n\n[//]: # (endlang)`;
    const cursor = editor.getCursor();
    editor.replaceRange(snippet, cursor);
    editor.setCursor({ line: cursor.line + 1, ch: 0 });
  }

  private wrapSelectionInLangBlock(editor: Editor): void {
    const selection = editor.getSelection();
    if (!selection) {
      new Notice(t("notice.select_text_first"));
      return;
    }
    const active = this.getInsertionLanguageCode();

    editor.replaceSelection(`[//]: # (lang ${active})\n${selection}\n\n[//]: # (endlang)`);
  }

  private insertMultilingualTemplate(editor: Editor): void {
    const lines: string[] = [];
    for (const lang of this.settings.languages) {
      lines.push(`[//]: # (lang ${lang.code})`);
      lines.push(`<!-- ${lang.label} content here -->`);
      lines.push("\n");
      lines.push("[//]: # (endlang)");
      lines.push("");
    }
    const cursor = editor.getCursor();
    editor.replaceRange(lines.join("\n"), cursor);
  }

  private async cycleLanguage(): Promise<void> {
    const codes = this.settings.languages.map((l) => l.code);
    const current = this.settings.activeLanguage;
    const idx = codes.indexOf(current);
    const next = idx === -1 || idx === codes.length - 1
      ? codes[0]
      : codes[idx + 1];
    await this.setActiveLanguage(next);
    const label = this.settings.languages.find((l) => l.code === next)?.label ?? next;
    new Notice(t("notice.current_language", { label }));
  }

// ─── Editor context menu ────────────────────────────────────────────────

  private addEditorContextMenuItems(menu: Menu, editor: Editor): void {
    menu.addItem((item) => {
      item
          .setTitle(t("menu.multilingual"))
          .setIcon("languages");

      const submenu = (item as any).setSubmenu() as Menu;

      submenu.addItem((subItem) => {
        subItem
            .setTitle(t("menu.wrap"))
            .setIcon("wrap-text")
            .onClick(() => this.wrapSelectionInLangBlock(editor));
      });

      submenu.addItem((subItem) => {
        subItem
            .setTitle(t("menu.smart_insert"))
            .setIcon("sparkles")
            .onClick(() => this.smartInsertLanguageBlock(editor));
      });

      submenu.addItem((subItem) => {
        subItem
            .setTitle(t("menu.manual_insert"))
            .setIcon("list");

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
                if (el) {
                  el.style.opacity = "0.4";
                  el.style.cursor = "not-allowed";
                  const titleEl = el.querySelector(".menu-item-title");
                  if (titleEl) titleEl.textContent = t("menu.existing_lang_prefix", { label: lang.label });
                }
              }, 0);
            } else {
              langItem.onClick(() => this.insertLangBlockForLanguage(editor, lang.code));
            }
          });
        }
      });
    });

    setTimeout(() => {
      const menuDom = (menu as any).dom as HTMLElement;
      if (!menuDom) return;

      const allItems = Array.from(menuDom.querySelectorAll<HTMLElement>(".menu-item"));

      const ourItem = allItems.find(el =>
          el.querySelector(".lucide-languages") ||
          el.querySelector("[data-icon='languages']")
      );
      if (!ourItem) return;

      const insertItem = allItems.find(el =>
          el.querySelector(".lucide-list-plus") ||
          el.querySelector("[data-icon='list-plus']")
      );
      if (!insertItem) return;

      ourItem.remove();
      insertItem.after(ourItem);
    }, 0);
  }

  private detectExistingLanguages(editor: Editor): Set<string> {
    const content = editor.getValue();
    const blocks = parseLangBlocks(content);
    const existing = new Set<string>();

    for (const block of blocks) {
      // Support multi-code blocks separated by spaces.
      const codes = block.langCode.split(/\s+/);
      codes.forEach(code => existing.add(code));
    }

    return existing;
  }

  private smartInsertLanguageBlock(editor: Editor): void {
    const existingLangs = this.detectExistingLanguages(editor);

    const nextLang = this.settings.languages.find(
        lang => !existingLangs.has(lang.code)
    );

    if (nextLang) {
      this.insertLangBlockForLanguage(editor, nextLang.code);
      new Notice(t("notice.inserted_block", { label: nextLang.label }));
    } else {
      new Notice(t("notice.fully_internationalized"), 3000);
    }
  }

  private insertLangBlockForLanguage(editor: Editor, langCode: string): void {
    const lastLine = editor.lastLine();
    const lastLineContent = editor.getLine(lastLine);
    const prefix = lastLineContent.trim() === "" ? "" : "\n";
    const snippet = `${prefix}\n[//]: # (lang ${langCode})\n\n[//]: # (endlang)`;
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


  // ─── Frontmatter override ──────────────────────────────────────────────

  /**
   * If the currently opened note has `lang: xx-XX` in its frontmatter,
   * temporarily override the active language for this leaf.
   *
   * We do NOT persist this override — it's session-level per note.
   */
  private applyFrontmatterOverride(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    const file = view.file;
    if (!file) return;

    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return;

    const langOverride: string | undefined = frontmatter["lang"];
    if (!langOverride) return;

    const known = this.settings.languages.map((l) => l.code);
    if (langOverride === "ALL" || known.includes(langOverride)) {
      // Non-persistent override just for this leaf session
      this.settings.activeLanguage = langOverride;
      this.buildStatusBar();
      // Refresh only the current leaf.
      // Guard editor access by mode: preview rerenders via previewMode only.
      setTimeout(() => {
        const currentMode = view.getMode();
        if (currentMode === "preview") {
          clearBlockCache();
          (view as any).previewMode?.rerender(true);
        } else {
          const cm = (view.editor as any)?.cm as any;
          if (cm && typeof cm.dispatch === "function") {
            cm.dispatch({
              effects: [setActiveLangEffect.of(langOverride)],
            });
          }
        }
      }, 50);
    }
  }
}
