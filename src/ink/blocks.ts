import {
	App,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
} from 'obsidian';
import { InkDrawer } from './drawer';
import {
	INK_CODE_BLOCK_LANGUAGE,
	InkDocument,
	InkWord,
	clampCursor,
	clampWidthScale,
	fragmentIsEmpty,
	parseInkDocument,
	selectionIsEmpty,
	serializeInkDocument,
} from './doc';
import {
	applyStyleToSelection,
	deleteSelection,
	extractSelection,
	insertFragmentAtCursor,
	selectionStyleFlags,
	toggleLineChecked,
} from './edit';
import { getClipboard, setClipboard } from './clipboard';
import { drawInlineCanvas, inlineLayout, InlineRenderOptions, StrokeNib } from './render';
import { ColorPopupHandle, DEFAULT_INK_COLOR, openColorPopup } from './palette';
import { persistInkCodeBlock, removeInkCodeBlock, SectionInfoLike } from './storage';
import { InkToolbar, ToolbarTarget } from './toolbar';

const SAVE_DEBOUNCE_MS = 320;

// The ink colour at the caret: the colour of the nearest stroke just before the cursor (so the
// swatch previews "what you're writing in here"), falling back to the next stroke to the right,
// then the default. Used to make the inline recolour button's swatch informative.
function colorAtCursor(doc: InkDocument): string {
	const cursor = clampCursor(doc.meta.cursor, doc.lines);
	const lastColor = (word: InkWord | undefined): string | null => {
		const stroke = word?.strokes[word.strokes.length - 1];
		return stroke ? stroke.color : null;
	};
	const line = doc.lines[cursor.line];
	if (line) {
		for (let w = Math.min(cursor.word, line.words.length) - 1; w >= 0; w -= 1) {
			const color = lastColor(line.words[w]);
			if (color) {
				return color;
			}
		}
		for (let w = cursor.word; w < line.words.length; w += 1) {
			const color = lastColor(line.words[w]);
			if (color) {
				return color;
			}
		}
	}
	return DEFAULT_INK_COLOR;
}

function confirmModal(app: App, title: string, body: string, confirmText: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		modal.setTitle(title);
		modal.contentEl.createEl('p', { text: body });
		const row = modal.contentEl.createDiv({ cls: 'freeflow-ink-confirm-row' });
		const cancelEl = row.createEl('button', { text: 'Cancel' });
		const confirmEl = row.createEl('button', { text: confirmText, cls: 'mod-warning' });
		let decided = false;
		const finish = (value: boolean): void => {
			decided = true;
			resolve(value);
			modal.close();
		};
		cancelEl.addEventListener('click', () => finish(false));
		confirmEl.addEventListener('click', () => finish(true));
		modal.onClose = (): void => {
			if (!decided) {
				resolve(false);
			}
		};
		modal.open();
	});
}

export class InkBlockRegistry {
	private readonly plugin: Plugin;
	private readonly drawer: InkDrawer;
	private readonly getWrapWidthWorld: () => number;
	private readonly getWordGapScale: () => number;
	private readonly getRenderLineHeightScale: () => number;
	private readonly getRenderStrokeFillScale: () => number;
	private readonly getShowWritingLine: () => boolean;
	private readonly setShowWritingLine: (value: boolean) => void;
	private readonly getVelocityWidth: () => boolean;
	private readonly getPressureWidth: () => boolean;
	private readonly getTaperStrokeEnds: () => boolean;
	private readonly getStrokeWeight: () => number;
	private readonly getNib: () => StrokeNib | null;
	private readonly getSmoothing: () => number;
	private readonly getMatchTextWidth: () => boolean;
	private readonly getWidthFraction: () => number;
	private readonly getSoftBlockLimitBytes: () => number;
	private readonly getHardBlockLimitBytes: () => number;
	private readonly getShowSoftLimitNotice: () => boolean;
	private readonly toolbar: InkToolbar | null;
	private readonly getUnifiedToolbar: () => boolean;
	private activeKey: string | null = null;
	// Re-render callbacks for every mounted inline canvas (edit + reading), so a global toggle like
	// the writing-line guide updates all visible blocks at once.
	private readonly inlineRefreshers = new Set<() => void>();

