// The floating writing drawer for the flowing-text ink model.
//
// The drawer is a writing surface: it renders the laid-out document (large "write big" glyphs,
// no soft-wrap), scrolled to follow the cursor, and lets the user add strokes. Captured strokes
// are converted to source coordinates and inserted into the logical tree via `edit.ts`; after
// every change the layout engine recomputes geometry. There is no absolute-coordinate patching.

import {
	InkCursor,
	InkDocument,
	InkFragment,
	InkStroke,
	clampCursor,
	createStrokeId,
	fragmentIsEmpty,
	selectionIsEmpty,
	wordBounds,
} from './doc';
import {
	appendStrokeToCurrentWord,
	deleteSelection,
	eraseAtCursor,
	extractSelection,
	insertFragmentAtCursor,
	insertWordAtCursor,
	splitLineAtCursor,
	wordFromStroke,
} from './edit';
import { LayoutResult, layoutDocument } from './layout';
import { drawLaidStroke, resizeCanvasForDpr } from './render';

const BACKDROP_CLOSE_GUARD_MS = 420;
const MIN_POINT_DISTANCE_SQ = 0.35;

export interface DrawerRuntimeConfig {
	wrapWidth: number;
	wordGapScale: number;
	idleAdvanceMs: number;
	releaseAdvanceDelayMs: number;
	showWritingLine: boolean;
	usePointerCapture: boolean;
	allowAnyNonMousePointer: boolean;
}

export interface InkDiagnosticResult {
	name: string;
	pass: boolean;
	detail: string;
}

export interface DrawerSession {
	key: string;
	doc: InkDocument;
	onContentChanged: () => void;
	onCursorChanged: () => void;
	onClose: () => void;
}

interface ActivePoint {
	x: number; // canvas css px
	y: number; // canvas css px
	pressure: number;
	time: number;
}

export class InkDrawer {
	private readonly getRuntimeConfig: () => DrawerRuntimeConfig;
	private readonly rootEl: HTMLDivElement;
	private readonly sheetEl: HTMLDivElement;
	private readonly canvasEl: HTMLCanvasElement;
	private readonly statusEl: HTMLDivElement;
	private readonly selectButtonEl: HTMLButtonElement;
	private readonly copyButtonEl: HTMLButtonElement;
	private readonly cutButtonEl: HTMLButtonElement;
	private readonly pasteButtonEl: HTMLButtonElement;
	private readonly eraseButtonEl: HTMLButtonElement;
	private readonly newLineButtonEl: HTMLButtonElement;
	private readonly closeButtonEl: HTMLButtonElement;

	private session: DrawerSession | null = null;
	private activeStroke: ActivePoint[] | null = null;
	private activePointerId: number | null = null;
	private tool: 'pen' | 'select' = 'pen';
	private selecting = false;
	private clipboard: InkFragment | null = null;
	private scrollX = 0;
	private scrollY = 0;
	private redrawQueued = false;
	private lastInteractionAt = 0;

	constructor(getRuntimeConfig: () => DrawerRuntimeConfig) {
		this.getRuntimeConfig = getRuntimeConfig;
		this.rootEl = activeDocument.createElement('div');
		this.rootEl.className = 'freeflow-ink-drawer-root';

		this.sheetEl = activeDocument.createElement('div');
		this.sheetEl.className = 'freeflow-ink-drawer-sheet';

		const canvasFrame = activeDocument.createElement('div');
		canvasFrame.className = 'freeflow-ink-canvas-frame';
		this.canvasEl = activeDocument.createElement('canvas');
		this.canvasEl.className = 'freeflow-ink-drawer-canvas';
		canvasFrame.appendChild(this.canvasEl);

		const rightButtons = activeDocument.createElement('div');
		rightButtons.className = 'freeflow-ink-drawer-buttons';
		const makeButton = (label: string): HTMLButtonElement => {
			const btn = activeDocument.createElement('button');
			btn.type = 'button';
			btn.className = 'freeflow-ink-drawer-btn';
			btn.textContent = label;
			rightButtons.appendChild(btn);
			return btn;
		};
		this.selectButtonEl = makeButton('Select');
		this.copyButtonEl = makeButton('Copy');
		this.cutButtonEl = makeButton('Cut');
		this.pasteButtonEl = makeButton('Paste');
		this.eraseButtonEl = makeButton('Erase');
		this.newLineButtonEl = makeButton('New line');

		const topBar = activeDocument.createElement('div');
		topBar.className = 'freeflow-ink-drawer-top';
		this.statusEl = activeDocument.createElement('div');
		this.statusEl.className = 'freeflow-ink-drawer-status';
		this.statusEl.textContent = 'Pen';
		topBar.appendChild(this.statusEl);
		this.closeButtonEl = activeDocument.createElement('button');
		this.closeButtonEl.type = 'button';
		this.closeButtonEl.className = 'freeflow-ink-drawer-close';
		this.closeButtonEl.textContent = 'Close';
		topBar.appendChild(this.closeButtonEl);

		this.sheetEl.appendChild(topBar);
		this.sheetEl.appendChild(canvasFrame);
		this.rootEl.appendChild(this.sheetEl);
		this.rootEl.appendChild(rightButtons);
		activeDocument.body.appendChild(this.rootEl);

		this.attachListeners();
	}

