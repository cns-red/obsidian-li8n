# Architecture Overview

This plugin keeps language-marker parsing in `src/syntax.ts`, and both `src/markdownProcessor.ts` (reading mode) and `src/editorExtension.ts` (editing mode) consume those shared helpers.

`main.ts` now focuses on lifecycle wiring, while UI and command-heavy logic lives in focused modules:

- `src/ui/statusBar.ts` for status bar + language menu.
- `src/ui/outlineFilter.ts` for Outline panel filtering.
- `src/commands/languageBlocks.ts` for insertion/wrap templates.
- `src/language-state/frontmatter.ts` for frontmatter language override resolution.
