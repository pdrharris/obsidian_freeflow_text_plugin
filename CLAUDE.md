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

Build output is `main.js` at the repo root. The build (both `npm run dev` watch and `npm run
build`) **also deploys** `main.js`, `manifest.json`, and `styles.css` into the live vaults at
`<Vault>/.obsidian/plugins/obsidian_freeflow_text_plugin/` (see the `deploy-to-vault` esbuild
plugin in `esbuild.config.mjs`; override the destinations with the `OBSIDIAN_PLUGIN_DIR` env var —
a single path, or several separated by commas — or set it empty to skip). The default destinations
are three vaults: `../../Documents/Obsidian/Notes`, `../../Documents/Obsidian/Work`, and
`../../Documents/Obsidian/Theology` (each `+ /.obsidian/plugins/obsidian_freeflow_text_plugin`).
After a build just reload Obsidian (Ctrl+R) to test. The vault copy carries only those runtime
files (plus `data.json` settings) and is committed with each notes repo, so the plugin syncs to
mobile through those repos. The pen UI can't be driven from the CLI; interactive write/erase/cursor
tests require a human in Obsidian.

tsconfig is strict with `noUncheckedIndexedAccess` — array/index access is `T | undefined`, so
guard before use. Note `console.log` is an eslint error via `obsidianmd/rule-custom-message`.

## Architecture

This plugin lets users write handwriting directly in Obsidian notes. Handwriting is stored as
`fii-ink` fenced code blocks whose body is a serialized `InkDocument` JSON object
(`version: 4`, the compact packed-point wire format; older v2/v3 formats are no longer
readable — see the header of `src/ink/doc.ts`).

### Data model (`src/ink/doc.ts`)

The document is a **flowing-text logical tree**, not a flat coordinate soup:

- `InkDocument.lines: InkLine[]` — paragraphs/lines (line breaks are structure, not markers)
- `InkLine.words: InkWord[]` — a line is an ordered list of words
- `InkLine.indent?: number` / `InkLine.bullet?: boolean` — optional **list structure**: an indent
  level (0..`MAX_INDENT_LEVEL`) and whether to draw a list bullet. Device-independent (no pixels);
  `layout.ts` turns them into a left inset + a `BulletMark`. Continuation (wrapped) rows hang to the
  same inset so they align under the first word, not the bullet.
- `InkWord.strokes: InkStroke[]` — a word is a **rigid cluster** of pen strokes
- `InkStroke.points: InkPoint[]` — in a word-local space; **point Y is baseline-relative**

No absolute screen positions are stored. Intra-word geometry is preserved, but inter-word gaps
and line height are **layout constants**, computed at render time. `meta.cursor: InkCursor`
(`{line, word}`, an insertion slot) and `meta.selection: InkSelection | null` are the single
source of truth for caret/selection and are persisted. `meta.widthScale?: number` is an optional
per-block display width (a fraction 0.3–1 of the content column) set by dragging the block's
right-edge handle; when absent the block uses the global "Displayed line width" default. It is
device-independent (a fraction, not px) so it survives sync between desktop and iPad.

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
`eraseAtCursor`, `deleteSelection`. Copy/cut/paste go through `extractSelection` (selection →
`InkFragment`) and `insertFragmentAtCursor`, with the fragment held in the process-wide in-app
clipboard (`clipboard.ts`) so it survives across blocks/notes within a session. **List structure**:
`indentLines(doc, ±1)` and `toggleBulletAtCursor` act on the cursor's line, or every line a
selection spans; `splitLineAtCursor` (newline) inherits the source line's indent+bullet so lists
continue, and newline on an *empty* bullet ends the list (drops the bullet in place). The drawer's
toolbar exposes these as •/⇤/⇥ buttons; the drawer strip itself doesn't render the indent/bullet (it's
a single-line capture surface) — the structure shows in the inline block.

### Module responsibilities

| File | Responsibility |
|---|---|
| `src/main.ts` | Plugin lifecycle, adaptive metrics (viewport-responsive sizing), runtime CSS, diagnostics commands |
| `src/settings.ts` | `FreeFlowInkSettings` interface, defaults, settings tab UI |
| `src/ink/doc.ts` | Model types, `parseInkDocument`/`serializeInkDocument` (v4 wire format), geometry + cursor/selection helpers |
| `src/ink/layout.ts` | `layoutDocument` — pure layout engine + hit-testing (the single geometry source of truth) |
| `src/ink/edit.ts` | Logical editing operations (tree splices) shared by the drawer |
| `src/ink/render.ts` | Canvas painting: `drawInlineCanvas`, `inlineLayout` (shared by render + click hit-testing), `drawLaidStroke` (variable-width when points carry `w`), `wordUnderline`/`drawUnderline` |
| `src/ink/drawer.ts` | `InkDrawer` — the floating writing panel; pointer/touch input, stroke capture → source coords → `edit.ts`; holds the current pen style (colour/bold/underline) |
| `src/ink/blocks.ts` | `InkBlockRegistry` — registers the `fii-ink` processor, mounts inline canvases, bridges to the singleton drawer |
| `src/ink/palette.ts` | `INK_PALETTE` (swatch colours) + `openColorPopup` — the floating colour picker shared by the drawer pen and inline recolour |
| `src/ink/clipboard.ts` | Process-wide in-app `InkFragment` clipboard shared by inline view + drawer for copy/cut/paste across blocks/notes |
| `src/ink/storage.ts` | `persistInkCodeBlock` — serializes and splices the updated JSON back into the vault file |

### Key design decisions

**Singleton drawer**: One `InkDrawer` for the whole plugin. A `DrawerSession` (`{key, doc,
onContentChanged, onCursorChanged, onClose}`) associates it with the active block.

**Inline vs. drawer**: Each block renders a read-only inline canvas; clicking places the cursor
(via `inlineLayout` + `cursorFromPoint`); double-click / Open launches the drawer overlay. The
drawer renders the laid-out document scrolled to follow the caret, captures strokes, converts
them to source coordinates, and inserts them via `edit.ts`. On close it re-renders and saves.

**Styling**: `InkStroke` carries `color`, `bold?`, `underline?`. The drawer holds a current
**pen** (colour/bold/underline) applied to new strokes; the inline meta row restyles the active
selection retroactively via `applyStyleToSelection`/`selectionStyleFlags` (`edit.ts`). Bold is a
render-time width multiplier; underline is drawn per word under its underlined strokes. **Velocity
width** is render-time and toggleable (`settings.velocityWidth`): when on, `layoutDocument`
attaches a per-point width (`LaidPoint.w`) derived from pen speed (self-normalised per stroke) and
`drawLaidStroke` draws a width-varying ribbon. No model change is needed for any of these.

**Saving**: `storage.ts` uses `SectionInfo` line numbers for a precise splice, with a fallback
regex search. Saves are blocked above `hardBlockLimitKb`. Persistence is format-agnostic — it
just splices an opaque serialized string.

**Cross-platform input**: the drawer uses pointer events with `setPointerCapture` on
desktop/Android; on iOS (`Platform.isIosApp`) `allowAnyNonMousePointer` accepts touch input and
capture is skipped.
