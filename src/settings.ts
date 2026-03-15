import {App, PluginSettingTab, Setting, Notice, setIcon, AbstractInputSuggest, TFolder} from "obsidian";

/** Folder path autocomplete — mirrors the pattern used by Obsidian's own template plugin. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private _inputEl: HTMLInputElement;
  private _app: App;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this._inputEl = inputEl;
    this._app = app;
  }

  getSuggestions(query: string): TFolder[] {
    const lower = query.toLowerCase();
    return this._app.vault.getAllFolders()
      .filter(f => f.path !== "/" && f.path.toLowerCase().contains(lower))
      .slice(0, 25);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(folder.path);
    this._inputEl.trigger("input");
    this.close();
  }
}
import type MultilingualNotesPlugin from "../main";
import { t } from "./i18n";

export interface LanguageEntry {
  code: string;
  label: string;
}

export interface MultilingualNotesSettings {
  activeLanguage: string;
  languages: LanguageEntry[];
  defaultLanguage: string;
  hideInEditor: boolean;
  showLangHeader: boolean;
  showRibbon: boolean;
  showStatusBar: boolean;
  aiApiBase: string;
  aiApiKey: string;
  aiModel: string;
  aiSystemPrompt: string;
  /** Override the inline title from frontmatter `title` / `title_<lang>`. */
  overrideInlineTitle: boolean;
  /** Vault-relative folder paths. Empty = plugin works everywhere. */
  workDirs: string[];
  /** Vault-relative folder paths. Plugin is fully disabled inside these. */
  excludeDirs: string[];
}

export const DEFAULT_SETTINGS: MultilingualNotesSettings = {
  activeLanguage: "en",
  languages: [
    { code: "zh-CN", label: "简体中文" },
    { code: "en", label: "English" },
    { code: "ja", label: "日本語" },
    { code: "fr", label: "Français" },
  ],
  defaultLanguage: "en",
  hideInEditor: true,
  overrideInlineTitle: true,
  showLangHeader: true,
  showRibbon: true,
  showStatusBar: true,

  aiApiBase: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiSystemPrompt: "You are an expert translator. Translate the provided Markdown text into the target language. Output ONLY the translated text, block for block, preserving all Markdown formatting, frontmatter, and code blocks exactly. Do not add any conversational filler or explain your translation.",
  workDirs: [],
  excludeDirs: [],
};

export const SYNTAX_EXAMPLES = [
  {
    titleKey: "settings.syntax.default_title",
    open: ":::lang zh-CN",
    close: ":::",
    noteKey: "settings.syntax.default_note",
  },
  {
    titleKey: "settings.syntax.hexo_title",
    open: "{% lang zh-CN %}",
    close: "{% endlang %}",
    noteKey: "settings.syntax.hexo_note",
  },
  {
    titleKey: "settings.syntax.comment_title",
    open: "[//]: # (lang zh-CN)",
    close: "[//]: # (endlang)",
    noteKey: "settings.syntax.comment_note",
  },
  {
    titleKey: "settings.syntax.obsidian_comment_title",
    open: "%% lang zh-CN %%",
    close: "%% endlang %%",
    noteKey: "settings.syntax.obsidian_comment_note",
  },
] as const;

export class MultilingualNotesSettingTab extends PluginSettingTab {
  plugin: MultilingualNotesPlugin;

