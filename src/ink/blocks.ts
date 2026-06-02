import {
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	Notice,
	Plugin,
} from 'obsidian';
import { InkDrawer } from './drawer';
import {
	DEFAULT_INK_DOCUMENT,
	getInkBounds,
	INK_CODE_BLOCK_LANGUAGE,
	InkDocument,
	InkStroke,
	InkViewport,
	parseInkDocument,
	serializeInkDocument,
} from './model';
import { drawInlineCanvas, findInlineInsertionIndex } from './render';
import { persistInkCodeBlock, SectionInfoLike } from './storage';

const SAVE_DEBOUNCE_MS = 320;

export class InkBlockRegistry {
	private readonly plugin: Plugin;
	private readonly drawer: InkDrawer;
	private readonly getWrapWidthWorld: () => number;
	private readonly getRenderLineHeightScale: () => number;
	private readonly getShowWritingLine: () => boolean;
	private readonly getSoftBlockLimitBytes: () => number;
	private readonly getHardBlockLimitBytes: () => number;
	private readonly getShowSoftLimitNotice: () => boolean;
	private activeKey: string | null = null;

	constructor(
		plugin: Plugin,
		drawer: InkDrawer,
		getWrapWidthWorld: () => number,
		getRenderLineHeightScale: () => number,
		getShowWritingLine: () => boolean,
		getSoftBlockLimitBytes: () => number,
		getHardBlockLimitBytes: () => number,
		getShowSoftLimitNotice: () => boolean,
	) {
		this.plugin = plugin;
		this.drawer = drawer;
		this.getWrapWidthWorld = getWrapWidthWorld;
		this.getRenderLineHeightScale = getRenderLineHeightScale;
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
		let viewport = initialViewportFor(documentModel, this.getWrapWidthWorld());
		let cursorIndex = documentModel.strokes.length;
		let showInlineCaret = false;
		let saveTimeout = 0;
		let isDisposed = false;
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
				this.getRenderLineHeightScale(),
				this.getShowWritingLine(),
				showInlineCaret ? cursorIndex : null,
			);
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

		const onDocumentChanged = (): void => {
			cursorIndex = clampInsertionIndex(cursorIndex, documentModel.strokes.length);
			renderInline();
			if (!isActiveKey(blockKey)) {
				scheduleSave();
			}
		};

		const openDrawer = (nextCursorIndex?: number): void => {
			if (typeof nextCursorIndex === 'number' && Number.isFinite(nextCursorIndex)) {
				cursorIndex = clampInsertionIndex(nextCursorIndex, documentModel.strokes.length);
				viewport = viewportForInsertion(documentModel, this.getWrapWidthWorld(), cursorIndex);
			}
			showInlineCaret = true;

			setActiveKey(blockKey);
			drawer.open({
				key: blockKey,
				doc: documentModel,
				viewport,
				cursorIndex,
				onDocumentChanged,
				onViewportChanged: (nextViewport) => {
					viewport = nextViewport;
				},
				onCursorChanged: (nextCursorIndex) => {
					cursorIndex = clampInsertionIndex(nextCursorIndex, documentModel.strokes.length);
					showInlineCaret = true;
					renderInline();
				},
				onClose: () => {
					if (isActiveKey(blockKey)) {
						setActiveKey(null);
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
			cursorIndex = findInlineInsertionIndex(
				documentModel,
				this.getWrapWidthWorld(),
				this.getRenderLineHeightScale(),
				rect.width,
				clickX,
				clickY,
			);
			viewport = viewportForInsertion(documentModel, this.getWrapWidthWorld(), cursorIndex);
			showInlineCaret = true;
			renderInline();
			if (isActiveKey(blockKey)) {
				drawer.updateCursor(blockKey, cursorIndex, viewport);
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
	const bounds = getInkBounds(doc);
	const lineHeight = doc.meta.lineHeight || DEFAULT_INK_DOCUMENT.meta.lineHeight;
	const lineOffsetY = Math.max(lineHeight, Math.floor(bounds.maxY / lineHeight) * lineHeight);
	return {
		viewportX: Math.max(0, bounds.maxX - wrapWidth * 0.66),
		lineOffsetY,
	};
}

function viewportForInsertion(doc: InkDocument, wrapWidth: number, insertionIndex: number): InkViewport {
	const lineHeight = doc.meta.lineHeight || DEFAULT_INK_DOCUMENT.meta.lineHeight;
	const clampedIndex = clampInsertionIndex(insertionIndex, doc.strokes.length);
	const prevStroke = clampedIndex > 0 ? doc.strokes[clampedIndex - 1] : undefined;
	const nextStroke = clampedIndex < doc.strokes.length ? doc.strokes[clampedIndex] : undefined;
	const prevAnchor = getStrokeAnchor(prevStroke);
	const nextAnchor = getStrokeAnchor(nextStroke);

	if (!prevAnchor && !nextAnchor) {
		return initialViewportFor(doc, wrapWidth);
	}
	const isSameLine =
		!!prevAnchor &&
		!!nextAnchor &&
		Math.abs(nextAnchor.centerY - prevAnchor.centerY) <= lineHeight * 0.6;

	const anchorX =
		prevAnchor && nextAnchor
			? isSameLine
				? (prevAnchor.rightX + nextAnchor.leftX) * 0.5
				: prevAnchor.rightX + 20
			: prevAnchor
				? prevAnchor.rightX + 24
				: Math.max(0, (nextAnchor?.leftX ?? 0) - 24);
	const anchorY =
		prevAnchor && nextAnchor
			? (prevAnchor.centerY + nextAnchor.centerY) * 0.5
			: prevAnchor
				? prevAnchor.centerY
				: (nextAnchor?.centerY ?? lineHeight);

	return {
		viewportX: Math.max(0, anchorX - wrapWidth * 0.4),
		lineOffsetY: Math.max(lineHeight, Math.floor(anchorY / lineHeight) * lineHeight),
	};
}

function getStrokeAnchor(stroke: InkStroke | undefined): {
	leftX: number;
	rightX: number;
	centerY: number;
} | null {
	if (!stroke || stroke.points.length === 0) {
		return null;
	}

	let minX = stroke.points[0]?.x ?? 0;
	let maxX = stroke.points[0]?.x ?? 0;
	let minY = stroke.points[0]?.y ?? 0;
	let maxY = stroke.points[0]?.y ?? 0;
	for (const point of stroke.points) {
		if (point.x < minX) minX = point.x;
		if (point.x > maxX) maxX = point.x;
		if (point.y < minY) minY = point.y;
		if (point.y > maxY) maxY = point.y;
	}

	return {
		leftX: minX,
		rightX: maxX,
		centerY: (minY + maxY) * 0.5,
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
