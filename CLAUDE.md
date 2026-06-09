# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Watch build (outputs main.js with inline sourcemaps)
npm run build        # Production build (minified, no sourcemaps, type-checks first)
npm run lint         # ESLint with eslint-plugin-obsidianmd
npm test             # Headless tests for the pure logic (doc/edit/layout), bundled via esbuild
```

Build output is `main.js` at the repo root. This repository folder **is** the installed plugin
inside the live vault (`<Vault>/.obsidian/plugins/...`), so after `npm run build` just reload
Obsidian (Ctrl+R) to test. The pen UI can't be driven from the CLI; interactive write/erase/
cursor tests require a human in Obsidian.

tsconfig is strict with `noUncheckedIndexedAccess` — array/index access is `T | undefined`, so
guard before use. Note `console.log` is an eslint error via `obsidianmd/rule-custom-message`.

## Architecture

This plugin lets users write handwriting directly in Obsidian notes. Handwriting is stored as
`fii-ink` fenced code blocks whose body is a serialized `InkDocument` JSON object
(`version: 2`).

### Data model (`src/ink/doc.ts`)

The document is a **flowing-text logical tree**, not a flat coordinate soup:

- `InkDocument.lines: InkLine[]` — paragraphs/lines (line breaks are structure, not markers)
- `InkLine.words: InkWord[]` — a line is an ordered list of words
- `InkWord.strokes: InkStroke[]` — a word is a **rigid cluster** of pen strokes
- `InkStroke.points: InkPoint[]` — in a word-local space; **point Y is baseline-relative**

No absolute screen positions are stored. Intra-word geometry is preserved, but inter-word gaps
and line height are **layout constants**, computed at render time. `meta.cursor: InkCursor`
(`{line, word}`, an insertion slot) and `meta.selection: InkSelection | null` are the single
source of truth for caret/selection and are persisted.

### Layout engine (`src/ink/layout.ts`)

`layoutDocument(doc, config)` is a **pure function** and the single source of truth for all
geometry. It returns placed strokes in CSS px plus hit-testing: `cursorFromPoint`, `caretRect`,
`rangeRects`. Both the inline view and the drawer consume it, so they can never disagree. Glyph
scale is driven by `targetLineHeightCss` and is independent of wrap width, so the drawer can
render large "write big" glyphs with no soft-wrap (`contentWidthCss: Infinity`) while the inline
view renders small glyphs that wrap to the note width.

### Editing (`src/ink/edit.ts`)

Every edit is a **tree splice** followed by a relayout — there is no coordinate patching.
`insertWordAtCursor`, `appendStrokeToCurrentWord`, `splitLineAtCursor` (newline),
`eraseAtCursor`, `deleteSelection`.

### Module responsibilities

| File | Responsibility |
|---|---|
| `src/main.ts` | Plugin lifecycle, adaptive metrics (viewport-responsive sizing), runtime CSS, diagnostics commands |
| `src/settings.ts` | `FreeFlowInkSettings` interface, defaults, settings tab UI |
| `src/ink/doc.ts` | v2 model types, `parseInkDocument`/`serializeInkDocument`, geometry + cursor/selection helpers |
| `src/ink/layout.ts` | `layoutDocument` — pure layout engine + hit-testing (the single geometry source of truth) |
| `src/ink/edit.ts` | Logical editing operations (tree splices) shared by the drawer |
| `src/ink/render.ts` | Canvas painting: `drawInlineCanvas`, `inlineLayout` (shared by render + click hit-testing), `drawLaidStroke` |
| `src/ink/drawer.ts` | `InkDrawer` — the floating writing panel; pointer/touch input, stroke capture → source coords → `edit.ts` |
| `src/ink/blocks.ts` | `InkBlockRegistry` — registers the `fii-ink` processor, mounts inline canvases, bridges to the singleton drawer |
| `src/ink/storage.ts` | `persistInkCodeBlock` — serializes and splices the updated JSON back into the vault file |

### Key design decisions

**Singleton drawer**: One `InkDrawer` for the whole plugin. A `DrawerSession` (`{key, doc,
onContentChanged, onCursorChanged, onClose}`) associates it with the active block.

**Inline vs. drawer**: Each block renders a read-only inline canvas; clicking places the cursor
(via `inlineLayout` + `cursorFromPoint`); double-click / Open launches the drawer overlay. The
drawer renders the laid-out document scrolled to follow the caret, captures strokes, converts
them to source coordinates, and inserts them via `edit.ts`. On close it re-renders and saves.

**Saving**: `storage.ts` uses `SectionInfo` line numbers for a precise splice, with a fallback
regex search. Saves are blocked above `hardBlockLimitKb`. Persistence is format-agnostic — it
just splices an opaque serialized string.

**Cross-platform input**: the drawer uses pointer events with `setPointerCapture` on
desktop/Android; on iOS (`Platform.isIosApp`) `allowAnyNonMousePointer` accepts touch input and
capture is skipped.