	destroy(): void {
		this.close();
		this.detachListeners();
		this.rootEl.remove();
	}

	refreshLayout(): void {
		this.requestDraw();
	}

	open(session: DrawerSession): void {
		if (this.session && this.session.key !== session.key) {
			this.close();
		}
		this.session = session;
		session.doc.meta.cursor = clampCursor(session.doc.meta.cursor, session.doc.lines);
		this.activeStroke = null;
		this.activePointerId = null;
		this.tool = 'pen';
		this.selecting = false;
		this.rootEl.classList.add('is-open');
		this.updateScrollToCursor();
		this.requestDraw();
	}

	updateCursor(sessionKey: string, cursor: InkCursor): void {
		if (!this.session || this.session.key !== sessionKey || this.activePointerId !== null) {
			return;
		}
		this.session.doc.meta.cursor = clampCursor(cursor, this.session.doc.lines);
		this.session.doc.meta.selection = null;
		this.updateScrollToCursor();
		this.session.onCursorChanged();
		this.requestDraw();
	}

	close(): void {
		if (!this.session) {
			return;
		}
		this.finishStroke();
		const closing = this.session;
		this.session = null;
		this.rootEl.classList.remove('is-open');
		closing.onClose();
	}

	// ----------------------------------------------------------------- layout

	private drawerLayout(): LayoutResult | null {
		const session = this.session;
		if (!session) {
			return null;
		}
		const rect = this.canvasEl.getBoundingClientRect();
		const cssHeight = rect.height || this.canvasEl.clientHeight || 200;
		const config = this.getRuntimeConfig();
		const targetLineHeight = clamp(cssHeight * 0.5, 40, 240);
		return layoutDocument(session.doc, {
			contentWidthCss: Number.POSITIVE_INFINITY, // drawer never soft-wraps; it scrolls
			targetLineHeightCss: targetLineHeight,
			sourceLineHeight: session.doc.meta.lineHeight,
			wordGapScale: config.wordGapScale,
			strokeFillScale: 1,
		});
	}

	private updateScrollToCursor(): void {
		const session = this.session;
		const layout = this.drawerLayout();
		if (!session || !layout) {
			return;
		}
		const rect = this.canvasEl.getBoundingClientRect();
		const width = rect.width || this.canvasEl.clientWidth || 480;
		const height = rect.height || this.canvasEl.clientHeight || 200;
		const caret = layout.caretRect(session.doc.meta.cursor);
		this.scrollX = Math.max(-layout.marginX, caret.x - width * 0.32);
		this.scrollY = caret.baselineY - height * 0.62;
	}

	// ----------------------------------------------------------------- drawing

	private requestDraw(): void {
		if (this.redrawQueued) {
			return;
		}
		this.redrawQueued = true;
		window.requestAnimationFrame(() => {
			this.redrawQueued = false;
			this.draw();
		});
	}