  constructor(app: App, plugin: MultilingualNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ml-settings-root");

    // ── Plugin masthead ──────────────────────────────────────────────────
    const masthead = containerEl.createDiv("ml-settings-masthead");
    masthead.createEl("div", { cls: "ml-settings-masthead-icon", text: "" });
    const mastheadText = masthead.createDiv("ml-settings-masthead-text");
    mastheadText.createEl("div", { text: "Internationalization for Markdown · mi18n", cls: "ml-settings-masthead-heading" });
    mastheadText.createEl("p", { text: t("settings.plugin_tagline") });

    // ══ Section 1: Language Library ════════════════════════════════════════
    this.section(containerEl, "languages", t("settings.section_languages"), t("settings.section_languages_desc"), (body) => {

      // Language rows
        const listContainer = body.createDiv("ml-lang-list");
        this.renderLanguageList(listContainer);

      // Add-language footer row
        const addRow = body.createDiv("ml-settings-add-row");
        const addBtn = addRow.createEl("button", {
            text: "+ " + t("settings.add_language_button"),
            cls: "ml-settings-add-btn",
        });
      addBtn.addEventListener("click", () => {
        this.plugin.settings.languages.push({ code: "xx", label: "New Language" });
        void this.plugin.saveSettings().then(() => {
          listContainer.empty();
          this.renderLanguageList(listContainer);
        });
      });

      // Active / Default dropdowns (side by side)
      const dropRow = body.createDiv("ml-settings-drop-row");
      new Setting(dropRow)
        .setName(t("settings.active_language_name"))
        .setDesc(t("settings.active_language_desc"))
        .addDropdown((drop) => {
          drop.addOption("ALL", t("menu.show_all_languages"));
          for (const lang of this.plugin.settings.languages) {
            drop.addOption(lang.code, lang.label);
          }
          drop.setValue(this.plugin.settings.activeLanguage);
          drop.onChange(async (value) => {
            await this.plugin.setActiveLanguage(value);
          });
        });

      new Setting(dropRow)
        .setName(t("settings.default_language_name"))
        .setDesc(t("settings.default_language_desc"))
        .addDropdown((drop) => {
          for (const lang of this.plugin.settings.languages) {
            drop.addOption(lang.code, lang.label);
          }
          drop.setValue(this.plugin.settings.defaultLanguage);
          drop.onChange(async (value) => {
            this.plugin.settings.defaultLanguage = value;
            await this.plugin.saveSettings();
          });
        });
    });

    // ══ Section 2: Interface ═══════════════════════════════════════════════
    this.section(containerEl, "gamepad-directional", t("settings.section_interface"), t("settings.section_interface_desc"), (body) => {

      new Setting(body)
        .setName(t("settings.show_lang_header_name"))
        .setDesc(t("settings.show_lang_header_desc"))
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.showLangHeader);
          toggle.onChange(async (value) => {
            this.plugin.settings.showLangHeader = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          });
        });