	constructor(
		plugin: Plugin,
		drawer: InkDrawer,
		getWrapWidthWorld: () => number,
		getWordGapScale: () => number,
		getRenderLineHeightScale: () => number,
		getRenderStrokeFillScale: () => number,
		getShowWritingLine: () => boolean,
		setShowWritingLine: (value: boolean) => void,
		getVelocityWidth: () => boolean,
		getPressureWidth: () => boolean,
		getTaperStrokeEnds: () => boolean,
		getStrokeWeight: () => number,
		getNib: () => StrokeNib | null,
		getSmoothing: () => number,
		getMatchTextWidth: () => boolean,
		getWidthFraction: () => number,
		getSoftBlockLimitBytes: () => number,
		getHardBlockLimitBytes: () => number,
		getShowSoftLimitNotice: () => boolean,
		toolbar: InkToolbar | null,
		getUnifiedToolbar: () => boolean,
	) {
		this.plugin = plugin;
		this.drawer = drawer;
		this.getWrapWidthWorld = getWrapWidthWorld;
		this.getWordGapScale = getWordGapScale;
		this.getRenderLineHeightScale = getRenderLineHeightScale;
		this.getRenderStrokeFillScale = getRenderStrokeFillScale;
		this.getShowWritingLine = getShowWritingLine;
		this.setShowWritingLine = setShowWritingLine;
		this.getVelocityWidth = getVelocityWidth;
		this.getPressureWidth = getPressureWidth;
		this.getTaperStrokeEnds = getTaperStrokeEnds;
		this.getStrokeWeight = getStrokeWeight;
		this.getNib = getNib;
		this.getSmoothing = getSmoothing;
		this.getMatchTextWidth = getMatchTextWidth;
		this.getWidthFraction = getWidthFraction;
		this.getSoftBlockLimitBytes = getSoftBlockLimitBytes;
		this.getHardBlockLimitBytes = getHardBlockLimitBytes;
		this.getShowSoftLimitNotice = getShowSoftLimitNotice;
		this.toolbar = toolbar;
		this.getUnifiedToolbar = getUnifiedToolbar;
	}

	refreshAllInline(): void {
		for (const refresh of this.inlineRefreshers) {
			refresh();
		}
	}

	register(): void {
		this.plugin.registerMarkdownCodeBlockProcessor(
			INK_CODE_BLOCK_LANGUAGE,
			(source, el, ctx) => {
				this.mountBlock(source, el, ctx);
			},
		);
	}

	private renderOptions(): InlineRenderOptions {
		return {
			wrapWidth: this.getWrapWidthWorld(),
			wordGapScale: this.getWordGapScale(),
			renderLineHeightScale: this.getRenderLineHeightScale(),
			renderStrokeFillScale: this.getRenderStrokeFillScale(),
			showWritingLine: this.getShowWritingLine(),
			velocityWidth: this.getVelocityWidth(),
			pressureWidth: this.getPressureWidth(),
			taperStrokeEnds: this.getTaperStrokeEnds(),
			strokeWeight: this.getStrokeWeight(),
			nib: this.getNib(),
			smoothing: this.getSmoothing(),
		};
	}

	// The block's canvas always wraps to its own container width (the box we size in
	// `applyBlockWidth`), so the global wrap cap must never shrink it further.
	private blockRenderOptions(): InlineRenderOptions {
		return { ...this.renderOptions(), wrapWidth: Number.POSITIVE_INFINITY };
	}

	// Size the block box. Precedence:
	//   1. An explicit per-block width (the drag handle) — a fraction of the readable-line column.
	//   2. "Match text width" on — the natural column width, lined up with surrounding text.
	//   3. Otherwise — a fraction of the full editor-pane width (the slider), broken out of the
	//      readable-line column and centred.
	//
	// Centring is computed from WIDTHS ONLY (no getBoundingClientRect of positions): the block's
	// containing column (parent) is centred in the pane by Obsidian, so centring the block on its
	// column — margin-left = (columnWidth - blockWidth) / 2 — also centres it in the pane. Using
	// stable widths (not positions) avoids the live-preview timing bug where a position measured
	// before layout settles bakes in a wrong offset and the block's clip shows only a central strip.
	private applyBlockWidth(containerEl: HTMLElement, doc: InkDocument): void {
		const clearBreakout = (): void => {
			containerEl.classList.remove('is-fill-width');
			containerEl.style.removeProperty('margin-left');
			containerEl.style.removeProperty('max-width');
		};
		const ws = doc.meta.widthScale;
		if (typeof ws === 'number') {
			clearBreakout();
			containerEl.setCssStyles({ width: `${(clampWidthScale(ws) * 100).toFixed(2)}%` });
			return;
		}
		const pane = this.getMatchTextWidth()
			? null
			: containerEl.closest('.markdown-preview-view, .cm-scroller');
		const parent = containerEl.parentElement;
		if (!(pane instanceof HTMLElement) || !parent || pane.clientWidth < 240 || parent.clientWidth < 80) {
			clearBreakout();
			containerEl.setCssStyles({ width: '' });
			return;
		}
		const fraction = Math.max(0.3, Math.min(1, this.getWidthFraction()));
		const widthPx = Math.round((pane.clientWidth - 16) * fraction); // small inset off the pane edges
		const marginLeft = Math.round((parent.clientWidth - widthPx) / 2);
		containerEl.classList.add('is-fill-width');
		containerEl.setCssStyles({ width: `${widthPx}px`, maxWidth: 'none', marginLeft: `${marginLeft}px` });
		releaseAncestorContainment(containerEl, pane);
	}

