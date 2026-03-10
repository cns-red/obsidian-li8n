import { App, MarkdownView, WorkspaceLeaf } from "obsidian";
import type MultilingualNotesPlugin from "../main";

export class CompareManager {
    private activeComparisonLeaves = new Set<WorkspaceLeaf>();
    /** Language active on the primary leaf before the comparison session began. */
    private preComparisonLanguage: string | null = null;

    /**
     * True while startOrUpdateComparison() is actively constructing splits.
     * Used by main.ts to suppress layout-change → refreshAllViews() bursts
     * that would corrupt language state mid-setup.
     */
    public isSettingUp = false;

    constructor(private app: App, private plugin: MultilingualNotesPlugin) { }

    public getActiveComparisonLanguages(): Set<string> {
        const langs = new Set<string>();
        for (const leaf of this.activeComparisonLeaves) {
            langs.add(this.plugin.getEffectiveLanguageForLeaf(leaf));
        }
        return langs;
    }

    /**
     * Initializes or updates a comparison session for the given active leaf
     * against the selected languages.
     *
     * @param primaryLeaf The original leaf the user clicked the status bar from.
     * @param selectedLangs Array of language codes (e.g. ['zh-cn', 'en'])
     */
    async startOrUpdateComparison(primaryLeaf: WorkspaceLeaf, selectedLangs: string[]): Promise<void> {
        const file = (primaryLeaf.view as MarkdownView).file;
        if (!file) return;

        // If reusing an existing comparison session, ensure we use its true primary leaf
        // otherwise closing splits might detach the wrong window.
        let actualPrimary = primaryLeaf;
        if (this.activeComparisonLeaves.has(primaryLeaf)) {
            const leavesArray = Array.from(this.activeComparisonLeaves);
            actualPrimary = leavesArray[0];
        } else {
            // New comparison session, save the primary leaf's language
            this.preComparisonLanguage = this.plugin.getEffectiveLanguageForLeaf(actualPrimary);
        }

        // Suppress layout-change → refreshAllViews() during the entire setup
        // so intermediate layout-change events don't corrupt leaf language state.
        this.isSettingUp = true;
        try {
            // Clear and clean up any existing comparison session
            this.endComparison(false);

            this.activeComparisonLeaves.add(actualPrimary);

            // If only one language is selected, just use the primary leaf
            if (selectedLangs.length === 1) {
                await this.plugin.setLanguageForSpecificLeaf(actualPrimary, selectedLangs[0]);
                return;
            }

            // Force the actual primary leaf into reading (preview) mode for optimal rendering
            const primaryViewState = actualPrimary.getViewState();
            if (primaryViewState.type === "markdown" && primaryViewState.state) {
                primaryViewState.state.mode = "preview";
                await actualPrimary.setViewState(primaryViewState);
            }

            // Assign the first selected language to the primary leaf
            await this.plugin.setLanguageForSpecificLeaf(actualPrimary, selectedLangs[0]);

            // For the remaining languages, spawn new vertical splits
            for (let i = 1; i < selectedLangs.length; i++) {
                const lang = selectedLangs[i];

                const newLeaf = this.app.workspace.getLeaf("split", "vertical");

                // Register the language override BEFORE opening the file so that
                // post-processors running synchronously during openFile() can read it
                // via spawningLanguage (set below) for detached elements.
                const resolvedLang = lang !== "ALL"
                    ? this.plugin.settings.languages.find(l => l.code.toLowerCase() === lang.toLowerCase())?.code ?? lang
                    : "ALL";

                // When we spawn the leaf, its view isn't fully set up with a file yet. We'll set the initial override without a filepath
                // and it will get updated appropriately later.
                this.plugin.leafLanguageOverrides.set(newLeaf, { code: resolvedLang, filePath: file.path });

                // Hint for post-processors that run during the synchronous portion
                // of openFile() while elements are still detached from the DOM.
                this.plugin.spawningLanguage = resolvedLang;
                await newLeaf.openFile(file, { active: false, state: { mode: "preview" } });
                this.plugin.spawningLanguage = null;

                this.activeComparisonLeaves.add(newLeaf);
            }

            this.setupScrollSync();
        } finally {
            this.isSettingUp = false;
        }
    }

    /**
     * Closes all spawned comparison leaves (except the primary one).
     */
    endComparison(returnToAllMode: boolean = false): void {
        if (this.activeComparisonLeaves.size === 0) return;

        const leavesArray = Array.from(this.activeComparisonLeaves);
        // The first one is our primary leaf
        const primaryLeaf = leavesArray[0];

        // Detach all spawned leaves
        for (let i = 1; i < leavesArray.length; i++) {
            leavesArray[i].detach();
        }

        this.activeComparisonLeaves.clear();
        this.removeScrollSync();

        if (returnToAllMode && primaryLeaf) {
            const restoreLang = this.preComparisonLanguage || "ALL";
            this.plugin.setLanguageForSpecificLeaf(primaryLeaf, restoreLang);
            this.app.workspace.setActiveLeaf(primaryLeaf, { focus: true });
        }
    }

    // --- Scroll Synchronization ---

    private isSyncingScroll = false;
    private scrollHandlers = new Map<HTMLElement, (e: Event) => void>();

    private setupScrollSync(): void {
        this.removeScrollSync(); // Clean up old handlers just in case

        if (this.activeComparisonLeaves.size < 2) return;

        for (const leaf of this.activeComparisonLeaves) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) continue;

            // We need to sync Both the editor scroller and the preview scroller
            const scrollers: HTMLElement[] = [];

            const previewEl = view.containerEl.querySelector(".markdown-preview-view") as HTMLElement;
            if (previewEl) scrollers.push(previewEl);

            const cmScrollEl = view.containerEl.querySelector(".cm-scroller") as HTMLElement;
            if (cmScrollEl) scrollers.push(cmScrollEl);

            for (const el of scrollers) {
                const handler = (e: Event) => this.onScroll(e, el);
                this.scrollHandlers.set(el, handler);
                el.addEventListener("scroll", handler);
            }
        }
    }

    private removeScrollSync(): void {
        for (const [el, handler] of this.scrollHandlers) {
            el.removeEventListener("scroll", handler);
        }
        this.scrollHandlers.clear();
    }

    private onScroll(e: Event, sourceEl: HTMLElement): void {
        if (this.isSyncingScroll) return;

        // Calculate percentage based on scrollable area minus the viewport height
        const maxScroll = sourceEl.scrollHeight - sourceEl.clientHeight;
        if (maxScroll <= 0) return;

        const percentage = sourceEl.scrollTop / maxScroll;

        this.isSyncingScroll = true;

        // Apply to all other registered scroller elements
        for (const targetEl of this.scrollHandlers.keys()) {
            if (targetEl !== sourceEl) {
                const targetMaxScroll = targetEl.scrollHeight - targetEl.clientHeight;
                if (targetMaxScroll > 0) {
                    targetEl.scrollTop = percentage * targetMaxScroll;
                }
            }
        }

        // Debounce resetting the sync flag to allow scroll events to fire and be ignored
        requestAnimationFrame(() => {
            this.isSyncingScroll = false;
        });
    }
}
