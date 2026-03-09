# i8n — Obsidian Plugin

**Languages:** [English](README.md) | [简体中文](README.zh-CN.md)

Write multiple language versions of the same content in a single Markdown file, then switch the visible language globally.

## Features

- Keep all translations in one note instead of duplicating files.
- Support four equivalent language-block syntaxes: fenced-div, Hexo tag, Markdown comment, and Obsidian comment.
- Switch language globally from ribbon, status bar, commands, or `Alt+L`.
- Apply per-note override with frontmatter `lang: <code>` or `lang: ALL`.
- Treat notes without markers as the configured default language.
- Work in Reading mode, Live Preview, and Source mode.

## Usage

### Installation

1. Install with BRAT, or manually copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/i8n/`.
2. Enable **i8n** in **Settings → Community plugins**.

### Syntax

Use any of the following block styles (mixed usage is supported):

```md
:::lang zh-CN
这是中文版本。
:::

:::lang en
This is the English version.
:::
```

```md
{% i8n zh-CN %}
这是中文版本。
{% endi8n %}
```

```md
[//]: # (lang zh-CN)
这是中文版本。
[//]: # ()
```

```md
%% lang zh-CN %%
这是中文版本。
%% end %%
```

Rules:
- Opening and closing markers must be on separate lines with no leading spaces.
- Text outside any language block is always visible.
- Language code matching is case-sensitive.

### Obsidian 插件发布后的 README 页面说明

After publishing to the Obsidian Community Plugins catalog, the plugin page reads the repository root `README.md` as the primary description page. Keep `README.md` complete and up to date, then maintain localized files such as `README.zh-CN.md` through the language navigation links.

### Translation Contribution Guide

When adding or updating localized READMEs:

- Keep section order consistent: **Features → Usage → Settings → Build → Limitations**.
- Keep terminology consistent across languages:
  - **language block**
  - **active language**
  - **default language**
  - **show all (`ALL`)**
- If a term is not translated, keep the English source term in parentheses.
- Update top language navigation links in all README files together.

## Settings

Open **Settings → i8n**:

- **Active language**: currently visible language across notes.
- **Default language**: assumed language for notes without markers.
- **Hide non-active blocks in editor**: collapse or dim hidden blocks.
- **Show language badges**: show labels above visible blocks in reading mode.
- **Configured languages**: manage language names and codes.

## Build

```bash
git clone https://github.com/your-username/obsidian-i8n
cd obsidian-i8n
npm install
npm run dev
npm run build
```

Build output: `main.js` in repository root.

## Limitations

1. Deeply nested Markdown inside language blocks can occasionally be mis-attributed.
2. Inline multilingual spans are not supported.
3. Language codes are not validated against ISO lists.
4. Mobile behavior is best-effort for some editor block replacement details.

## License

MIT

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for module boundaries and parsing flow.