	private mountBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
		attempt = 0,
	): void {
		const drawer = this.drawer;
		const toolbar = this.toolbar;
		const inlineRefreshers = this.inlineRefreshers;
		const setActiveKey = (value: string | null): void => {
			this.activeKey = value;
		};
		const isActiveKey = (value: string): boolean => this.activeKey === value;

		// Clear first so a retry (see the section-info handling below) re-renders cleanly rather than
		// stacking a second block into the same element.
		el.empty();
		const containerEl = el.createDiv({ cls: 'freeflow-ink-block' });
		const parsed = this.parseWithError(source, containerEl);
		if (!parsed) {
			return;
		}
		const documentModel = parsed;
		documentModel.meta.cursor = clampCursor(documentModel.meta.cursor, documentModel.lines);

		// Reading mode (and previews/exports): render read-only, no chrome, no border.
		if (this.isReadingMode(el, ctx)) {
			this.mountReadOnly(containerEl, documentModel, el, ctx);
			return;
		}

		const section = toSectionInfoLike(ctx.getSectionInfo(el));
		if (!section) {
			// Right after switching from Reading to editing, the editor's section info is briefly
			// unavailable; retry on later frames before giving up. Without this the block mounts with no
			// controls until the note is reopened (the user's workaround was switching notes and back).
			if (attempt < 10) {
				window.setTimeout(() => this.mountBlock(source, el, ctx, attempt + 1), 50);
			} else {
				containerEl.createDiv({
					cls: 'freeflow-ink-block-error',
					text: 'Unable to attach fii-ink editor in this view. Re-open the note and try again.',
				});
			}
			return;
		}
		let showInlineCaret = false;
		let selectMode = false;
		let selecting = false;
		let colorPopup: ColorPopupHandle | null = null;
		let lastSelectionColor = DEFAULT_INK_COLOR;
		let saveTimeout = 0;
		let isDisposed = false;
		let pendingInlineRefreshWhileActive = false;
		let softWarned = false;
		let hardWarned = false;
		const blockKey = `${ctx.sourcePath}:${section.lineStart}:${section.lineEnd}`;

		this.applyBlockWidth(containerEl, documentModel);
		const canvasEl = containerEl.createEl('canvas', {
			cls: 'freeflow-ink-inline-canvas',
			attr: { role: 'button', 'aria-label': 'Open freeflow ink drawer' },
		});
		// Drag handle on the block's right edge for per-block width (see resize handlers below).
		const resizeHandleEl = containerEl.createDiv({
			cls: 'freeflow-ink-resize-handle',
			attr: { 'aria-label': 'Drag to resize block width', title: 'Drag to resize width' },
		});
		const metaRowEl = containerEl.createDiv({ cls: 'freeflow-ink-meta' });
		// Plain glyph symbols rather than setIcon: Lucide SVGs render blank on some mobile builds,
		// and glyphs inherit the (visible) button text colour, so a control is never invisible.
		const makeMetaButton = (glyph: string, label: string): HTMLButtonElement => {
			const btn = metaRowEl.createEl('button', { cls: 'freeflow-ink-meta-action' });
			btn.type = 'button';
			btn.setAttribute('aria-label', label);
			btn.title = label;
			btn.setText(glyph);
			return btn;
		};
		// Layout: delete on the far left (set apart), then a spacer, then the tools, with the
		// drawer-open button last so it always sits on the far right and is easy to find.
		const deleteButtonEl = makeMetaButton('🗑', 'Delete handwriting block');
		deleteButtonEl.classList.add('is-danger');
		const hintEl = metaRowEl.createSpan({ text: 'Tap to place cursor', cls: 'freeflow-ink-meta-hint' });
		const writingLineButtonEl = makeMetaButton('☰', 'Toggle writing lines');
		const selectButtonEl = makeMetaButton('⬚', 'Select words');
		const boldButtonEl = makeMetaButton('B', 'Bold selection');
		boldButtonEl.classList.add('is-bold-glyph');
		const underlineButtonEl = makeMetaButton('U', 'Underline selection');
		underlineButtonEl.classList.add('is-underline-glyph');
		const colorButtonEl = metaRowEl.createEl('button', {
			cls: 'freeflow-ink-meta-action freeflow-ink-color-btn',
		});
		colorButtonEl.type = 'button';
		colorButtonEl.setAttribute('aria-label', 'Recolour selection');
		colorButtonEl.title = 'Recolour selection';
		const colorSwatchEl = colorButtonEl.createSpan({ cls: 'freeflow-ink-color-btn-swatch' });
		// Set both: background-color is the desktop path; `color` drives the iPad box-shadow fill.
		const paintSwatch = (color: string): void => {
			colorSwatchEl.style.backgroundColor = color;
			colorSwatchEl.style.color = color;
		};
		paintSwatch(lastSelectionColor);
		const copyButtonEl = makeMetaButton('⧉', 'Copy');
		const cutButtonEl = makeMetaButton('✂', 'Cut');
		const pasteButtonEl = makeMetaButton('📋', 'Paste');
		const actionEl = makeMetaButton('✏️', 'Open drawer');

		const updateMetaButtons = (): void => {
			const hasSelection = !selectionIsEmpty(documentModel.meta.selection);
			writingLineButtonEl.classList.toggle('is-active', this.getShowWritingLine());
			selectButtonEl.classList.toggle('is-active', selectMode);
			copyButtonEl.disabled = !hasSelection;
			cutButtonEl.disabled = !hasSelection;
			boldButtonEl.disabled = !hasSelection;
			underlineButtonEl.disabled = !hasSelection;
			colorButtonEl.disabled = !hasSelection;
			pasteButtonEl.disabled = fragmentIsEmpty(getClipboard());
			// The swatch previews the colour at the caret so it's a useful indicator even with no
			// selection (when the recolour action itself is disabled).
			paintSwatch(colorAtCursor(documentModel));
			if (hasSelection) {
				const flags = selectionStyleFlags(documentModel, documentModel.meta.selection!);
				boldButtonEl.classList.toggle('is-active', flags.allBold);
				underlineButtonEl.classList.toggle('is-active', flags.allUnderline);
			} else {
				boldButtonEl.classList.remove('is-active');
				underlineButtonEl.classList.remove('is-active');
			}
			hintEl.textContent = selectMode ? 'Drag to select words' : 'Tap to place cursor';
			this.toolbar?.refresh(); // mirror selection/cursor state on the floating toolbar
		};

		const renderInline = (): void => {
			this.applyBlockWidth(containerEl, documentModel);
			drawInlineCanvas(
				canvasEl,
				documentModel,
				this.blockRenderOptions(),
				showInlineCaret ? documentModel.meta.cursor : null,
				documentModel.meta.selection,
			);
			updateMetaButtons();
		};
		renderInline();
		// Live preview can still be settling the column geometry on first mount; the full-width
		// sizing/centring measures the block's position, and the canvas is drawn to the block width.
		// Re-render on the next frame(s) so a premature first measurement (wrong width or margin) is
		// corrected once layout is stable — otherwise the canvas can stay at the narrow column width.
		const rerenderSoon = (): void => {
			window.requestAnimationFrame(() => {
				if (!isDisposed) {
					renderInline();
				}
			});
			window.setTimeout(() => {
				if (!isDisposed) {
					renderInline();
				}
			}, 150);
		};
		rerenderSoon();

		const flushSave = async (): Promise<void> => {
			if (isDisposed) {
				return;
			}
			const hardLimitBytes = this.getHardBlockLimitBytes();
			const softLimitBytes = Math.min(this.getSoftBlockLimitBytes(), hardLimitBytes - 1);
			const serialized = serializeInkDocument(documentModel);
			const byteSize = serialized.length;
			if (byteSize > hardLimitBytes) {
				if (!hardWarned) {
					hardWarned = true;
					new Notice(
						`Freeflow ink block is over ${formatBlockLimit(hardLimitBytes)}. Saving pauses above this hard limit.`,
					);
				}
				containerEl.classList.add('is-over-limit');
				return;
			}
			containerEl.classList.remove('is-over-limit');

			if (this.getShowSoftLimitNotice() && byteSize > softLimitBytes && !softWarned) {
				softWarned = true;
				new Notice(
					`Freeflow ink block is growing large (${formatBlockLimit(softLimitBytes)}+). You can raise this threshold in plugin settings.`,
				);
			}

			try {
				await persistInkCodeBlock(this.plugin.app, ctx.sourcePath, section, serialized);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown fii-ink save error.';
				new Notice(`FreeFlow Ink save failed: ${message}`);
			}
		};

		const scheduleSave = (): void => {
			if (saveTimeout) {
				window.clearTimeout(saveTimeout);
			}
			saveTimeout = window.setTimeout(() => {
				saveTimeout = 0;
				void flushSave();
			}, SAVE_DEBOUNCE_MS);
		};

		// Re-render the inline view from the document; defer persistence until the drawer closes
		// while it is the active block (avoids thrashing the vault file mid-stroke).
		const onChanged = (): void => {
			renderInline();
			if (isActiveKey(blockKey)) {
				pendingInlineRefreshWhileActive = true;
				return;
			}
			scheduleSave();
		};

		const openDrawer = (): void => {
			showInlineCaret = true;
			setActiveKey(blockKey);
			bindToolbar();
			drawer.open({
				key: blockKey,
				doc: documentModel,
				onContentChanged: onChanged,
				onCursorChanged: onChanged,
				onClose: () => {
					if (isActiveKey(blockKey)) {
						setActiveKey(null);
					}
					if (pendingInlineRefreshWhileActive) {
						pendingInlineRefreshWhileActive = false;
						renderInline();
					}
					void flushSave();
				},
			});
		};

		const onCanvasKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				openDrawer();
			}
		};

		const cursorAtEvent = (event: PointerEvent): ReturnType<typeof clampCursor> => {
			const rect = canvasEl.getBoundingClientRect();
			const { layout } = inlineLayout(canvasEl, documentModel, this.blockRenderOptions());
			return layout.cursorFromPoint(event.clientX - rect.left, event.clientY - rect.top);
		};

		const applyInlineEdit = (): void => {
			showInlineCaret = true;
			renderInline();
			if (isActiveKey(blockKey)) {
				drawer.refreshLayout();
				pendingInlineRefreshWhileActive = true;
				return;
			}
			scheduleSave();
		};

		// --- per-block width drag handle ---------------------------------------------------------
		let resizing = false;
		let resizePointerId: number | null = null;
		let resizeColumnWidth = 0;

		const columnWidthPx = (): number => {
			const parent = containerEl.parentElement;
			return Math.max(200, parent?.clientWidth ?? containerEl.clientWidth ?? 400);
		};
		const persistWidth = (): void => {
			if (isActiveKey(blockKey)) {
				// Drawer is open for this block; let its close flush persist the new width.
				pendingInlineRefreshWhileActive = true;
			} else {
				scheduleSave();
			}
		};
		const applyResizeAt = (clientX: number): void => {
			const left = containerEl.getBoundingClientRect().left;
			const fraction = clampWidthScale((clientX - left) / Math.max(1, resizeColumnWidth));
			documentModel.meta.widthScale = fraction;
			containerEl.setCssStyles({ width: `${(fraction * 100).toFixed(2)}%` });
			renderInline();
			if (isActiveKey(blockKey)) {
				drawer.refreshLayout();
			}
		};
		const onResizePointerDown = (event: PointerEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			resizing = true;
			resizePointerId = event.pointerId;
			resizeColumnWidth = columnWidthPx();
			containerEl.classList.add('is-resizing');
			try {
				resizeHandleEl.setPointerCapture(event.pointerId);
			} catch {
				/* capture is best-effort */
			}
		};
		const onResizePointerMove = (event: PointerEvent): void => {
			if (!resizing || resizePointerId !== event.pointerId) {
				return;
			}
			event.preventDefault();
			applyResizeAt(event.clientX);
		};
		const onResizePointerUp = (event: PointerEvent): void => {
			if (!resizing || resizePointerId !== event.pointerId) {
				return;
			}
			event.preventDefault();
			resizing = false;
			resizePointerId = null;
			containerEl.classList.remove('is-resizing');
			try {
				resizeHandleEl.releasePointerCapture(event.pointerId);
			} catch {
				/* ignore */
			}
			persistWidth();
		};
		// Double-click/tap the handle clears the per-block width (back to the global default).
		const onResizeReset = (): void => {
			delete documentModel.meta.widthScale;
			containerEl.setCssStyles({ width: '' });
			renderInline();
			if (isActiveKey(blockKey)) {
				drawer.refreshLayout();
			}
			persistWidth();
		};

		const onCanvasPointerDown = (event: PointerEvent): void => {
			if (!selectMode) {
				return;
			}
			event.preventDefault();
			const cur = cursorAtEvent(event);
			documentModel.meta.selection = { anchor: cur, focus: cur };
			documentModel.meta.cursor = cur;
			selecting = true;
			try {
				canvasEl.setPointerCapture(event.pointerId);
			} catch {
				/* capture is best-effort */
			}
			showInlineCaret = true;
			renderInline();
		};

		const onCanvasPointerMove = (event: PointerEvent): void => {
			if (!selectMode || !selecting) {
				return;
			}
			event.preventDefault();
			const focus = cursorAtEvent(event);
			if (documentModel.meta.selection) {
				documentModel.meta.selection.focus = focus;
			}
			documentModel.meta.cursor = focus;
			renderInline();
		};

		const onCanvasPointerUp = (event: PointerEvent): void => {
			if (!selectMode || !selecting) {
				return;
			}
			event.preventDefault();
			selecting = false;
			if (selectionIsEmpty(documentModel.meta.selection)) {
				documentModel.meta.selection = null; // a tap just places the cursor
			}
			renderInline();
			scheduleSave();
			if (isActiveKey(blockKey)) {
				drawer.refreshLayout();
			}
		};

		const onToggleSelect = (): void => {
			selectMode = !selectMode;
			canvasEl.style.touchAction = selectMode ? 'none' : '';
			renderInline();
		};

		// Writing-line guide is a global setting, so it persists across reading and editing mode and
		// applies to every block. Toggle it, then re-render all visible blocks (and the drawer).
		const onToggleWritingLine = (): void => {
			this.setShowWritingLine(!this.getShowWritingLine());
			this.refreshAllInline();
		};

		const onCopy = (): void => {
			if (selectionIsEmpty(documentModel.meta.selection)) {
				return;
			}
			setClipboard(extractSelection(documentModel, documentModel.meta.selection!));
			renderInline();
		};

		const onCut = (): void => {
			if (selectionIsEmpty(documentModel.meta.selection)) {
				return;
			}
			setClipboard(extractSelection(documentModel, documentModel.meta.selection!));
			deleteSelection(documentModel, documentModel.meta.selection!);
			applyInlineEdit();
		};

		const onPaste = (): void => {
			const clip = getClipboard();
			if (fragmentIsEmpty(clip)) {
				return;
			}
			insertFragmentAtCursor(documentModel, clip!);
			applyInlineEdit();
		};

		const onBold = (): void => {
			if (selectionIsEmpty(documentModel.meta.selection)) {
				return;
			}
			const flags = selectionStyleFlags(documentModel, documentModel.meta.selection!);
			applyStyleToSelection(documentModel, documentModel.meta.selection!, { bold: !flags.allBold });
			applyInlineEdit();
		};

		const onUnderline = (): void => {
			if (selectionIsEmpty(documentModel.meta.selection)) {
				return;
			}
			const flags = selectionStyleFlags(documentModel, documentModel.meta.selection!);
			applyStyleToSelection(documentModel, documentModel.meta.selection!, {
				underline: !flags.allUnderline,
			});
			applyInlineEdit();
		};

		const onColor = (): void => {
			if (selectionIsEmpty(documentModel.meta.selection)) {
				return;
			}
			if (colorPopup) {
				colorPopup.close();
				colorPopup = null;
				return;
			}
			colorPopup = openColorPopup(colorButtonEl, lastSelectionColor, (color) => {
				colorPopup = null;
				lastSelectionColor = color;
				paintSwatch(color);
				if (selectionIsEmpty(documentModel.meta.selection)) {
					return;
				}
				applyStyleToSelection(documentModel, documentModel.meta.selection!, { color });
				applyInlineEdit();
			});
		};

		const onCanvasClick = (event: MouseEvent): void => {
			bindToolbar();
			if (selectMode) {
				return; // selection is handled by the pointer drag handlers
			}
			const rect = canvasEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				showInlineCaret = true;
				renderInline();
				return;
			}
			const { layout } = inlineLayout(canvasEl, documentModel, this.blockRenderOptions());
			const cursor = layout.cursorFromPoint(event.clientX - rect.left, event.clientY - rect.top);
			documentModel.meta.cursor = cursor;
			documentModel.meta.selection = null;
			showInlineCaret = true;
			renderInline();
			if (isActiveKey(blockKey)) {
				drawer.updateCursor(blockKey, cursor);
			} else {
				scheduleSave();
			}
		};

		const onCanvasDoubleClick = (): void => {
			openDrawer();
		};

		const onActionClick = (): void => {
			openDrawer();
		};

		const onDelete = (): void => {
			void (async () => {
				const ok = await confirmModal(
					this.plugin.app,
					'Delete handwriting block?',
					'This removes the entire handwriting block from the note. It cannot be undone from here.',
					'Delete',
				);
				if (ok === false) {
					return;
				}
				// Stop any pending save and block further ones, then close the drawer if it's ours.
				if (saveTimeout) {
					window.clearTimeout(saveTimeout);
					saveTimeout = 0;
				}
				isDisposed = true;
				if (isActiveKey(blockKey)) {
					drawer.close();
				}
				try {
					await removeInkCodeBlock(this.plugin.app, ctx.sourcePath, section);
				} catch (error) {
					isDisposed = false; // delete failed; let the block keep working
					const message = error instanceof Error ? error.message : 'Unknown delete error.';
					new Notice(`FreeFlow Ink delete failed: ${message}`);
				}
			})();
		};

		// Unified floating toolbar: this block's duplicated meta-row buttons are hidden and the
		// singleton toolbar acts on the block instead. The toolbar binds to whichever block was
		// interacted with last (cursor placed / drawer opened).
		const unified = this.getUnifiedToolbar();
		const toolbarTarget: ToolbarTarget = {
			key: blockKey,
			doc: documentModel,
			applyEdit: applyInlineEdit,
			renderOnly: renderInline,
			isSelectMode: () => selectMode,
			toggleSelectMode: onToggleSelect,
			openDrawer,
		};
		const bindToolbar = (): void => {
			if (unified) {
				this.toolbar?.bind(toolbarTarget);
			}
		};
		if (unified) {
			for (const dup of [
				writingLineButtonEl,
				selectButtonEl,
				boldButtonEl,
				underlineButtonEl,
				colorButtonEl,
				copyButtonEl,
				cutButtonEl,
				pasteButtonEl,
			]) {
				dup.classList.add('is-toolbar-dup');
			}
			// Every persisted edit remounts this block (the save splices the note and the code block
			// processor re-runs). If the toolbar was bound to this block before the remount, re-bind
			// it to the fresh target so it doesn't vanish mid-interaction.
			if (this.toolbar?.wasBoundTo(blockKey)) {
				this.toolbar.bind(toolbarTarget);
			}
		}

		// Never let pointer/click events bubble out of the block into CodeMirror: a click that
		// reaches the editor places the text cursor inside the fii-ink source range, and live
		// preview then unfolds the widget into the raw JSON, where a stray keystroke can corrupt
		// the whole block. Bubble phase, so the block's own handlers (canvas, buttons) run first;
		// the colour popup's outside-click dismiss still works (document capture listener).
		const editorSuppressedEvents = [
			'pointerdown',
			'pointerup',
			'mousedown',
			'mouseup',
			'click',
			'dblclick',
			'touchstart',
			'touchend',
		] as const;
		const stopEditorPropagation = (event: Event): void => {
			event.stopPropagation();
		};
		for (const type of editorSuppressedEvents) {
			containerEl.addEventListener(type, stopEditorPropagation);
		}

		canvasEl.addEventListener('click', onCanvasClick);
		canvasEl.addEventListener('dblclick', onCanvasDoubleClick);
		canvasEl.addEventListener('keydown', onCanvasKeyDown);
		canvasEl.addEventListener('pointerdown', onCanvasPointerDown);
		canvasEl.addEventListener('pointermove', onCanvasPointerMove);
		canvasEl.addEventListener('pointerup', onCanvasPointerUp);
		canvasEl.addEventListener('pointercancel', onCanvasPointerUp);
		resizeHandleEl.addEventListener('pointerdown', onResizePointerDown);
		resizeHandleEl.addEventListener('pointermove', onResizePointerMove);
		resizeHandleEl.addEventListener('pointerup', onResizePointerUp);
		resizeHandleEl.addEventListener('pointercancel', onResizePointerUp);
		resizeHandleEl.addEventListener('dblclick', onResizeReset);
		writingLineButtonEl.addEventListener('click', onToggleWritingLine);
		selectButtonEl.addEventListener('click', onToggleSelect);
		boldButtonEl.addEventListener('click', onBold);
		underlineButtonEl.addEventListener('click', onUnderline);
		colorButtonEl.addEventListener('click', onColor);
		copyButtonEl.addEventListener('click', onCopy);
		cutButtonEl.addEventListener('click', onCut);
		pasteButtonEl.addEventListener('click', onPaste);
		actionEl.addEventListener('click', onActionClick);
		deleteButtonEl.addEventListener('click', onDelete);
		canvasEl.tabIndex = 0;

		inlineRefreshers.add(renderInline);
		// Observe the pane/column ancestor, not the block itself: in fill-width mode the block has a
		// fixed pixel width, so a pane/window resize wouldn't change the block's own box and would be
		// missed. Observing the parent also avoids a feedback loop (we resize the block, not the parent).
		const resizeObserver = new ResizeObserver(() => {
			renderInline();
		});
		resizeObserver.observe(containerEl.parentElement ?? containerEl);

		ctx.addChild(
			new (class extends MarkdownRenderChild {
				onunload(): void {
					isDisposed = true;
					toolbar?.unbind(toolbarTarget);
					inlineRefreshers.delete(renderInline);
					resizeObserver.disconnect();
					for (const type of editorSuppressedEvents) {
						containerEl.removeEventListener(type, stopEditorPropagation);
					}
					canvasEl.removeEventListener('click', onCanvasClick);
					canvasEl.removeEventListener('dblclick', onCanvasDoubleClick);
					canvasEl.removeEventListener('keydown', onCanvasKeyDown);
					canvasEl.removeEventListener('pointerdown', onCanvasPointerDown);
					canvasEl.removeEventListener('pointermove', onCanvasPointerMove);
					canvasEl.removeEventListener('pointerup', onCanvasPointerUp);
					canvasEl.removeEventListener('pointercancel', onCanvasPointerUp);
					resizeHandleEl.removeEventListener('pointerdown', onResizePointerDown);
					resizeHandleEl.removeEventListener('pointermove', onResizePointerMove);
					resizeHandleEl.removeEventListener('pointerup', onResizePointerUp);
					resizeHandleEl.removeEventListener('pointercancel', onResizePointerUp);
					resizeHandleEl.removeEventListener('dblclick', onResizeReset);
					selectButtonEl.removeEventListener('click', onToggleSelect);
					boldButtonEl.removeEventListener('click', onBold);
					underlineButtonEl.removeEventListener('click', onUnderline);
					colorButtonEl.removeEventListener('click', onColor);
					copyButtonEl.removeEventListener('click', onCopy);
					cutButtonEl.removeEventListener('click', onCut);
					pasteButtonEl.removeEventListener('click', onPaste);
					actionEl.removeEventListener('click', onActionClick);
					deleteButtonEl.removeEventListener('click', onDelete);
					colorPopup?.close();
					colorPopup = null;
					if (saveTimeout) {
						window.clearTimeout(saveTimeout);
						saveTimeout = 0;
					}
					if (isActiveKey(blockKey)) {
						drawer.close();
					}
				}
			})(el),
		);
	}

	// Decide whether this block is being rendered for Reading view (read-only) vs the editor.
	// The element is frequently not attached yet when the processor runs, so DOM ancestry alone
	// is unreliable; fall back to the active view's mode and default to editable.
	private isReadingMode(el: HTMLElement, ctx: MarkdownPostProcessorContext): boolean {
		if (el.closest('.markdown-source-view')) {
			return false;
		}
		// PDF export (and print) renders the note into a detached `.print` container that is neither
		// the source nor the reading-view wrapper. Without this it fell through to the editor path,
		// which needs section info the export DOM can't supply — so the block came out blank/errored
		// in the PDF. Treat it as read-only so the inline canvas paints for the snapshot.
		if (el.closest('.print, .markdown-rendered.markdown-preview-view')) {
			return true;
		}
		if (el.closest('.markdown-reading-view')) {
			return true;
		}
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file?.path === ctx.sourcePath) {
			return view.getMode() === 'preview';
		}
		return false; // when unsure, stay editable so the editor always works
	}

	private mountReadOnly(
		containerEl: HTMLDivElement,
		documentModel: InkDocument,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	): void {
		containerEl.classList.add('is-reading');
		this.applyBlockWidth(containerEl, documentModel);
		const inlineRefreshers = this.inlineRefreshers;
		const canvasEl = containerEl.createEl('canvas', { cls: 'freeflow-ink-inline-canvas' });
		const render = (): void => {
			this.applyBlockWidth(containerEl, documentModel);
			drawInlineCanvas(canvasEl, documentModel, this.blockRenderOptions(), null, null);
		};
		render();
		// Re-render once layout has settled so the canvas matches the final width (see editable path).
		window.requestAnimationFrame(() => render());
		inlineRefreshers.add(render);

		// Checkbox toggling is the ONE mutation reading mode supports: tap a box to (un)check it,
		// with the new state persisted to the vault. Everything else stays read-only.
		let saveTimeout = 0;
		let disposed = false;
		const persistChecked = (): void => {
			if (saveTimeout) {
				window.clearTimeout(saveTimeout);
			}
			saveTimeout = window.setTimeout(() => {
				saveTimeout = 0;
				// Section info is read at save time (it can be unavailable at mount). Without it the
				// full-file range makes persistInkCodeBlock's section splice scan the whole note, which
				// matches the FIRST ink block — correct for single-block notes, and no worse than the
				// existing regex fallback for multi-block ones.
				const section = toSectionInfoLike(ctx.getSectionInfo(el)) ?? {
					lineStart: 0,
					lineEnd: Number.MAX_SAFE_INTEGER,
				};
				persistInkCodeBlock(
					this.plugin.app,
					ctx.sourcePath,
					section,
					serializeInkDocument(documentModel),
				).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : 'Unknown fii-ink save error.';
					new Notice(`FreeFlow Ink checkbox save failed: ${message}`);
				});
			}, SAVE_DEBOUNCE_MS);
		};
		const onReadingClick = (event: MouseEvent): void => {
			if (disposed || documentModel.lines.every((line) => !line.checkbox)) {
				return;
			}
			const rect = canvasEl.getBoundingClientRect();
			const { layout } = inlineLayout(canvasEl, documentModel, this.blockRenderOptions());
			const x = event.clientX - rect.left;
			const y = event.clientY - rect.top;
			for (const box of layout.checkboxes) {
				const pad = box.size * 0.6; // generous target for fingers
				if (
					x >= box.x - pad &&
					x <= box.x + box.size + pad &&
					y >= box.y - pad &&
					y <= box.y + box.size + pad
				) {
					if (toggleLineChecked(documentModel, box.line) !== null) {
						render();
						persistChecked();
					}
					return;
				}
			}
		};
		canvasEl.addEventListener('click', onReadingClick);

		// Observe the pane ancestor (see the editable path) so fill-width blocks track pane resizes.
		const resizeObserver = new ResizeObserver(() => render());
		resizeObserver.observe(containerEl.parentElement ?? containerEl);
		ctx.addChild(
			new (class extends MarkdownRenderChild {
				onunload(): void {
					disposed = true;
					canvasEl.removeEventListener('click', onReadingClick);
					if (saveTimeout) {
						window.clearTimeout(saveTimeout);
						saveTimeout = 0;
					}
					inlineRefreshers.delete(render);
					resizeObserver.disconnect();
				}
			})(el),
		);
	}

	private parseWithError(source: string, containerEl: HTMLDivElement): InkDocument | null {
		try {
			return parseInkDocument(source);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown parse error.';
			containerEl.createDiv({
				cls: 'freeflow-ink-block-error',
				text: `Invalid fii-ink JSON: ${message}`,
			});
			containerEl.createEl('pre', {
				cls: 'freeflow-ink-block-raw',
				text: source.length > 2000 ? `${source.slice(0, 2000)}\n...` : source,
			});
			return null;
		}
	}
}