	private draw(): void {
		const session = this.session;
		const layout = this.drawerLayout();
		if (!session || !layout) {
			return;
		}
		const rect = this.canvasEl.getBoundingClientRect();
		const cssWidth = Math.floor(rect.width || this.canvasEl.clientWidth);
		const cssHeight = Math.floor(rect.height || this.canvasEl.clientHeight);
		if (cssWidth <= 0 || cssHeight <= 0) {
			return;
		}
		resizeCanvasForDpr(this.canvasEl, cssWidth, cssHeight, false);
		const ctx = this.canvasEl.getContext('2d');
		if (!ctx) {
			return;
		}
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssWidth, cssHeight);
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, cssWidth, cssHeight);

		// Selection highlight (behind the strokes).
		const selection = session.doc.meta.selection;
		if (selection && !selectionIsEmpty(selection)) {
			ctx.fillStyle = 'rgba(37, 99, 235, 0.18)';
			for (const r of layout.rangeRects(selection)) {
				ctx.fillRect(r.x - this.scrollX, r.y - this.scrollY, r.w, r.h);
			}
		}

		// Baseline guide for the cursor's row.
		const caret = layout.caretRect(session.doc.meta.cursor);
		if (this.getRuntimeConfig().showWritingLine) {
			const baselineLocalY = caret.baselineY - this.scrollY;
			ctx.strokeStyle = '#a5b4c6';
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(0, baselineLocalY);
			ctx.lineTo(cssWidth, baselineLocalY);
			ctx.stroke();
		}

		const widthScale = layout.cssPerSource;
		for (const word of layout.words) {
			for (const laid of word.strokes) {
				const points = laid.points.map((p) => ({ x: p.x - this.scrollX, y: p.y - this.scrollY }));
				const widthPx = Math.max(1, laid.stroke.width * widthScale * (laid.stroke.bold ? 1.7 : 1));
				drawLaidStroke(ctx, points, widthPx, laid.stroke.color);
			}
		}

		// Caret.
		ctx.strokeStyle = '#2563eb';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(caret.x - this.scrollX, caret.y - this.scrollY);
		ctx.lineTo(caret.x - this.scrollX, caret.y + caret.height - this.scrollY);
		ctx.stroke();

		// Active (in-progress) stroke, drawn raw in canvas space.
		if (this.activeStroke && this.activeStroke.length > 0) {
			drawLaidStroke(
				ctx,
				this.activeStroke.map((p) => ({ x: p.x, y: p.y })),
				Math.max(1, 2.4),
				'#111827',
			);
		}

		this.updateToolUi();
	}

	// ----------------------------------------------------------------- input

	private attachListeners(): void {
		this.canvasEl.addEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.addEventListener('pointermove', this.onPointerMove);
		this.canvasEl.addEventListener('pointerup', this.onPointerUp);
		this.canvasEl.addEventListener('pointercancel', this.onPointerUp);
		this.selectButtonEl.addEventListener('click', this.onToggleSelect);
		this.copyButtonEl.addEventListener('click', this.onCopy);
		this.cutButtonEl.addEventListener('click', this.onCut);
		this.pasteButtonEl.addEventListener('click', this.onPaste);
		this.eraseButtonEl.addEventListener('click', this.onErase);
		this.newLineButtonEl.addEventListener('click', this.onNewLine);
		this.closeButtonEl.addEventListener('click', this.onCloseClick);
		this.rootEl.addEventListener('pointerdown', this.onBackdropPointerDown);
	}

	private detachListeners(): void {
		this.canvasEl.removeEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.removeEventListener('pointermove', this.onPointerMove);
		this.canvasEl.removeEventListener('pointerup', this.onPointerUp);
		this.canvasEl.removeEventListener('pointercancel', this.onPointerUp);
		this.selectButtonEl.removeEventListener('click', this.onToggleSelect);
		this.copyButtonEl.removeEventListener('click', this.onCopy);
		this.cutButtonEl.removeEventListener('click', this.onCut);
		this.pasteButtonEl.removeEventListener('click', this.onPaste);
		this.eraseButtonEl.removeEventListener('click', this.onErase);
		this.newLineButtonEl.removeEventListener('click', this.onNewLine);
		this.closeButtonEl.removeEventListener('click', this.onCloseClick);
		this.rootEl.removeEventListener('pointerdown', this.onBackdropPointerDown);
	}

	private acceptsPointer(_event: PointerEvent): boolean {
		// Accept pen, mouse and touch on every platform (Android/iOS/desktop). The drawer is an
		// explicit writing surface, and the single-active-pointer guard ignores extra touches,
		// giving basic palm rejection.
		return true;
	}

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.session || this.activePointerId !== null || !this.acceptsPointer(event)) {
			return;
		}
		event.preventDefault();
		this.lastInteractionAt = Date.now();
		this.activePointerId = event.pointerId;
		if (this.getRuntimeConfig().usePointerCapture) {
			try {
				this.canvasEl.setPointerCapture(event.pointerId);
			} catch {
				/* iOS can reject capture during fast pen input */
			}
		}
		if (this.tool === 'select') {
			this.selecting = true;
			const cursor = this.pointerToCursor(event);
			this.session.doc.meta.selection = { anchor: cursor, focus: cursor };
			this.session.doc.meta.cursor = cursor;
			this.requestDraw();
			return;
		}
		// Pen: starting a stroke clears any selection.
		this.session.doc.meta.selection = null;
		this.activeStroke = [];
		this.appendActivePoint(event);
		this.requestDraw();
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (this.activePointerId !== event.pointerId) {
			return;
		}
		event.preventDefault();
		if (this.tool === 'select') {
			if (this.selecting && this.session) {
				const focus = this.pointerToCursor(event);
				const sel = this.session.doc.meta.selection;
				if (sel) {
					sel.focus = focus;
				}
				this.session.doc.meta.cursor = focus;
				this.requestDraw();
			}
			return;
		}
		if (!this.activeStroke) {
			return;
		}
		const samples =
			typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
		for (const sample of samples.length > 0 ? samples : [event]) {
			this.appendActivePoint(sample);
		}
		this.requestDraw();
	};

	private onPointerUp = (event: PointerEvent): void => {
		if (this.activePointerId !== event.pointerId) {
			return;
		}
		event.preventDefault();
		this.lastInteractionAt = Date.now();
		if (this.getRuntimeConfig().usePointerCapture && this.canvasEl.hasPointerCapture(event.pointerId)) {
			try {
				this.canvasEl.releasePointerCapture(event.pointerId);
			} catch {
				/* ignore */
			}
		}
		if (this.tool === 'select') {
			this.activePointerId = null;
			this.selecting = false;
			const session = this.session;
			if (session) {
				// A tap (empty selection) just places the cursor.
				if (selectionIsEmpty(session.doc.meta.selection)) {
					session.doc.meta.selection = null;
				}
				this.updateScrollToCursor();
				session.onCursorChanged();
			}
			this.requestDraw();
			return;
		}
		this.finishStroke();
	};

	private pointerToCursor(event: PointerEvent): InkCursor {
		const layout = this.drawerLayout();
		if (!layout) {
			return { line: 0, word: 0 };
		}
		const rect = this.canvasEl.getBoundingClientRect();
		const lx = event.clientX - rect.left + this.scrollX;
		const ly = event.clientY - rect.top + this.scrollY;
		return layout.cursorFromPoint(lx, ly);
	}

	private appendActivePoint(event: PointerEvent): void {
		if (!this.activeStroke) {
			return;
		}
		const rect = this.canvasEl.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			return;
		}
		const prev = this.activeStroke[this.activeStroke.length - 1];
		if (prev) {
			const dx = prev.x - x;
			const dy = prev.y - y;
			if (dx * dx + dy * dy < MIN_POINT_DISTANCE_SQ) {
				return;
			}
		}
		this.activeStroke.push({
			x,
			y,
			pressure: event.pressure > 0 ? event.pressure : 0.5,
			time: Date.now(),
		});
	}

	// ----------------------------------------------------------------- commit

	private finishStroke(): void {
		const session = this.session;
		const active = this.activeStroke;
		this.activePointerId = null;
		this.activeStroke = null;
		if (!session || !active || active.length === 0) {
			this.requestDraw();
			return;
		}
		const layout = this.drawerLayout();
		if (!layout) {
			return;
		}
		const cssPerSource = layout.cssPerSource || 1;
		const cursor = clampCursor(session.doc.meta.cursor, session.doc.lines);

		// Layout-space positions of the captured points.
		const layoutPoints = active.map((p) => ({
			lx: p.x + this.scrollX,
			ly: p.y + this.scrollY,
			pressure: p.pressure,
			time: p.time,
		}));
		let strokeMinX = Infinity;
		for (const p of layoutPoints) {
			if (p.lx < strokeMinX) strokeMinX = p.lx;
		}

		// Decide: continue the current word, or start a new word at the cursor.
		const currentWordLaid = layout.words.find(
			(w) => w.line === cursor.line && w.word === cursor.word - 1,
		);
		const currentWord = session.doc.lines[cursor.line]?.words[cursor.word - 1];
		const gapThreshold = layout.rowHeight * 0.6;
		const continueWord =
			!!currentWordLaid &&
			!!currentWord &&
			strokeMinX - (currentWordLaid.x + currentWordLaid.width) <= gapThreshold;

		let originX: number;
		let baselineY: number;
		let sourceOriginX: number;
		if (continueWord && currentWordLaid && currentWord) {
			const bounds = wordBounds(currentWord);
			originX = currentWordLaid.x;
			baselineY = currentWordLaid.baselineY;
			sourceOriginX = bounds ? bounds.minX : 0;
		} else {
			const caret = layout.caretRect(cursor);
			originX = caret.x;
			baselineY = caret.baselineY;
			sourceOriginX = 0;
		}

		const penWidth = Math.max(0.5, 2.4 / cssPerSource);
		const stroke: InkStroke = {
			id: createStrokeId(),
			width: penWidth,
			color: '#111827',
			points: layoutPoints.map((p) => ({
				x: (p.lx - originX) / cssPerSource + sourceOriginX,
				y: (p.ly - baselineY) / cssPerSource,
				pressure: p.pressure,
				time: p.time,
			})),
		};

		if (continueWord) {
			appendStrokeToCurrentWord(session.doc, stroke);
		} else {
			insertWordAtCursor(session.doc, wordFromStroke(stroke));
		}
		this.updateScrollToCursor();
		session.onContentChanged();
		this.requestDraw();
	}

	// ----------------------------------------------------------------- buttons

	private onToggleSelect = (): void => {
		this.tool = this.tool === 'select' ? 'pen' : 'select';
		this.selecting = false;
		this.requestDraw();
	};

	private onCopy = (): void => {
		const session = this.session;
		if (!session || selectionIsEmpty(session.doc.meta.selection)) {
			return;
		}
		this.clipboard = extractSelection(session.doc, session.doc.meta.selection!);
		this.requestDraw();
	};

	private onCut = (): void => {
		const session = this.session;
		if (!session || selectionIsEmpty(session.doc.meta.selection)) {
			return;
		}
		this.clipboard = extractSelection(session.doc, session.doc.meta.selection!);
		deleteSelection(session.doc, session.doc.meta.selection!);
		this.tool = 'pen';
		this.updateScrollToCursor();
		session.onContentChanged();
		this.requestDraw();
	};

	private onPaste = (): void => {
		const session = this.session;
		if (!session || fragmentIsEmpty(this.clipboard)) {
			return;
		}
		insertFragmentAtCursor(session.doc, this.clipboard!);
		this.updateScrollToCursor();
		session.onContentChanged();
		this.requestDraw();
	};

	private updateToolUi(): void {
		const hasSelection = !!this.session && !selectionIsEmpty(this.session.doc.meta.selection);
		this.selectButtonEl.classList.toggle('is-active', this.tool === 'select');
		this.copyButtonEl.disabled = !hasSelection;
		this.cutButtonEl.disabled = !hasSelection;
		this.pasteButtonEl.disabled = fragmentIsEmpty(this.clipboard);
		this.statusEl.textContent = this.tool === 'select' ? 'Select' : 'Pen';
	}

	private onErase = (): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		eraseAtCursor(session.doc);
		this.updateScrollToCursor();
		session.onContentChanged();
		this.requestDraw();
	};

	private onNewLine = (): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		splitLineAtCursor(session.doc);
		this.updateScrollToCursor();
		session.onContentChanged();
		this.requestDraw();
	};

	private onCloseClick = (): void => {
		this.close();
	};

	private onBackdropPointerDown = (event: PointerEvent): void => {
		if (event.target !== this.rootEl) {
			return;
		}
		if (Date.now() - this.lastInteractionAt < BACKDROP_CLOSE_GUARD_MS) {
			return;
		}
		this.close();
	};

	// ----------------------------------------------------------------- diagnostics (kept for the command palette)

	runBasicDiagnostics(): InkDiagnosticResult[] {
		const results: InkDiagnosticResult[] = [];
		const doc = this.session?.doc;
		results.push({
			name: 'layout-engine',
			pass: true,
			detail: doc
				? `lines=${doc.lines.length}, cursor=${doc.meta.cursor.line}:${doc.meta.cursor.word}`
				: 'no active session',
		});
		return results;
	}

	getPencilTimingSummary(): string {
		return 'Pencil timing diagnostics were removed in the flowing-text rewrite.';
	}

	resetPencilTimingDiagnostics(): void {
		/* no-op: timing diagnostics removed */
	}
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}
