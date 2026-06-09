// The floating writing drawer for the flowing-text ink model.
//
// The drawer is a focused writing surface that mimics how people actually write: it shows ONLY
// the current line and ONLY the content to the left of the insertion point, so new strokes
// appear exactly where the pen is (an append-at-the-end feel). The view stays put on pen lift
// (so you can dot an i / cross a t) and only advances horizontally — after a short delay — when
// writing nears the right edge. Captured strokes are converted to source coordinates and
// inserted into the logical tree via edit.ts.

import { setIcon } from 'obsidian';
import {
	InkCursor,
	InkDocument,
	InkStroke,
	clampCursor,
	createStrokeId,
	fragmentIsEmpty,
	wordBounds,
} from './doc';
import { getClipboard } from './clipboard';
import {
	appendStrokeToCurrentWord,
	eraseAtCursor,
	insertFragmentAtCursor,
	insertWordAtCursor,
	splitLineAtCursor,
	wordFromStroke,
} from './edit';
import { LayoutResult, layoutDocument } from './layout';
import { drawLaidStroke, resizeCanvasForDpr } from './render';

const BACKDROP_CLOSE_GUARD_MS = 420;
const MIN_POINT_DISTANCE_SQ = 0.35;
const ADVANCE_DELAY_MS = 650; // delay before the view scrolls on, so you can add dots/crosses
const ADVANCE_SOFT_RATIO = 0.8; // schedule an advance once the caret passes this fraction of width
const ADVANCE_HARD_RATIO = 0.85; // advance immediately on the next pen-down past this fraction

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

interface DrawerView {
	layout: LayoutResult;
	viewCursor: InkCursor;
}

export class InkDrawer {
	private readonly getRuntimeConfig: () => DrawerRuntimeConfig;
	private readonly rootEl: HTMLDivElement;
	private readonly sheetEl: HTMLDivElement;
	private readonly canvasEl: HTMLCanvasElement;
	private readonly statusEl: HTMLDivElement;
	private readonly pasteButtonEl: HTMLButtonElement;
	private readonly eraseButtonEl: HTMLButtonElement;
	private readonly newLineButtonEl: HTMLButtonElement;
	private readonly closeButtonEl: HTMLButtonElement;