// Release CSS containment on the code-block widget ancestors between the block and the editor pane.
// CodeMirror sets `contain: paint` (inline, with !important) on the embed wrapper, which clips a
// full-width block to the readable-line column even with overflow visible — a stylesheet rule can't
// beat inline !important, so we override it inline on the element itself (inline beats inline). Only
// touches per-block widget wrappers that actually carry containment, not the shared editor scroller.
function releaseAncestorContainment(containerEl: HTMLElement, pane: HTMLElement): void {
	let el: HTMLElement | null = containerEl.parentElement;
	let guard = 0;
	while (el && el !== pane && guard < 12) {
		const contain = getComputedStyle(el).getPropertyValue('contain');
		if (contain && contain !== 'none' && contain !== 'normal') {
			// Needs inline `!important` to override CodeMirror's own inline `!important`; setCssStyles /
			// CSS classes can't express priority, so the lint rule is deliberately suppressed here.
			// eslint-disable-next-line obsidianmd/no-static-styles-assignment
			el.style.setProperty('contain', 'none', 'important');
		}
		el = el.parentElement;
		guard += 1;
	}
}

function toSectionInfoLike(value: unknown): SectionInfoLike | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const maybe = value as Partial<SectionInfoLike>;
	if (
		typeof maybe.lineStart !== 'number' ||
		typeof maybe.lineEnd !== 'number' ||
		!Number.isFinite(maybe.lineStart) ||
		!Number.isFinite(maybe.lineEnd)
	) {
		return null;
	}
	return {
		lineStart: Math.max(0, Math.floor(maybe.lineStart)),
		lineEnd: Math.max(0, Math.floor(maybe.lineEnd)),
	};
}

function formatBlockLimit(bytes: number): string {
	if (bytes >= 1_000_000) {
		return `${(bytes / 1_000_000).toFixed(1)} MB`;
	}
	return `${Math.round(bytes / 1000)} KB`;
}
