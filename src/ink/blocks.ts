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
} from './edit';
import { getClipboard, setClipboard } from './clipboard';
import { drawInlineCanvas, inlineLayout, InlineRenderOptions } from './render';
import { ColorPopupHandle, DEFAULT_INK_COLOR, openColorPopup } from './palette';
import { persistInkCodeBlock, removeInkCodeBlock, SectionInfoLike } from './storage';

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
	private readonly getSoftBlockLimitBytes: () => number;
	private readonly getHardBlockLimitBytes: () => number;
	private readonly getShowSoftLimitNotice: () => boolean;
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
		getSoftBlockLimitBytes: () => number,
		getHardBlockLimitBytes: () => number,
		getShowSoftLimitNotice: () => boolean,
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
		this.getSoftBlockLimitBytes = getSoftBlockLimitBytes;
		this.getHardBlockLimitBytes = getHardBlockLimitBytes;
		this.getShowSoftLimitNotice = getShowSoftLimitNotice;
	}

	private refreshAllInline(): void {
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
		};
	}

	// Render options for one block. A block that carries its own width governs wrapping by its
	// container width, so the global wrap cap must not shrink it further.
	private blockRenderOptions(doc: InkDocument): InlineRenderOptions {
		const base = this.renderOptions();
		if (typeof doc.meta.widthScale === 'number') {
			return { ...base, wrapWidth: Number.POSITIVE_INFINITY };
		}
		return base;
	}

	// Size the block box to its stored per-block width (a fraction of the content column). With no
	// stored width the box keeps its natural full-column width.
	private applyBlockWidth(containerEl: HTMLElement, doc: InkDocument): void {
		const ws = doc.meta.widthScale;
		containerEl.setCssStyles({
			width: typeof ws === 'number' ? `${(clampWidthScale(ws) * 100).toFixed(2)}%` : '',
		});
	}

	private mountBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	): void {
		const drawer = this.drawer;
		const inlineRefreshers = this.inlineRefreshers;
		const setActiveKey = (value: string | null): void => {
			this.activeKey = value;
		};
		const isActiveKey = (value: string): boolean => this.activeKey === value;

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
			containerEl.createDiv({
				cls: 'freeflow-ink-block-error',
				text: 'Unable to attach fii-ink editor in this view. Re-open the note and try again.',
			});
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
		colorSwatchEl.style.backgroundColor = lastSelectionColor;
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
			colorSwatchEl.style.backgroundColor = colorAtCursor(documentModel);
			if (hasSelection) {
				const flags = selectionStyleFlags(documentModel, documentModel.meta.selection!);
				boldButtonEl.classList.toggle('is-active', flags.allBold);
				underlineButtonEl.classList.toggle('is-active', flags.allUnderline);
			} else {
				boldButtonEl.classList.remove('is-active');
				underlineButtonEl.classList.remove('is-active');
			}
			hintEl.textContent = selectMode ? 'Drag to select words' : 'Tap to place cursor';
		};

		const renderInline = (): void => {
			drawInlineCanvas(
				canvasEl,
				documentModel,
				this.blockRenderOptions(documentModel),
				showInlineCaret ? documentModel.meta.cursor : null,
				documentModel.meta.selection,
			);
			updateMetaButtons();
		};
		renderInline();

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
			const { layout } = inlineLayout(canvasEl, documentModel, this.blockRenderOptions(documentModel));
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
				colorSwatchEl.style.backgroundColor = color;
				if (selectionIsEmpty(documentModel.meta.selection)) {
					return;
				}
				applyStyleToSelection(documentModel, documentModel.meta.selection!, { color });
				applyInlineEdit();
			});
		};

		const onCanvasClick = (event: MouseEvent): void => {
			if (selectMode) {
				return; // selection is handled by the pointer drag handlers
			}
			const rect = canvasEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				showInlineCaret = true;
				renderInline();
				return;
			}
			const { layout } = inlineLayout(canvasEl, documentModel, this.blockRenderOptions(documentModel));
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
		const resizeObserver = new ResizeObserver(() => {
			renderInline();
		});
		resizeObserver.observe(containerEl);

		ctx.addChild(
			new (class extends MarkdownRenderChild {
				onunload(): void {
					isDisposed = true;
					inlineRefreshers.delete(renderInline);
					resizeObserver.disconnect();
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
			drawInlineCanvas(canvasEl, documentModel, this.blockRenderOptions(documentModel), null, null);
		};
		render();
		inlineRefreshers.add(render);
		const resizeObserver = new ResizeObserver(() => render());
		resizeObserver.observe(containerEl);
		ctx.addChild(
			new (class extends MarkdownRenderChild {
				onunload(): void {
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
