import {
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	Notice,
	Plugin,
} from 'obsidian';
import { InkDrawer } from './drawer';
import {
	DEFAULT_INK_DOCUMENT,
	INK_CODE_BLOCK_LANGUAGE,
	InkCanonicalCursor,
	InkDocument,
	InkViewport,
	isLineBreakMarkerStroke,
	parseInkDocument,
	serializeInkDocument,
} from './model';
import { readCanonicalCursor, writeCanonicalCursor } from './cursor';
import {
	drawInlineCanvas,
	findInlineInsertionSelection,
	type InsertionLinePreference,
} from './render';
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

		let documentModel = parsed;
		const initialCursor = readCanonicalCursor(documentModel, documentModel.strokes.length, 'auto');
		let viewport = initialViewportFor(documentModel, this.getWrapWidthWorld());
		let cursorIndex = initialCursor.index;
		let cursorLinePreference: InsertionLinePreference = initialCursor.linePreference;
		let showInlineCaret = false;
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
		metaRowEl.createSpan({ text: 'Tap to place cursor' });
		const actionEl = metaRowEl.createEl('button', {
			cls: 'freeflow-ink-meta-action',
			text: 'Open',
		});
		actionEl.type = 'button';

		const renderInline = (): void => {
			drawInlineCanvas(
				canvasEl,
				documentModel,
				this.getWrapWidthWorld(),
				this.getWordGapScale(),
				this.getRenderLineHeightScale(),
				this.getRenderStrokeFillScale(),
				this.getShowWritingLine(),
				showInlineCaret ? cursorIndex : null,
				cursorLinePreference,
			);
		};
		renderInline();

		const syncCursorFromDocument = (): InkCanonicalCursor => {
			// Canonical cursor lives in document metadata and is the source of truth for both views.
			const canonical = readCanonicalCursor(documentModel, cursorIndex, cursorLinePreference);
			cursorIndex = canonical.index;
			cursorLinePreference = canonical.linePreference;
			return canonical;
		};

		const writeCursorToDocument = (): InkCanonicalCursor => {
			// Keep metadata synchronized when inline interactions move the cursor.
			const canonical = writeCanonicalCursor(documentModel, cursorIndex, cursorLinePreference);
			cursorIndex = canonical.index;
			cursorLinePreference = canonical.linePreference;
			return canonical;
		};

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

		const onDocumentChanged = (): void => {
			syncCursorFromDocument();
			renderInline();
			if (isActiveKey(blockKey)) {
				pendingInlineRefreshWhileActive = true;
				return;
			}
			scheduleSave();
		};

		const openDrawer = (nextCursorIndex?: number): void => {
			if (typeof nextCursorIndex === 'number' && Number.isFinite(nextCursorIndex)) {
				const nextIndex = clampInsertionIndex(nextCursorIndex, documentModel.strokes.length);
				if (nextIndex !== cursorIndex) {
					cursorIndex = nextIndex;
					cursorLinePreference = 'auto';
					writeCursorToDocument();
				}
			}
			showInlineCaret = true;

			setActiveKey(blockKey);
			drawer.open({
				key: blockKey,
				doc: documentModel,
				viewport,
				cursorIndex,
				linePreference: cursorLinePreference,
				onDocumentChanged,
				onViewportChanged: (nextViewport) => {
					viewport = nextViewport;
				},
				onCursorChanged: (nextCursorIndex) => {
					cursorIndex = clampInsertionIndex(nextCursorIndex, documentModel.strokes.length);
					writeCursorToDocument();
					showInlineCaret = true;
					renderInline();
				},
				onLinePreferenceChanged: (nextLinePreference) => {
					cursorLinePreference = nextLinePreference;
					writeCursorToDocument();
					showInlineCaret = true;
					renderInline();
				},
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

		const onCanvasClick = (event: MouseEvent): void => {
			const rect = canvasEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				showInlineCaret = true;
				renderInline();
				return;
			}

			const clickX = event.clientX - rect.left;
			const clickY = event.clientY - rect.top;
			const selection = findInlineInsertionSelection(
				documentModel,
				this.getWrapWidthWorld(),
				this.getWordGapScale(),
				this.getRenderLineHeightScale(),
				this.getRenderStrokeFillScale(),
				rect.width,
				clickX,
				clickY,
			);
			cursorIndex = selection.index;
			cursorLinePreference = selection.linePreference;
			writeCursorToDocument();
			showInlineCaret = true;
			renderInline();
			if (isActiveKey(blockKey)) {
				drawer.updateCursor(blockKey, cursorIndex, cursorLinePreference);
			}
		};

		const onCanvasDoubleClick = (): void => {
			openDrawer(cursorIndex);
		};

		const onActionClick = (): void => {
			openDrawer(cursorIndex);
		};

		canvasEl.addEventListener('click', onCanvasClick);
		canvasEl.addEventListener('dblclick', onCanvasDoubleClick);
		canvasEl.addEventListener('keydown', onCanvasKeyDown);
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

function initialViewportFor(doc: InkDocument, wrapWidth: number): InkViewport {
	const bounds = getVisibleInkBounds(doc);
	const lineHeight = doc.meta.lineHeight || DEFAULT_INK_DOCUMENT.meta.lineHeight;
	const lineOffsetY = quantizeLineOffset(bounds.maxY, lineHeight);
	return {
		viewportX: Math.max(0, bounds.maxX - wrapWidth * 0.66),
		lineOffsetY,
	};
}

function clampInsertionIndex(value: number, length: number): number {
	if (!Number.isFinite(value)) {
		return length;
	}
	const normalizedLength = Math.max(0, length);
	return Math.max(0, Math.min(normalizedLength, Math.floor(value)));
}

function formatBlockLimit(bytes: number): string {
	if (bytes >= 1_000_000) {
		return `${(bytes / 1_000_000).toFixed(1)} MB`;
	}
	return `${Math.round(bytes / 1000)} KB`;
}

function getVisibleInkBounds(doc: InkDocument): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
} {
	let minX = 0;
	let maxX = 0;
	let minY = 0;
	let maxY = 0;
	let hasPoint = false;

	for (const stroke of doc.strokes) {
		if (isLineBreakMarkerStroke(stroke)) {
			continue;
		}
		for (const point of stroke.points) {
			if (!hasPoint) {
				minX = point.x;
				maxX = point.x;
				minY = point.y;
				maxY = point.y;
				hasPoint = true;
				continue;
			}
			if (point.x < minX) minX = point.x;
			if (point.x > maxX) maxX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.y > maxY) maxY = point.y;
		}
	}

	if (!hasPoint) {
		return {
			minX: 0,
			maxX: 0,
			minY: 0,
			maxY: 0,
		};
	}

	return { minX, maxX, minY, maxY };
}

function quantizeLineOffset(y: number, lineHeight: number): number {
	if (!Number.isFinite(y)) {
		return lineHeight;
	}
	return Math.max(lineHeight, Math.round(y / lineHeight) * lineHeight);
}
