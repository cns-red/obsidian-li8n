import { App, Modal, Setting, TextAreaComponent, Notice, ButtonComponent, DropdownComponent, MarkdownRenderer } from "obsidian";
import MultilingualNotesPlugin from "../../main";
import { t } from "../i18n";
import { streamTranslation } from "../api/ai";
import { parseLangBlocks } from "../markdownProcessor";
import { LanguageEntry } from "../settings";

export class TranslationModal extends Modal {
    private plugin: MultilingualNotesPlugin;
    private sourceContent: string;
    private sourceLanguage: string;
    private targetLanguage: string;
    private noteExistingLanguages: Set<string>;

    private previewTextArea: TextAreaComponent | null = null;
    private previewRenderEl: HTMLElement | null = null;
    private sourceRenderEl: HTMLElement | null = null;
    private translateButton: ButtonComponent | null = null;
    private insertButton: ButtonComponent | null = null;
    private modeToggleBtn: ButtonComponent | null = null;

    private isEditMode: boolean = false;

    // The generated result we intend to insert
    private translatedContent: string = "";
    private isStreaming: boolean = false;

    constructor(
        app: App,
        plugin: MultilingualNotesPlugin,
        sourceContent: string,
        activeEditorLangCode: string,
        existingLanguages: Set<string>
    ) {
        super(app);
        this.plugin = plugin;
        this.sourceContent = sourceContent;
        this.noteExistingLanguages = existingLanguages;

        // Auto-select source if provided and valid. Otherwise, pick the first existing language.
        if (activeEditorLangCode && existingLanguages.has(activeEditorLangCode.toLowerCase())) {
            this.sourceLanguage = activeEditorLangCode.toLowerCase();
        } else if (existingLanguages.size > 0) {
            this.sourceLanguage = Array.from(existingLanguages)[0].toLowerCase();
        } else {
            this.sourceLanguage = plugin.settings.defaultLanguage.toLowerCase();
        }

        this.targetLanguage = "";

        // Pick a default target language that isn't already in the note
        const availableTargets = this.plugin.settings.languages.filter(l => !this.noteExistingLanguages.has(l.code.toLowerCase()));
        if (availableTargets.length > 0) {
            this.targetLanguage = availableTargets[0].code;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // Add container classes for glassmorphism styling in CSS
        this.modalEl.addClass("ml-translation-modal-window");
        contentEl.addClass("ml-translation-modal");

        contentEl.createEl("h2", { text: t("menu.smart_translate") });

        if (!this.plugin.settings.aiApiKey) {
            const w = contentEl.createDiv("ml-error-box");
            w.createEl("p", { text: t("notice.api_key_missing") || "API Key is not configured. Please go to settings first." });
            return;
        }

        // --- SOURCE LANGUAGE FILTERING ---
        // Only show languages that exist in the note
        const sourceLangsToDisplay = this.plugin.settings.languages.filter(l =>
            this.noteExistingLanguages.has(l.code.toLowerCase())
        );

        // If the note has no language blocks yet, fallback to all settings languages
        const finalSourceLangs = sourceLangsToDisplay.length > 0
            ? sourceLangsToDisplay
            : this.plugin.settings.languages;

        const settingsRow = contentEl.createDiv("ml-translation-settings-row");

        new Setting(settingsRow)
            .setName(t("settings.source_language") || "Source Language")
            .setDesc(t("settings.source_language_desc") || "Select the existing language block to translate.")
            .addDropdown(drop => {
                finalSourceLangs.forEach(l => drop.addOption(l.code, l.label));
                drop.setValue(this.sourceLanguage);
                drop.onChange(val => {
                    this.sourceLanguage = val;
                    this.updateTranslateButtonState();
                });
            });

        // --- TARGET LANGUAGE FILTERING ---
        // Only show languages that DO NOT exist in the note yet
        const targetLangsToDisplay = this.plugin.settings.languages.filter(l =>
            !this.noteExistingLanguages.has(l.code.toLowerCase())
        );

        new Setting(settingsRow)
            .setName(t("settings.target_language") || "Target Language")
            .setDesc(t("settings.target_language_desc") || "Select the language to generate a new block for.")
            .addDropdown(drop => {
                if (targetLangsToDisplay.length === 0) {
                    drop.addOption("", t("notice.fully_internationalized") || "All languages implemented");
                } else {
                    targetLangsToDisplay.forEach(l => drop.addOption(l.code, l.label));
                }
                drop.setValue(this.targetLanguage);

                drop.onChange(val => {
                    this.targetLanguage = val;
                    this.updateTranslateButtonState();
                });
            });

        const btnRow = contentEl.createDiv("ml-translate-btn-row");

        this.translateButton = new ButtonComponent(btnRow)
            .setButtonText(t("button.translate") || "Translate")
            .setCta()
            .onClick(async () => {
                await this.runStreamTranslation();
            });

        this.updateTranslateButtonState();

        const splitContainer = contentEl.createDiv("ml-translation-split");

        // Left Column: Source
        const sourceCol = splitContainer.createDiv("ml-translation-col");
        const sourceHeader = sourceCol.createDiv("ml-translation-col-header");
        sourceHeader.createEl("h4", { text: t("label.source_text") || "Source Text" });

        this.sourceRenderEl = sourceCol.createDiv("ml-markdown-preview");
        MarkdownRenderer.render(this.app, this.sourceContent || "_No source text_", this.sourceRenderEl, "", this.plugin);

        // Right Column: Target
        const targetCol = splitContainer.createDiv("ml-translation-col");
        const targetHeader = targetCol.createDiv("ml-translation-col-header");
        targetHeader.createEl("h4", { text: t("label.translation") || "Translation" });

        this.modeToggleBtn = new ButtonComponent(targetHeader)
            .setIcon("pencil")
            .setTooltip(t("tooltip.edit_translation") || "Edit Translation")
            .onClick(() => {
                this.isEditMode = !this.isEditMode;
                this.updateViewMode();
            });

        const targetContainer = targetCol.createDiv("ml-translation-target-container");

        this.previewRenderEl = targetContainer.createDiv("ml-markdown-preview");
        this.previewTextArea = new TextAreaComponent(targetContainer)
            .setPlaceholder(t("placeholder.translation_preview") || "Click Translate to generate text.")
            .setValue(this.translatedContent)
            .onChange(val => {
                this.translatedContent = val;
                this.renderPreview();
                this.updateInsertButtonState();
            });

        this.updateViewMode();

        const actionRow = contentEl.createDiv("ml-action-row");

        new ButtonComponent(actionRow)
            .setButtonText(t("button.cancel") || "Cancel")
            .onClick(() => {
                if (this.isStreaming) {
                    this.isStreaming = false; // Note: actual fetch abort logic could be added here
                }
                this.close();
            });

        this.insertButton = new ButtonComponent(actionRow)
            .setButtonText(t("button.insert") || "Insert")
            .setCta()
            .setDisabled(true)
            .onClick(() => {
                if (!this.translatedContent.trim()) {
                    new Notice(t("notice.empty_insertion") || "Cannot insert empty text.");
                    return;
                }
                this.doInsert();
            });
    }

    private updateViewMode() {
        if (!this.previewRenderEl || !this.previewTextArea || !this.modeToggleBtn) return;

        if (this.isEditMode) {
            this.previewRenderEl.style.display = "none";
            this.previewTextArea.inputEl.style.display = "block";
            this.modeToggleBtn.setIcon("eye");
            this.modeToggleBtn.setTooltip("View Markdown");
        } else {
            this.previewRenderEl.style.display = "block";
            this.previewTextArea.inputEl.style.display = "none";
            this.modeToggleBtn.setIcon("pencil");
            this.modeToggleBtn.setTooltip("Edit Translation");
        }
    }

    private renderPreview() {
        if (!this.previewRenderEl) return;
        this.previewRenderEl.empty();
        MarkdownRenderer.render(this.app, this.translatedContent || "_Generated text will appear here_", this.previewRenderEl, "", this.plugin);
    }

    private updateTranslateButtonState() {
        if (this.translateButton) {
            const hasTarget = !!this.targetLanguage;
            const hasSource = !!this.sourceLanguage;
            this.translateButton.setDisabled(!hasTarget || !hasSource || this.isStreaming);
        }
    }

    private updateInsertButtonState() {
        if (this.insertButton) {
            this.insertButton.setDisabled(this.translatedContent.trim() === "" || this.isStreaming);
        }
    }

    private async runStreamTranslation() {
        if (!this.translateButton || !this.previewTextArea || !this.insertButton) return;

        this.isStreaming = true;
        this.translatedContent = "";
        this.previewTextArea.setValue("");

        this.translateButton.setButtonText(t("button.translating") || "Translating...");
        this.updateTranslateButtonState();
        this.updateInsertButtonState();

        try {
            const sourceLangName = this.plugin.settings.languages.find((l: LanguageEntry) => l.code === this.sourceLanguage)?.label || this.sourceLanguage;
            const targetLangName = this.plugin.settings.languages.find((l: LanguageEntry) => l.code === this.targetLanguage)?.label || this.targetLanguage;

            await streamTranslation(
                this.sourceContent,
                targetLangName,
                sourceLangName,
                this.plugin.settings,
                (chunk: string) => {
                    // Update the string and the UI synchronously as chunks arrive
                    if (!this.isStreaming) return; // In case user hit cancel
                    this.translatedContent += chunk;

                    // Simple debounce for rendering to avoid lagging the UI
                    window.requestAnimationFrame(() => {
                        this.renderPreview();
                    });
                }
            );

        } catch (err: any) {
            new Notice(`Error: ${err.message}`);
        } finally {
            this.isStreaming = false;
            this.translateButton.setButtonText(t("button.regenerate") || "Regenerate");
            this.updateTranslateButtonState();
            this.previewTextArea!.setValue(this.translatedContent);
            this.renderPreview();
            this.updateInsertButtonState();
        }
    }

    private doInsert() {
        if (this.onInsertCallback) {
            this.onInsertCallback(this.translatedContent, this.targetLanguage);
        }
        this.close();
    }

    public onInsertCallback: ((text: string, targetLangCode: string) => void) | null = null;

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