	private session: DrawerSession | null = null;
	private activeStroke: ActivePoint[] | null = null;
	private activePointerId: number | null = null;
	private scrollX = 0;
	private scrollY = 0;
	private redrawQueued = false;
	private lastInteractionAt = 0;
	private advanceTimer = 0;

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
		const makeIconButton = (icon: string, label: string): HTMLButtonElement => {
			const btn = activeDocument.createElement('button');
			btn.type = 'button';
			btn.className = 'freeflow-ink-drawer-btn';
			btn.setAttribute('aria-label', label);
			btn.title = label;
			setIcon(btn, icon);
			rightButtons.appendChild(btn);
			return btn;
		};
		this.eraseButtonEl = makeIconButton('eraser', 'Erase');
		this.newLineButtonEl = makeIconButton('corner-down-left', 'New line');
		this.pasteButtonEl = makeIconButton('clipboard-paste', 'Paste');

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
		this.clearAdvanceTimer();
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
		this.clearAdvanceTimer();
		this.rootEl.classList.add('is-open');
		this.resetScrollX();
		this.requestDraw();
	}

	updateCursor(sessionKey: string, cursor: InkCursor): void {
		if (!this.session || this.session.key !== sessionKey || this.activePointerId !== null) {
			return;
		}
		this.session.doc.meta.cursor = clampCursor(cursor, this.session.doc.lines);
		this.session.doc.meta.selection = null;
		this.resetScrollX();
		this.session.onCursorChanged();
		this.requestDraw();
	}

	close(): void {
		if (!this.session) {
			return;
		}
		this.finishStroke();
		this.clearAdvanceTimer();
		const closing = this.session;
		this.session = null;
		this.rootEl.classList.remove('is-open');
		closing.onClose();
	}

	// ----------------------------------------------------------------- view

	// Builds a one-line view document containing only the words before the cursor, so the drawer
	// shows just the current line up to the insertion point.
	private drawerView(): DrawerView | null {
		const session = this.session;
		if (!session) {
			return null;
		}
		const cursor = clampCursor(session.doc.meta.cursor, session.doc.lines);
		const line = session.doc.lines[cursor.line];
		const words = line ? line.words.slice(0, cursor.word) : [];
		const viewDoc: InkDocument = {
			version: session.doc.version,
			meta: {
				lineHeight: session.doc.meta.lineHeight,
				cursor: { line: 0, word: words.length },
				selection: null,
			},
			lines: [{ id: line?.id ?? 'view', words }],
		};
		const rect = this.canvasEl.getBoundingClientRect();
		const cssHeight = rect.height || this.canvasEl.clientHeight || 200;
		const targetLineHeight = clamp(cssHeight * 0.5, 40, 240);
		const layout = layoutDocument(viewDoc, {
			contentWidthCss: Number.POSITIVE_INFINITY, // drawer never wraps; it scrolls horizontally
			targetLineHeightCss: targetLineHeight,
			sourceLineHeight: session.doc.meta.lineHeight,
			wordGapScale: this.getRuntimeConfig().wordGapScale,
			strokeFillScale: 1,
		});
		return { layout, viewCursor: { line: 0, word: words.length } };
	}

	private canvasSize(): { width: number; height: number } {
		const rect = this.canvasEl.getBoundingClientRect();
		return {
			width: rect.width || this.canvasEl.clientWidth || 480,
			height: rect.height || this.canvasEl.clientHeight || 200,
		};
	}

	// Position the line start sensibly: from the left if it fits, otherwise keep the caret in view.
	private resetScrollX(): void {
		const view = this.drawerView();
		if (!view) {
			return;
		}
		const { width } = this.canvasSize();
		const caret = view.layout.caretRect(view.viewCursor);
		this.scrollX = caret.x <= width * 0.7 ? 0 : caret.x - width * 0.5;
	}

	private caretLocalX(view: DrawerView): number {
		return view.layout.caretRect(view.viewCursor).x - this.scrollX;
	}

	private clearAdvanceTimer(): void {
		if (this.advanceTimer) {
			window.clearTimeout(this.advanceTimer);
			this.advanceTimer = 0;
		}
	}

	private scheduleAdvanceIfNeeded(): void {
		const view = this.drawerView();
		if (!view) {
			return;
		}
		const { width } = this.canvasSize();
		if (this.caretLocalX(view) <= width * ADVANCE_SOFT_RATIO) {
			return;
		}
		this.clearAdvanceTimer();
		this.advanceTimer = window.setTimeout(() => {
			this.advanceTimer = 0;
			this.advanceView();
		}, ADVANCE_DELAY_MS);
	}

	private advanceView(): void {
		const view = this.drawerView();
		if (!view) {
			return;
		}
		const { width } = this.canvasSize();
		const caret = view.layout.caretRect(view.viewCursor);
		this.scrollX = Math.max(0, caret.x - width * 0.4);
		this.requestDraw();
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
		const view = this.drawerView();
		if (!session || !view) {
			return;
		}
		const { width: cssWidthRaw, height: cssHeightRaw } = this.canvasSize();
		const cssWidth = Math.floor(cssWidthRaw);
		const cssHeight = Math.floor(cssHeightRaw);
		if (cssWidth <= 0 || cssHeight <= 0) {
			return;
		}
		resizeCanvasForDpr(this.canvasEl, cssWidth, cssHeight, false);
		const ctx = this.canvasEl.getContext('2d');
		if (!ctx) {
			return;
		}

		const caret = view.layout.caretRect(view.viewCursor);
		// Vertical placement is fixed (single line) so it never jumps between strokes.
		this.scrollY = caret.baselineY - cssHeight * 0.62;

		const dpr = Math.max(1, window.devicePixelRatio || 1);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssWidth, cssHeight);
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, cssWidth, cssHeight);

		if (this.getRuntimeConfig().showWritingLine) {
			const baselineLocalY = caret.baselineY - this.scrollY;
			ctx.strokeStyle = '#a5b4c6';
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(0, baselineLocalY);
			ctx.lineTo(cssWidth, baselineLocalY);
			ctx.stroke();
		}

		const widthScale = view.layout.cssPerSource;
		for (const word of view.layout.words) {
			for (const laid of word.strokes) {
				const points = laid.points.map((p) => ({ x: p.x - this.scrollX, y: p.y - this.scrollY }));
				const widthPx = Math.max(1, laid.stroke.width * widthScale * (laid.stroke.bold ? 1.7 : 1));
				drawLaidStroke(ctx, points, widthPx, laid.stroke.color);
			}
		}

		// Caret at the insertion point (right end of the shown content).
		ctx.strokeStyle = '#2563eb';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(caret.x - this.scrollX, caret.y - this.scrollY);
		ctx.lineTo(caret.x - this.scrollX, caret.y + caret.height - this.scrollY);
		ctx.stroke();

		// Active (in-progress) stroke, drawn raw where the pen is.
		if (this.activeStroke && this.activeStroke.length > 0) {
			drawLaidStroke(
				ctx,
				this.activeStroke.map((p) => ({ x: p.x, y: p.y })),
				Math.max(1, 2.4),
				'#111827',
			);
		}

		this.pasteButtonEl.disabled = fragmentIsEmpty(getClipboard());
	}

	// ----------------------------------------------------------------- input

	private attachListeners(): void {
		this.canvasEl.addEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.addEventListener('pointermove', this.onPointerMove);
		this.canvasEl.addEventListener('pointerup', this.onPointerUp);
		this.canvasEl.addEventListener('pointercancel', this.onPointerUp);
		this.eraseButtonEl.addEventListener('click', this.onErase);
		this.newLineButtonEl.addEventListener('click', this.onNewLine);
		this.pasteButtonEl.addEventListener('click', this.onPaste);
		this.closeButtonEl.addEventListener('click', this.onCloseClick);
		this.rootEl.addEventListener('pointerdown', this.onBackdropPointerDown);
	}

	private detachListeners(): void {
		this.canvasEl.removeEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.removeEventListener('pointermove', this.onPointerMove);
		this.canvasEl.removeEventListener('pointerup', this.onPointerUp);
		this.canvasEl.removeEventListener('pointercancel', this.onPointerUp);
		this.eraseButtonEl.removeEventListener('click', this.onErase);
		this.newLineButtonEl.removeEventListener('click', this.onNewLine);
		this.pasteButtonEl.removeEventListener('click', this.onPaste);
		this.closeButtonEl.removeEventListener('click', this.onCloseClick);
		this.rootEl.removeEventListener('pointerdown', this.onBackdropPointerDown);
	}

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.session || this.activePointerId !== null) {
			return;
		}
		event.preventDefault();
		this.lastInteractionAt = Date.now();

		// If a delayed advance is pending and the caret is already near the edge, advance now so
		// there's room; otherwise cancel it (the user is staying put, e.g. dotting an i).
		const view = this.drawerView();
		this.clearAdvanceTimer();
		if (view && this.caretLocalX(view) > this.canvasSize().width * ADVANCE_HARD_RATIO) {
			this.advanceView();
		}

		this.activePointerId = event.pointerId;
		if (this.getRuntimeConfig().usePointerCapture) {
			try {
				this.canvasEl.setPointerCapture(event.pointerId);
			} catch {
				/* iOS can reject capture during fast pen input */
			}
		}
		// Starting to write clears any selection carried over from the rendered view.
		this.session.doc.meta.selection = null;
		this.activeStroke = [];
		this.appendActivePoint(event);
		this.requestDraw();
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (this.activePointerId !== event.pointerId || !this.activeStroke) {
			return;
		}
		event.preventDefault();
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
		this.finishStroke();
	};

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
		const view = this.drawerView();
		if (!view) {
			return;
		}
		const layout = view.layout;
		const cssPerSource = layout.cssPerSource || 1;
		const cursor = clampCursor(session.doc.meta.cursor, session.doc.lines);

		// Captured points in the view's layout space.
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

		// Continue the current (last shown) word if the new stroke is close to it; else new word.
		const currentWordLaid = layout.words.find((w) => w.word === view.viewCursor.word - 1);
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
			const caret = layout.caretRect(view.viewCursor);
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
		// Don't jump the view on lift-off; only advance (after a delay) if we've neared the edge.
		this.scheduleAdvanceIfNeeded();
		session.onContentChanged();
		this.requestDraw();
	}

	// ----------------------------------------------------------------- buttons

	private onPaste = (): void => {
		const session = this.session;
		const clip = getClipboard();
		if (!session || fragmentIsEmpty(clip)) {
			return;
		}
		insertFragmentAtCursor(session.doc, clip!);
		this.resetScrollX();
		session.onContentChanged();
		this.requestDraw();
	};

	private onErase = (): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		eraseAtCursor(session.doc);
		this.resetScrollX();
		session.onContentChanged();
		this.requestDraw();
	};

	private onNewLine = (): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		splitLineAtCursor(session.doc);
		this.resetScrollX();
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

	// ----------------------------------------------------------------- diagnostics (command palette)

	runBasicDiagnostics(): InkDiagnosticResult[] {
		const doc = this.session?.doc;
		return [
			{
				name: 'layout-engine',
				pass: true,
				detail: doc
					? `lines=${doc.lines.length}, cursor=${doc.meta.cursor.line}:${doc.meta.cursor.word}`
					: 'no active session',
			},
		];
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