      new Setting(body)
        .setName(t("settings.override_inline_title_name"))
        .setDesc(t("settings.override_inline_title_desc"))
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.overrideInlineTitle);
          toggle.onChange(async (value) => {
            this.plugin.settings.overrideInlineTitle = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          });
        });

      new Setting(body)
        .setName(t("settings.hide_other_name"))
        .setDesc(t("settings.hide_other_desc"))
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.hideInEditor);
          toggle.onChange(async (value) => {
            this.plugin.settings.hideInEditor = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAllViews();
          });
        });

      new Setting(body)
        .setName(t("settings.show_status_bar_name"))
        .setDesc(t("settings.show_status_bar_desc"))
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.showStatusBar);
          toggle.onChange(async (value) => {
            this.plugin.settings.showStatusBar = value;
            await this.plugin.saveSettings();
            this.plugin.refreshStatusBar();
          });
        });

      new Setting(body)
        .setName(t("settings.show_ribbon_name"))
        .setDesc(t("settings.show_ribbon_desc"))
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.showRibbon);
          toggle.onChange(async (value) => {
            this.plugin.settings.showRibbon = value;
            await this.plugin.saveSettings();
            this.plugin.refreshRibbon();
          });
        });
    });

    // ══ Section 3: AI Translation ══════════════════════════════════════════
    this.section(containerEl, "bot-message-square", t("settings.ai_translation_title"), t("settings.section_ai_desc"), (body) => {

      new Setting(body)
        .setName(t("settings.ai_api_base_name"))
        .setDesc(t("settings.ai_api_base_desc"))
        .addText((text) => {
          text
            .setPlaceholder("https://api.openai.com/v1")
            .setValue(this.plugin.settings.aiApiBase)
            .onChange(async (value) => {
              this.plugin.settings.aiApiBase = value.trim() || "https://api.openai.com/v1";
              await this.plugin.saveSettings();
            });
          text.inputEl.addClass("ml-settings-input-wide");
        });

      new Setting(body)
        .setName(t("settings.ai_api_key_name"))
        .setDesc(t("settings.ai_api_key_desc"))
        .addText((text) => {
          text
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.aiApiKey)
            .onChange(async (value) => {
              this.plugin.settings.aiApiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
          text.inputEl.addClass("ml-settings-input-wide");
        });

      new Setting(body)
        .setName(t("settings.ai_model_name"))
        .setDesc(t("settings.ai_model_desc"))
        .addText((text) => {
          text
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            .setPlaceholder("gpt-4o-mini")
            .setValue(this.plugin.settings.aiModel)
            .onChange(async (value) => {
              this.plugin.settings.aiModel = value.trim() || "gpt-4o-mini";
              await this.plugin.saveSettings();
            });
          text.inputEl.addClass("ml-settings-input-medium");
        });

      new Setting(body)
        .setName(t("settings.ai_system_prompt_name"))
        .setDesc(t("settings.ai_system_prompt_desc"))
        .addTextArea((text) => {
          text
            .setPlaceholder("You are an expert translator...")
            .setValue(this.plugin.settings.aiSystemPrompt)
            .onChange(async (value) => {
              this.plugin.settings.aiSystemPrompt = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 5;
          text.inputEl.addClass("ml-settings-input-full ml-settings-input-mono ml-settings-input-small");
        });
    });

    // ══ Section 4: Syntax Reference ════════════════════════════════════════
    this.section(containerEl, "terminal", t("settings.syntax_title"), t("settings.syntax_desc"), (body) => {
      this.renderSyntaxTabs(body);

      // No-lang-marker tip
      const tip = body.createDiv("ml-settings-tip");
      const tipTitle = tip.createDiv("ml-settings-tip-title");
      tipTitle.createSpan({ text: "Tip" });
      tipTitle.createEl("strong", { text: " " + t("settings.no_marker_title_short") });
      tip.createEl("p", { text: t("settings.no_marker_desc"), cls: "ml-settings-tip-body" });
    });

    // ══ Section 5: Scope ══════════════════════════════════════════════════
    this.section(containerEl, "folder-search", t("settings.section_scope"), t("settings.section_scope_desc"), (body) => {
      // Each group is wrapped independently so a failure in one never blocks the other.
      try { this.renderScopeGroup(body, t("settings.scope_work_dirs_name"), t("settings.scope_work_dirs_hint"), "workDirs"); }
      catch (e) { console.error("[mi18n] scope workDirs render error", e); }
      try { this.renderScopeGroup(body, t("settings.scope_excl_dirs_name"), t("settings.scope_excl_dirs_hint"), "excludeDirs"); }
      catch (e) { console.error("[mi18n] scope excludeDirs render error", e); }
    });

    // ══ Footer ══════════════════════════════════════════════════════════════
    const footer = containerEl.createDiv("ml-settings-footer");

    const brand = footer.createDiv("ml-settings-footer-brand");
    brand.createEl("p", {
      text: "Internationalization for Markdown · mi18n",
      cls: "ml-settings-footer-tagline",
    });

    const links = footer.createDiv("ml-settings-footer-links");

    const makeLink = (label: string, href: string) => {
      const a = links.createEl("a", { text: label, href, cls: "ml-settings-footer-link" });
      a.target = "_blank";
      a.rel = "noopener";
    };

    makeLink("Author's blog", "https://log.cns.red");
    links.createSpan({ text: "|", cls: "ml-settings-footer-sep" });
    makeLink("GitHub · cns-red/obsidian-mi18n", "https://github.com/cns-red/obsidian-mi18n");
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Creates a card section with a styled header and a body element passed to
   * the `fill` callback for populating with settings.
   */
  private section(
    parent: HTMLElement,
    iconId: string,
    title: string,
    desc: string,
    fill: (body: HTMLElement) => void,
  ): void {
    const card = parent.createDiv("ml-settings-section");

    const header = card.createDiv("ml-settings-section-header");
    const titleRow = header.createDiv("ml-settings-section-title-row");
    const titleIcon = titleRow.createDiv("ml-settings-section-title-icon");
    setIcon(titleIcon, iconId);
    titleRow.createEl("div", { text: title, cls: "ml-settings-section-heading" });
    if (desc) {
      header.createEl("p", { text: desc, cls: "ml-settings-section-desc" });
    }

    const body = card.createDiv("ml-settings-section-body");
    try {
      fill(body);
    } catch (err) {
      console.error("[mi18n] Error rendering section:", title, err);
    }
  }

  /**
   * Renders a tabbed view of the four supported syntax styles.
   * Uses the same segmented-control pill design as the article header.
   */
  private renderSyntaxTabs(container: HTMLElement): void {
    const wrap = container.createDiv("ml-syntax-wrap");
    const tabBar = wrap.createDiv("ml-syntax-tab-bar");
    const paneArea = wrap.createDiv("ml-syntax-pane-area");

    const langCode = this.plugin.settings.languages[0]?.code ?? "zh-CN";

    SYNTAX_EXAMPLES.forEach((ex, i) => {
      const isFirst = i === 0;

      // Tab button (reuses same shape as article pill)
      const tab = tabBar.createEl("button", {
        text: t(ex.titleKey),
        cls: "ml-syntax-tab" + (isFirst ? " ml-syntax-tab--active" : ""),
      });

      // Pane content
      const pane = paneArea.createDiv("ml-syntax-pane" + (isFirst ? " ml-syntax-pane--visible" : ""));
      pane.createEl("p", { text: t(ex.noteKey), cls: "ml-syntax-note" });

      const pre = pane.createEl("pre", { cls: "ml-syntax-code" });
      const sample = `${ex.open.replace("zh-CN", langCode)}\n${t("settings.syntax_sample_content")}\n${ex.close}`;
      pre.createEl("code", { text: sample });

      // Tab switching
      tab.addEventListener("click", () => {
        tabBar.querySelectorAll(".ml-syntax-tab").forEach(el => el.classList.remove("ml-syntax-tab--active"));
        paneArea.querySelectorAll(".ml-syntax-pane").forEach(el => el.classList.remove("ml-syntax-pane--visible"));
        tab.classList.add("ml-syntax-tab--active");
        pane.classList.add("ml-syntax-pane--visible");
      });
    });
  }

  private renderLanguageList(container: HTMLElement): void {
    container.empty();

    this.plugin.settings.languages.forEach((lang, index) => {
      const row = new Setting(container)
        .addText((text) => {
          text
            .setPlaceholder(t("settings.code_placeholder"))
            .setValue(lang.code)
            .onChange(async (value) => {
              this.plugin.settings.languages[index].code = value.trim();
              await this.plugin.saveSettings();
              this.plugin.refreshStatusBar();
            });
          text.inputEl.addClass("ml-settings-input-code");
          text.inputEl.setAttribute("spellcheck", "false");
        })
        .addText((text) => {
          text
            .setPlaceholder(t("settings.label_placeholder"))
            .setValue(lang.label)
            .onChange(async (value) => {
              this.plugin.settings.languages[index].label = value;
              await this.plugin.saveSettings();
              this.plugin.refreshStatusBar();
            });
          text.inputEl.addClass("ml-settings-input-label");
        })
        .addButton((btn) => {
          btn
            .setIcon("trash")
            .setTooltip(t("settings.remove_language_tooltip"))
            .setClass("mod-warning")
            .onClick(async () => {
              if (this.plugin.settings.languages.length <= 1) {
                new Notice(t("notice.keep_one_language"));
                return;
              }
              this.plugin.settings.languages.splice(index, 1);
              const codes = this.plugin.settings.languages.map((l) => l.code);
              if (!codes.includes(this.plugin.settings.activeLanguage)) {
                this.plugin.settings.activeLanguage = codes[0];
              }
              await this.plugin.saveSettings();
              container.empty();
              this.renderLanguageList(container);
              this.plugin.refreshStatusBar();
            });
        });
      row.setName(t("settings.language_row", { index: index + 1 }));
    });
  }

  private renderScopeGroup(
    body: HTMLElement,
    title: string,
    hint: string,
    field: "workDirs" | "excludeDirs",
  ): void {
    const group = body.createDiv("ml-scope-group");

    const header = group.createDiv("ml-scope-group-header");
    header.createEl("strong", { text: title });
    header.createEl("span", { text: hint, cls: "ml-scope-group-hint" });

    const listEl = group.createDiv("ml-scope-list");
    try { this.renderDirList(listEl, field); } catch (e) { console.error("[mi18n] renderDirList error", e); }

    const addRow = group.createDiv("ml-settings-add-row");
    const addBtn = addRow.createEl("button", {
      text: t("settings.scope_add_dir"),
      cls: "ml-settings-add-btn",
    });
    addBtn.addEventListener("click", () => {
      this.plugin.settings[field].push("");
      void this.plugin.saveSettings().then(() => this.renderDirList(listEl, field));
    });
  }

  private renderDirList(container: HTMLElement, field: "workDirs" | "excludeDirs"): void {
    container.empty();
    const dirs = this.plugin.settings[field];

    if (dirs.length === 0) {
      container.createDiv({
        text: field === "workDirs" ? t("settings.scope_all_files") : t("settings.scope_excl_empty"),
        cls: "ml-scope-empty-hint",
      });
      return;
    }

    dirs.forEach((dir, index) => {
      let capturedInput: HTMLInputElement | null = null;
      const row = new Setting(container)
        .addText((text) => {
          text
            .setPlaceholder(t("settings.scope_dir_placeholder"))
            .setValue(dir)
            .onChange(async (value) => {
              this.plugin.settings[field][index] = value.trim().replace(/\/+$/, "");
              await this.plugin.saveSettings();
            });
          text.inputEl.addClass("ml-settings-input-wide");
          text.inputEl.addClass("ml-settings-input-mono");
          text.inputEl.setAttribute("spellcheck", "false");
          capturedInput = text.inputEl;
        })
        .addButton((btn) => {
          btn
            .setIcon("trash")
            .setTooltip(t("settings.scope_remove_dir_tooltip"))
            .setClass("mod-warning")
            .onClick(async () => {
              this.plugin.settings[field].splice(index, 1);
              await this.plugin.saveSettings();
              this.renderDirList(container, field);
            });
        });
      row.setName(t("settings.scope_dir_row", { index: index + 1 }));
      // Attach autocomplete after the row is fully built so a suggest failure
      // cannot abort the chain and leave out the delete button or row name.
      if (capturedInput) {
        try { new FolderSuggest(this.plugin.app, capturedInput); } catch { /* skip */ }
      }
    });
  }
}
