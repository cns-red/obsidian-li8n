import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MultilingualNotesPlugin from "../main";
import { t } from "./i18n";

// ─── Data structures ───────────────────────────────────────────────────────

export interface LanguageEntry {
  code: string;   // e.g. "zh-CN"
  label: string;  // e.g. "简体中文"
}

export interface MultilingualNotesSettings {
  /** Currently active language code, or "ALL" to show everything */
  activeLanguage: string;
  /** Ordered list of languages the user has configured */
  languages: LanguageEntry[];
  /** Language code to use when a note is opened fresh */
  defaultLanguage: string;
  /** Whether editing mode hides or just dims other-language blocks */
  hideInEditor: boolean;
  /** Show language selector bar at top of multilingual notes in reading mode */
  showLangHeader: boolean;
  /** Show the ribbon icon button in the left sidebar */
  showRibbon: boolean;
  /** Show the active-language indicator in the bottom status bar */
  showStatusBar: boolean;

  // ─── AI Translation ─────────────────────────────────────────────────────────
  /** OpenAI-compatible API base URL */
  aiApiBase: string;
  /** API Key for the AI service */
  aiApiKey: string;
  /** AI Model to use for translation */
  aiModel: string;
  /** System prompt for the translation task */
  aiSystemPrompt: string;
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
  showLangHeader: true,
  showRibbon: true,
  showStatusBar: true,

  aiApiBase: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiSystemPrompt: "You are an expert translator. Translate the provided Markdown text into the target language. Output ONLY the translated text, block for block, preserving all Markdown formatting, frontmatter, and code blocks exactly. Do not add any conversational filler or explain your translation.",
};

// ─── Syntax examples ────────────────────────────────────────────────────────

export const SYNTAX_EXAMPLES = [
  {
    titleKey: "settings.syntax.default_title",
    open: ":::lang zh-CN",
    close: ":::",
    noteKey: "settings.syntax.default_note",
  },
  {
    titleKey: "settings.syntax.hexo_title",
    open: "{% li8n zh-CN %}",
    close: "{% endli8n %}",
    noteKey: "settings.syntax.hexo_note",
  },
  {
    titleKey: "settings.syntax.comment_title",
    open: "[//]: # (lang zh-CN)",
    close: "[//]: # ()",
    noteKey: "settings.syntax.comment_note",
  },
  {
    titleKey: "settings.syntax.obsidian_comment_title",
    open: "%% lang zh-CN %%",
    close: "%% end %%",
    noteKey: "settings.syntax.obsidian_comment_note",
  },
] as const;

// ─── Settings Tab ──────────────────────────────────────────────────────────

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
    masthead.createEl("div", { cls: "ml-settings-masthead-icon", text: "🌍" });
    const mastheadText = masthead.createDiv("ml-settings-masthead-text");
    mastheadText.createEl("h2", { text: "Multilingual Notes · li8n" });
    mastheadText.createEl("p", { text: t("settings.plugin_tagline") });

    // ══ Section 1: Language Library ════════════════════════════════════════
    this.section(containerEl, "🌐", t("settings.section_languages"), t("settings.section_languages_desc"), (body) => {

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
        this.plugin.saveSettings().then(() => {
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
    this.section(containerEl, "🎨", t("settings.section_interface"), t("settings.section_interface_desc"), (body) => {

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
    this.section(containerEl, "🤖", t("settings.ai_translation_title"), t("settings.section_ai_desc"), (body) => {

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
          text.inputEl.style.width = "260px";
        });

      new Setting(body)
        .setName(t("settings.ai_api_key_name"))
        .setDesc(t("settings.ai_api_key_desc"))
        .addText((text) => {
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.aiApiKey)
            .onChange(async (value) => {
              this.plugin.settings.aiApiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
          text.inputEl.style.width = "260px";
        });

      new Setting(body)
        .setName(t("settings.ai_model_name"))
        .setDesc(t("settings.ai_model_desc"))
        .addText((text) => {
          text
            .setPlaceholder("gpt-4o-mini")
            .setValue(this.plugin.settings.aiModel)
            .onChange(async (value) => {
              this.plugin.settings.aiModel = value.trim() || "gpt-4o-mini";
              await this.plugin.saveSettings();
            });
          text.inputEl.style.width = "200px";
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
          text.inputEl.style.width = "100%";
          text.inputEl.style.fontFamily = "var(--font-monospace)";
          text.inputEl.style.fontSize = "12px";
        });
    });

    // ══ Section 4: Syntax Reference ════════════════════════════════════════
    this.section(containerEl, "📖", t("settings.syntax_title"), t("settings.syntax_desc"), (body) => {
      this.renderSyntaxTabs(body);

      // No-lang-marker tip
      const tip = body.createDiv("ml-settings-tip");
      const tipTitle = tip.createDiv("ml-settings-tip-title");
      tipTitle.createSpan({ text: "💡" });
      tipTitle.createEl("strong", { text: " " + t("settings.no_marker_title_short") });
      tip.createEl("p", { text: t("settings.no_marker_desc"), cls: "ml-settings-tip-body" });
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Creates a card section with a styled header and a body element passed to
   * the `fill` callback for populating with settings.
   */
  private section(
    parent: HTMLElement,
    emoji: string,
    title: string,
    desc: string,
    fill: (body: HTMLElement) => void,
  ): void {
    const card = parent.createDiv("ml-settings-section");

    const header = card.createDiv("ml-settings-section-header");
    const titleRow = header.createDiv("ml-settings-section-title-row");
    titleRow.createSpan({ cls: "ml-settings-section-emoji", text: emoji });
    titleRow.createEl("h3", { text: title, cls: "ml-settings-section-heading" });
    if (desc) {
      header.createEl("p", { text: desc, cls: "ml-settings-section-desc" });
    }

    const body = card.createDiv("ml-settings-section-body");
    fill(body);
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

      const copyBtn = pane.createEl("button", {
        text: t("settings.copy"),
        cls: "ml-syntax-copy-btn",
      });
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(sample).then(() => {
          copyBtn.textContent = t("settings.copied");
          setTimeout(() => { copyBtn.textContent = t("settings.copy"); }, 1500);
        });
      });

      // Tab switching
      tab.addEventListener("click", () => {
        tabBar.querySelectorAll(".ml-syntax-tab").forEach(t => t.classList.remove("ml-syntax-tab--active"));
        paneArea.querySelectorAll(".ml-syntax-pane").forEach(p => p.classList.remove("ml-syntax-pane--visible"));
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
          text.inputEl.style.width = "90px";
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
          text.inputEl.style.width = "130px";
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
}
