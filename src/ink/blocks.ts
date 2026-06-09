import {
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	Notice,
	Plugin,
} from 'obsidian';
import { InkDrawer } from './drawer';
import {
	INK_CODE_BLOCK_LANGUAGE,
	InkDocument,
	clampCursor,
	fragmentIsEmpty,
	parseInkDocument,
	selectionIsEmpty,
	serializeInkDocument,
} from './doc';
import { deleteSelection, extractSelection, insertFragmentAtCursor } from './edit';
import { getClipboard, setClipboard } from './clipboard';
import { drawInlineCanvas, inlineLayout, InlineRenderOptions } from './render';
import { persistInkCodeBlock, SectionInfoLike } from './storage';

const SAVE_DEBOUNCE_MS = 320;

export class InkBlockRegistry {
	private readonly plugin: Plugin;
	private readonly drawer: InkDrawer;
	private readonly getWrapWidthWorld: () => number;
	private readonly getWordGapScale: () => number;
	private readonly getRenderLineHeightScale: () => number;
	private readonly getRenderStrokeFillScale: () => number;
	private readonly getShowWritingLine: () => boolean;
	private readonly getSoftBlockLimitBytes: () => number;
	private readonly getHardBlockLimitBytes: () => number;
	private readonly getShowSoftLimitNotice: () => boolean;
	private activeKey: string | null = null;

	constructor(
		plugin: Plugin,
		drawer: InkDrawer,
		getWrapWidthWorld: () => number,
		getWordGapScale: () => number,
		getRenderLineHeightScale: () => number,
		getRenderStrokeFillScale: () => number,
		getShowWritingLine: () => boolean,
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
		this.getSoftBlockLimitBytes = getSoftBlockLimitBytes;
		this.getHardBlockLimitBytes = getHardBlockLimitBytes;
		this.getShowSoftLimitNotice = getShowSoftLimitNotice;
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
		};
	}

	private mountBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext,
	): void {
		const drawer = this.drawer;
		const setActiveKey = (value: string | null): void => {
			this.activeKey = value;
		};
		const isActiveKey = (value: string): boolean => this.activeKey === value;

		const containerEl = el.createDiv({ cls: 'freeflow-ink-block' });
		const section = toSectionInfoLike(ctx.getSectionInfo(el));
		if (!section) {
			containerEl.createDiv({
				cls: 'freeflow-ink-block-error',
				text: 'Unable to attach fii-ink editor in this view. Re-open the note and try again.',
			});
			return;
		}

		const parsed = this.parseWithError(source, containerEl);
		if (!parsed) {
			return;
		}

		const documentModel = parsed;
		documentModel.meta.cursor = clampCursor(documentModel.meta.cursor, documentModel.lines);
		let showInlineCaret = false;
		let selectMode = false;
		let selecting = false;
		let saveTimeout = 0;
		let isDisposed = false;
		let pendingInlineRefreshWhileActive = false;
		let softWarned = false;
		let hardWarned = false;
		const blockKey = `${ctx.sourcePath}:${section.lineStart}:${section.lineEnd}`;

		const canvasEl = containerEl.createEl('canvas', {
			cls: 'freeflow-ink-inline-canvas',
			attr: { role: 'button', 'aria-label': 'Open freeflow ink drawer' },
		});
		const metaRowEl = containerEl.createDiv({ cls: 'freeflow-ink-meta' });
		const hintEl = metaRowEl.createSpan({ text: 'Tap to place cursor' });
		const makeMetaButton = (label: string): HTMLButtonElement => {
			const btn = metaRowEl.createEl('button', { cls: 'freeflow-ink-meta-action', text: label });
			btn.type = 'button';
			return btn;
		};
		const selectButtonEl = makeMetaButton('Select');
		const copyButtonEl = makeMetaButton('Copy');
		const cutButtonEl = makeMetaButton('Cut');
		const pasteButtonEl = makeMetaButton('Paste');
		const actionEl = makeMetaButton('Open');

		const updateMetaButtons = (): void => {
			const hasSelection = !selectionIsEmpty(documentModel.meta.selection);
			selectButtonEl.classList.toggle('is-active', selectMode);
			copyButtonEl.disabled = !hasSelection;
			cutButtonEl.disabled = !hasSelection;
			pasteButtonEl.disabled = fragmentIsEmpty(getClipboard());
			hintEl.textContent = selectMode ? 'Drag to select words' : 'Tap to place cursor';
		};

		const renderInline = (): void => {
			drawInlineCanvas(
				canvasEl,
				documentModel,
				this.renderOptions(),
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
			const { layout } = inlineLayout(canvasEl, documentModel, this.renderOptions());
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
			const { layout } = inlineLayout(canvasEl, documentModel, this.renderOptions());
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

		canvasEl.addEventListener('click', onCanvasClick);
		canvasEl.addEventListener('dblclick', onCanvasDoubleClick);
		canvasEl.addEventListener('keydown', onCanvasKeyDown);
		canvasEl.addEventListener('pointerdown', onCanvasPointerDown);
		canvasEl.addEventListener('pointermove', onCanvasPointerMove);
		canvasEl.addEventListener('pointerup', onCanvasPointerUp);
		canvasEl.addEventListener('pointercancel', onCanvasPointerUp);
		selectButtonEl.addEventListener('click', onToggleSelect);
		copyButtonEl.addEventListener('click', onCopy);
		cutButtonEl.addEventListener('click', onCut);
		pasteButtonEl.addEventListener('click', onPaste);
		actionEl.addEventListener('click', onActionClick);
		canvasEl.tabIndex = 0;

		const resizeObserver = new ResizeObserver(() => {
			renderInline();
		});
		resizeObserver.observe(containerEl);

		ctx.addChild(
			new (class extends MarkdownRenderChild {
				onunload(): void {
					isDisposed = true;
					resizeObserver.disconnect();
					canvasEl.removeEventListener('click', onCanvasClick);
					canvasEl.removeEventListener('dblclick', onCanvasDoubleClick);
					canvasEl.removeEventListener('keydown', onCanvasKeyDown);
					canvasEl.removeEventListener('pointerdown', onCanvasPointerDown);
					canvasEl.removeEventListener('pointermove', onCanvasPointerMove);
					canvasEl.removeEventListener('pointerup', onCanvasPointerUp);
					canvasEl.removeEventListener('pointercancel', onCanvasPointerUp);
					selectButtonEl.removeEventListener('click', onToggleSelect);
					copyButtonEl.removeEventListener('click', onCopy);
					cutButtonEl.removeEventListener('click', onCut);
					pasteButtonEl.removeEventListener('click', onPaste);
					actionEl.removeEventListener('click', onActionClick);
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
