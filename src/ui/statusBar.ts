/** Status-bar and language menu rendering helpers. */

import { Menu, setIcon } from "obsidian";
import { t } from "../i18n";
import type { MultilingualNotesSettings } from "../settings";

export function getActiveLabel(settings: MultilingualNotesSettings): string {
  if (settings.activeLanguage === "ALL") return t("status_bar.all_languages");
  const lang = settings.languages.find((l) => l.code === settings.activeLanguage);
  return lang ? lang.label : settings.activeLanguage;
}

export function buildStatusBar(
  statusBarEl: HTMLElement,
  settings: MultilingualNotesSettings,
  onShowLanguageMenu: (evt: MouseEvent) => void
): void {
  statusBarEl.empty();

  const wrapper = statusBarEl.createDiv("ml-status-wrapper");
  const icon = wrapper.createSpan("ml-status-icon");
  setIcon(icon, "languages");

  const label = wrapper.createSpan("ml-status-label");
  label.textContent = getActiveLabel(settings);
  label.setAttribute("title", t("status_bar.click_to_switch"));
  label.style.cursor = "pointer";

  statusBarEl.onclick = onShowLanguageMenu;
}

export function showLanguageMenu(
  evt: MouseEvent,
  settings: MultilingualNotesSettings,
  onSetActiveLanguage: (code: string) => Promise<void>
): void {
  const menu = new Menu();

  menu.addItem((item) => {
    item
      .setTitle(t("menu.show_all_languages"))
      .setChecked(settings.activeLanguage === "ALL")
      .onClick(async () => onSetActiveLanguage("ALL"));
  });

  menu.addSeparator();

  for (const lang of settings.languages) {
    menu.addItem((item) => {
      item
        .setTitle(lang.label)
        .setChecked(settings.activeLanguage === lang.code)
        .onClick(async () => onSetActiveLanguage(lang.code));
    });
  }

  menu.showAtMouseEvent(evt);
}
