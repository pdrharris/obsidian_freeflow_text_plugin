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
	InkViewport,
	parseInkDocument,
	serializeInkDocument,
} from './model';
import { drawInlineCanvas } from './render';
import { persistInkCodeBlock, SectionInfoLike } from './storage';

const SAVE_DEBOUNCE_MS = 320;
const SOFT_LIMIT_BYTES = 300_000;
const HARD_LIMIT_BYTES = 1_000_000;

export class InkBlockRegistry {
	private readonly plugin: Plugin;
	private readonly drawer: InkDrawer;
	private activeKey: string | null = null;

	constructor(plugin: Plugin, drawer: InkDrawer) {
		this.plugin = plugin;
		this.drawer = drawer;
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
		let viewport = initialViewportFor(documentModel);
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
		metaRowEl.createSpan({ text: 'Tap to write' });
		const actionEl = metaRowEl.createSpan({ cls: 'freeflow-ink-meta-action', text: 'Open' });
		actionEl.ariaHidden = 'true';

		const renderInline = (): void => {
			drawInlineCanvas(canvasEl, documentModel);
		};
		renderInline();

		const flushSave = async (): Promise<void> => {
			if (isDisposed) {
				return;
			}
			const serialized = serializeInkDocument(documentModel);
			const byteSize = serialized.length;
			if (byteSize > HARD_LIMIT_BYTES) {
				if (!hardWarned) {
					hardWarned = true;
					new Notice('Freeflow ink block is over 1 mb. Split into multiple blocks before saving more strokes.');
				}
				containerEl.classList.add('is-over-limit');
				return;
			}
			containerEl.classList.remove('is-over-limit');

			if (byteSize > SOFT_LIMIT_BYTES && !softWarned) {
				softWarned = true;
				new Notice('Freeflow ink block is growing large. Consider splitting at around 300 kb for best iOS performance.');
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
			renderInline();
			if (!isActiveKey(blockKey)) {
				scheduleSave();
			}
		};

		const openDrawer = (): void => {
			setActiveKey(blockKey);
			drawer.open({
				key: blockKey,
				doc: documentModel,
				viewport,
				onDocumentChanged,
				onViewportChanged: (nextViewport) => {
					viewport = nextViewport;
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

		canvasEl.addEventListener('click', openDrawer);
		canvasEl.addEventListener('keydown', onCanvasKeyDown);
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
					canvasEl.removeEventListener('click', openDrawer);
					canvasEl.removeEventListener('keydown', onCanvasKeyDown);
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

function initialViewportFor(doc: InkDocument): InkViewport {
	const bounds = getInkBounds(doc);
	const lineHeight = doc.meta.lineHeight || DEFAULT_INK_DOCUMENT.meta.lineHeight;
	const lineOffsetY = Math.max(0, Math.floor(bounds.maxY / lineHeight) * lineHeight);
	return {
		viewportX: Math.max(0, bounds.maxX - 600),
		lineOffsetY,
	};
}
