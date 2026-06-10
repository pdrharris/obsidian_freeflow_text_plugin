// The floating writing drawer for the flowing-text ink model.
//
// The drawer is a focused writing surface that mimics how people actually write: it shows ONLY
// the current line and ONLY the content to the left of the insertion point, so new strokes
// appear exactly where the pen is (an append-at-the-end feel). The view stays put on pen lift
// (so you can dot an i / cross a t) and only advances horizontally — after a short delay — when
// writing nears the right edge. Captured strokes are converted to source coordinates and
// inserted into the logical tree via edit.ts.

import {
	InkCursor,
	InkDocument,
	InkStroke,
	InkWord,
	clampCursor,
	createStrokeId,
	fragmentIsEmpty,
	shiftWordX,
	wordBounds,
} from './doc';
import { getClipboard } from './clipboard';
import {
	eraseAtCursor,
	insertFragmentAtCursor,
	splitLineAtCursor,
	wordFromStroke,
} from './edit';
import { LayoutResult, layoutDocument } from './layout';
import { drawLaidStroke, drawUnderline, resizeCanvasForDpr, wordUnderline } from './render';
import { ColorPopupHandle, DEFAULT_INK_COLOR, openColorPopup } from './palette';

const BACKDROP_CLOSE_GUARD_MS = 420;
const MIN_POINT_DISTANCE_SQ = 0.35;
const ADVANCE_TARGET_RATIO = 0.4; // after advancing, the caret lands at this fraction of width
const ADVANCE_MIN_CARET_RATIO = 0.4; // don't bother advancing while there's still room to the left
const RAW_LOG_MAX = 4000; // ring buffer of raw pointer samples for iPad diagnostics

export interface DrawerRuntimeConfig {
	wrapWidth: number;
	wordGapScale: number;
	idleAdvanceMs: number;
	releaseAdvanceDelayMs: number;
	advanceTriggerRatio: number; // position of the orange "near the edge" line (fraction of width)
	showWritingLine: boolean;
	velocityWidth: boolean;
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

// One raw pointer event as the device delivered it — captured for iPad stroke-loss diagnostics.
interface RawPointerSample {
	phase: 'down' | 'move' | 'up' | 'cancel' | 'synth-down';
	pointerType: string;
	pointerId: number;
	x: number;
	y: number;
	pressure: number;
	coalesced: number;
	t: number;
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
	private readonly boldButtonEl: HTMLButtonElement;
	private readonly underlineButtonEl: HTMLButtonElement;
	private readonly colorButtonEl: HTMLButtonElement;
	private readonly colorSwatchEl: HTMLSpanElement;
	private readonly closeButtonEl: HTMLButtonElement;

	private session: DrawerSession | null = null;
	private activeStroke: ActivePoint[] | null = null;
	private activePointerId: number | null = null;
	private activeTouchId: number | null = null;
	private scrollX = 0;
	private scrollY = 0;
	private redrawQueued = false;
	private lastInteractionAt = 0;
	private advanceTimer = 0;

	// Raw pointer-event diagnostics (iPad stroke-loss). Always-on, cheap; dumped via command.
	private readonly rawLog: RawPointerSample[] = [];
	private synthStartCount = 0;
	private finalizedOnReentryCount = 0;
	private committedStrokeCount = 0;

	// Current "pen" style applied to new strokes.
	private penColor = DEFAULT_INK_COLOR;
	private penBold = false;
	private penUnderline = false;
	private colorPopup: ColorPopupHandle | null = null;

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
		// Plain glyph symbols rather than setIcon — Lucide SVGs render blank on some mobile builds.
		const makeIconButton = (glyph: string, label: string): HTMLButtonElement => {
			const btn = activeDocument.createElement('button');
			btn.type = 'button';
			btn.className = 'freeflow-ink-drawer-btn';
			btn.setAttribute('aria-label', label);
			btn.title = label;
			btn.setText(glyph);
			rightButtons.appendChild(btn);
			return btn;
		};
		this.eraseButtonEl = makeIconButton('⌫', 'Erase');
		this.newLineButtonEl = makeIconButton('↵', 'New line');
		this.boldButtonEl = makeIconButton('B', 'Bold');
		this.underlineButtonEl = makeIconButton('U', 'Underline');

		// Colour button shows the current pen colour as a swatch rather than an icon.
		this.colorButtonEl = activeDocument.createElement('button');
		this.colorButtonEl.type = 'button';
		this.colorButtonEl.className = 'freeflow-ink-drawer-btn freeflow-ink-color-btn';
		this.colorButtonEl.setAttribute('aria-label', 'Pen colour');
		this.colorButtonEl.title = 'Pen colour';
		this.colorSwatchEl = activeDocument.createElement('span');
		this.colorSwatchEl.className = 'freeflow-ink-color-btn-swatch';
		this.colorSwatchEl.style.backgroundColor = this.penColor;
		this.colorButtonEl.appendChild(this.colorSwatchEl);
		rightButtons.appendChild(this.colorButtonEl);

		this.pasteButtonEl = makeIconButton('📋', 'Paste');

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
		this.activeTouchId = null;
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
		this.colorPopup?.close();
		this.colorPopup = null;
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
			velocityWidth: this.getRuntimeConfig().velocityWidth,
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

	// On pen lift, schedule the view to advance. Two speeds: a short pause once the caret is past
	// the orange trigger line (running out of room), a long pause before it.
	private scheduleAdvanceAfterStroke(): void {
		const view = this.drawerView();
		if (!view) {
			return;
		}
		const { width } = this.canvasSize();
		const caretLocalX = this.caretLocalX(view);
		if (caretLocalX <= width * ADVANCE_MIN_CARET_RATIO) {
			return; // plenty of room to the left; nothing to advance
		}
		const config = this.getRuntimeConfig();
		const pastTrigger = caretLocalX >= width * config.advanceTriggerRatio;
		const delay = Math.max(0, pastTrigger ? config.releaseAdvanceDelayMs : config.idleAdvanceMs);
		this.clearAdvanceTimer();
		this.advanceTimer = window.setTimeout(() => {
			this.advanceTimer = 0;
			this.advanceView();
		}, delay);
	}

	// Forward-only: bring the caret back to ADVANCE_TARGET_RATIO, never scroll backwards.
	private advanceView(): void {
		const view = this.drawerView();
		if (!view) {
			return;
		}
		const { width } = this.canvasSize();
		const caret = view.layout.caretRect(view.viewCursor);
		this.scrollX = Math.max(this.scrollX, caret.x - width * ADVANCE_TARGET_RATIO);
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
			const underline = wordUnderline(word);
			if (underline) {
				drawUnderline(
					ctx,
					underline.minX - this.scrollX,
					underline.maxX - this.scrollX,
					underline.baselineY - this.scrollY,
					underline.color,
					widthScale,
				);
			}
			for (const laid of word.strokes) {
				const points = laid.points.map((p) => ({
					x: p.x - this.scrollX,
					y: p.y - this.scrollY,
					w: p.w,
				}));
				const widthPx = Math.max(1, laid.stroke.width * widthScale * (laid.stroke.bold ? 1.7 : 1));
				drawLaidStroke(ctx, points, widthPx, laid.stroke.color);
			}
		}

		// Dotted orange "near the right edge" guide line; writing advances once the caret passes it.
		const triggerX = cssWidth * this.getRuntimeConfig().advanceTriggerRatio;
		ctx.strokeStyle = '#f59e0b';
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 6]);
		ctx.beginPath();
		ctx.moveTo(triggerX, 0);
		ctx.lineTo(triggerX, cssHeight);
		ctx.stroke();
		ctx.setLineDash([]);

		// Caret at the insertion point (right end of the shown content).
		ctx.strokeStyle = '#2563eb';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(caret.x - this.scrollX, caret.y - this.scrollY);
		ctx.lineTo(caret.x - this.scrollX, caret.y + caret.height - this.scrollY);
		ctx.stroke();

		// Active (in-progress) stroke, drawn raw where the pen is, in the current pen style.
		if (this.activeStroke && this.activeStroke.length > 0) {
			drawLaidStroke(
				ctx,
				this.activeStroke.map((p) => ({ x: p.x, y: p.y })),
				Math.max(1, this.penBold ? 4 : 2.4),
				this.penColor,
			);
		}

		this.pasteButtonEl.disabled = fragmentIsEmpty(getClipboard());
	}

	// ----------------------------------------------------------------- input

	private attachListeners(): void {
		this.canvasEl.addEventListener('pointerdown', this.onPointerDown);
		// Move/up/cancel are bound to the window, not the canvas: a fast pen lift whose pointerup
		// lands off-canvas would otherwise be lost, leaving a stroke stuck open and swallowing the next.
		activeWindow.addEventListener('pointermove', this.onPointerMove);
		activeWindow.addEventListener('pointerup', this.onPointerUp);
		activeWindow.addEventListener('pointercancel', this.onPointerUp);
		// Touch events (passive:false + preventDefault) are the reliable stream for the Apple Pencil:
		// WebKit drops the synthesized pointerdown for fast strokes but still fires touchstart. On iOS
		// we drive capture from touch and ignore pointer events to avoid double-counting each contact.
		this.canvasEl.addEventListener('touchstart', this.onTouchStart, { passive: false });
		this.canvasEl.addEventListener('touchmove', this.onTouchMove, { passive: false });
		this.canvasEl.addEventListener('touchend', this.onTouchEnd, { passive: false });
		this.canvasEl.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
		this.eraseButtonEl.addEventListener('click', this.onErase);
		this.newLineButtonEl.addEventListener('click', this.onNewLine);
		this.boldButtonEl.addEventListener('click', this.onToggleBold);
		this.underlineButtonEl.addEventListener('click', this.onToggleUnderline);
		this.colorButtonEl.addEventListener('click', this.onColorButton);
		this.pasteButtonEl.addEventListener('click', this.onPaste);
		this.closeButtonEl.addEventListener('click', this.onCloseClick);
		this.rootEl.addEventListener('pointerdown', this.onBackdropPointerDown);
	}

	private detachListeners(): void {
		this.canvasEl.removeEventListener('pointerdown', this.onPointerDown);
		activeWindow.removeEventListener('pointermove', this.onPointerMove);
		activeWindow.removeEventListener('pointerup', this.onPointerUp);
		activeWindow.removeEventListener('pointercancel', this.onPointerUp);
		this.canvasEl.removeEventListener('touchstart', this.onTouchStart);
		this.canvasEl.removeEventListener('touchmove', this.onTouchMove);
		this.canvasEl.removeEventListener('touchend', this.onTouchEnd);
		this.canvasEl.removeEventListener('touchcancel', this.onTouchEnd);
		this.eraseButtonEl.removeEventListener('click', this.onErase);
		this.newLineButtonEl.removeEventListener('click', this.onNewLine);
		this.boldButtonEl.removeEventListener('click', this.onToggleBold);
		this.underlineButtonEl.removeEventListener('click', this.onToggleUnderline);
		this.colorButtonEl.removeEventListener('click', this.onColorButton);
		this.pasteButtonEl.removeEventListener('click', this.onPaste);
		this.closeButtonEl.removeEventListener('click', this.onCloseClick);
		this.rootEl.removeEventListener('pointerdown', this.onBackdropPointerDown);
	}

	// On iOS the Apple Pencil is captured via touch events; pointer events are ignored there because
	// WebKit also synthesizes a (less reliable) pointer stream for the same contact.
	private get touchDriven(): boolean {
		return this.getRuntimeConfig().allowAnyNonMousePointer;
	}

	// ------ pointer events (desktop / Android) ------

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.session || this.touchDriven) {
			return;
		}
		event.preventDefault();
		this.recordRaw('down', event, 1);
		// If a stroke is somehow still open (e.g. a pointerup we never received), commit it rather
		// than dropping this new pointerdown — that dropping is what swallowed rapid strokes.
		if (this.activeStroke !== null) {
			this.finalizedOnReentryCount += 1;
			this.finishStroke();
		}
		this.activePointerId = event.pointerId;
		if (this.getRuntimeConfig().usePointerCapture) {
			try {
				this.canvasEl.setPointerCapture(event.pointerId);
			} catch {
				/* capture can be rejected; harmless */
			}
		}
		this.beginStrokeAt(event.clientX, event.clientY, event.pressure);
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (!this.session || this.touchDriven) {
			return;
		}
		if (this.activePointerId !== event.pointerId || !this.activeStroke) {
			return;
		}
		event.preventDefault();
		const samples =
			typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
		const list = samples.length > 0 ? samples : [event];
		this.recordRaw('move', event, list.length);
		for (const sample of list) {
			this.appendPoint(sample.clientX, sample.clientY, sample.pressure);
		}
		this.requestDraw();
	};

	private onPointerUp = (event: PointerEvent): void => {
		if (this.touchDriven || this.activePointerId !== event.pointerId) {
			return;
		}
		event.preventDefault();
		this.recordRaw(event.type === 'pointercancel' ? 'cancel' : 'up', event, 1);
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

	// ------ touch events (iOS Apple Pencil) ------

	private onTouchStart = (event: TouchEvent): void => {
		if (!this.session || !this.touchDriven) {
			return;
		}
		const touch = event.changedTouches.item(0);
		if (!touch) {
			return;
		}
		event.preventDefault();
		// Finalize any open stroke before starting the next (covers a missed touchend).
		if (this.activeStroke !== null) {
			this.finalizedOnReentryCount += 1;
			this.finishStroke();
		}
		this.activeTouchId = touch.identifier;
		this.pushRaw('down', 'touch', touch.identifier, touch.clientX, touch.clientY, touchForce(touch), 1);
		this.beginStrokeAt(touch.clientX, touch.clientY, touchForce(touch));
	};

	private onTouchMove = (event: TouchEvent): void => {
		if (this.activeTouchId === null || !this.activeStroke) {
			return;
		}
		const touch = findTouch(event.changedTouches, this.activeTouchId);
		if (!touch) {
			return;
		}
		event.preventDefault();
		this.pushRaw('move', 'touch', touch.identifier, touch.clientX, touch.clientY, touchForce(touch), 1);
		this.appendPoint(touch.clientX, touch.clientY, touchForce(touch));
		this.requestDraw();
	};

	private onTouchEnd = (event: TouchEvent): void => {
		if (this.activeTouchId === null) {
			return;
		}
		const touch = findTouch(event.changedTouches, this.activeTouchId);
		if (touch) {
			event.preventDefault();
			this.pushRaw(
				event.type === 'touchcancel' ? 'cancel' : 'up',
				'touch',
				touch.identifier,
				touch.clientX,
				touch.clientY,
				0,
				1,
			);
		}
		this.lastInteractionAt = Date.now();
		this.finishStroke();
	};

	// ------ shared capture core ------

	private beginStrokeAt(clientX: number, clientY: number, pressure: number): void {
		if (!this.session) {
			return;
		}
		this.lastInteractionAt = Date.now();
		// Starting to write cancels any pending advance and clears a carried-over selection.
		this.clearAdvanceTimer();
		this.session.doc.meta.selection = null;
		this.activeStroke = [];
		this.appendPoint(clientX, clientY, pressure);
		this.requestDraw();
	}

	private appendPoint(clientX: number, clientY: number, pressure: number): void {
		if (!this.activeStroke) {
			return;
		}
		const rect = this.canvasEl.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
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
		this.activeStroke.push({ x, y, pressure: pressure > 0 ? pressure : 0.5, time: Date.now() });
	}

	private recordRaw(phase: RawPointerSample['phase'], event: PointerEvent, coalesced: number): void {
		this.pushRaw(
			phase,
			event.pointerType || 'unknown',
			event.pointerId,
			event.clientX,
			event.clientY,
			event.pressure,
			coalesced,
		);
	}

	private pushRaw(
		phase: RawPointerSample['phase'],
		pointerType: string,
		pointerId: number,
		clientX: number,
		clientY: number,
		pressure: number,
		coalesced: number,
	): void {
		const rect = this.canvasEl.getBoundingClientRect();
		this.rawLog.push({
			phase,
			pointerType,
			pointerId,
			x: Math.round(clientX - rect.left),
			y: Math.round(clientY - rect.top),
			pressure: Math.round((pressure || 0) * 100) / 100,
			coalesced,
			t: Math.round(performance.now()),
		});
		if (this.rawLog.length > RAW_LOG_MAX) {
			this.rawLog.shift();
		}
	}

	// ----------------------------------------------------------------- commit

	private finishStroke(): void {
		const session = this.session;
		const active = this.activeStroke;
		this.activePointerId = null;
		this.activeTouchId = null;
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
		const marginX = layout.marginX;
		const cursor = clampCursor(session.doc.meta.cursor, session.doc.lines);
		const line = session.doc.lines[cursor.line];
		if (!line) {
			return;
		}

		// Convert canvas points to LINE-ABSOLUTE source coordinates, using the same frame the
		// view was laid out in, so the stroke is stored exactly where it was drawn.
		const shownWords = line.words.slice(0, cursor.word);
		const firstShown = shownWords[0];
		const rowOriginSource = firstShown ? wordBounds(firstShown)?.minX ?? 0 : 0;
		const baselineY = layout.caretRect(view.viewCursor).baselineY;

		const points = active.map((p) => ({
			x: rowOriginSource + (p.x + this.scrollX - marginX) / cssPerSource,
			y: (p.y + this.scrollY - baselineY) / cssPerSource,
			pressure: p.pressure,
			time: p.time,
		}));
		const stroke: InkStroke = {
			id: createStrokeId(),
			width: Math.max(0.5, 2.4 / cssPerSource),
			color: this.penColor,
			points,
		};
		if (this.penBold) {
			stroke.bold = true;
		}
		if (this.penUnderline) {
			stroke.underline = true;
		}
		let sMinX = Infinity;
		let sMaxX = -Infinity;
		for (const p of points) {
			if (p.x < sMinX) sMinX = p.x;
			if (p.x > sMaxX) sMaxX = p.x;
		}

		// Words to the RIGHT of the insertion point are hidden in the drawer but still present.
		// They must never be merged into (that would draw the new stroke on top of them) — they
		// get pushed aside below. Only the shown words (left of the cursor) are merge candidates.
		const rightWords = line.words.slice(cursor.word);

		// Merge into the nearest SHOWN word within the word-gap threshold (overlap or close), else
		// make a new word. Either way the stroke keeps its absolute x, so its position is preserved.
		const threshold = Math.max(
			8,
			session.doc.meta.lineHeight * 0.12 * this.getRuntimeConfig().wordGapScale,
		);
		let mergeIndex = -1;
		let bestGap = threshold;
		for (let i = 0; i < cursor.word; i += 1) {
			const word = line.words[i];
			if (!word) {
				continue;
			}
			const b = wordBounds(word);
			if (!b) {
				continue;
			}
			const gap = Math.max(0, Math.max(sMinX, b.minX) - Math.min(sMaxX, b.maxX));
			if (gap < bestGap) {
				bestGap = gap;
				mergeIndex = i;
			}
		}

		let affected: InkWord;
		const existing = mergeIndex >= 0 ? line.words[mergeIndex] : undefined;
		if (existing) {
			existing.strokes.push(stroke);
			affected = existing;
		} else {
			// Insert the new word at the cursor, ahead of the right-of-cursor words.
			affected = wordFromStroke(stroke);
			line.words.splice(cursor.word, 0, affected);
		}

		// Push the right-of-cursor words along so the new content doesn't land on top of them.
		const affectedBounds = wordBounds(affected);
		const firstRight = rightWords[0];
		if (affectedBounds && firstRight) {
			const gap = session.doc.meta.lineHeight * 0.35;
			const delta = affectedBounds.maxX + gap - (wordBounds(firstRight)?.minX ?? 0);
			if (delta > 0) {
				for (const word of rightWords) {
					shiftWordX(word, delta);
				}
			}
		}

		// Keep words ordered left-to-right; put the cursor just after the affected word.
		line.words.sort((a, b) => (wordBounds(a)?.minX ?? 0) - (wordBounds(b)?.minX ?? 0));
		const affectedIndex = line.words.indexOf(affected);
		session.doc.meta.cursor = { line: cursor.line, word: affectedIndex + 1 };
		session.doc.meta.selection = null;
		this.committedStrokeCount += 1;

		// Don't jump the view on lift-off; only advance after the configured pause.
		this.scheduleAdvanceAfterStroke();
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

	private onToggleBold = (): void => {
		this.penBold = !this.penBold;
		this.updateStyleButtons();
		this.requestDraw();
	};

	private onToggleUnderline = (): void => {
		this.penUnderline = !this.penUnderline;
		this.updateStyleButtons();
		this.requestDraw();
	};

	private onColorButton = (): void => {
		if (this.colorPopup) {
			this.colorPopup.close();
			this.colorPopup = null;
			return;
		}
		this.colorPopup = openColorPopup(this.colorButtonEl, this.penColor, (color) => {
			this.penColor = color;
			this.colorSwatchEl.style.backgroundColor = color;
			this.colorPopup = null;
			this.requestDraw();
		});
	};

	// Reflect pen-state toggles on the toolbar buttons.
	private updateStyleButtons(): void {
		this.boldButtonEl.classList.toggle('is-active', this.penBold);
		this.underlineButtonEl.classList.toggle('is-active', this.penUnderline);
		this.colorSwatchEl.style.backgroundColor = this.penColor;
	}

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

	// Dumps the raw pointer capture so iPad stroke-loss can be diagnosed from real device data.
	getPencilTimingSummary(): string {
		if (this.rawLog.length === 0) {
			return 'No pointer samples captured yet. Open the drawer, write on the iPad, then run this again.';
		}
		const counts: Record<string, number> = {};
		let maxMoveGap = 0;
		let prevMoveT = 0;
		for (const s of this.rawLog) {
			const key = `${s.phase}:${s.pointerType}`;
			counts[key] = (counts[key] ?? 0) + 1;
			if (s.phase === 'move') {
				if (prevMoveT) {
					maxMoveGap = Math.max(maxMoveGap, s.t - prevMoveT);
				}
				prevMoveT = s.t;
			}
		}
		const header = Object.entries(counts)
			.map(([k, v]) => `${k}=${v}`)
			.join(' ');
		const tail = this.rawLog.slice(-700);
		const t0 = tail[0]?.t ?? 0;
		const lines = tail.map(
			(s) =>
				`${String(s.t - t0).padStart(6)} ${s.phase.padEnd(10)} ${s.pointerType.padEnd(5)} id=${s.pointerId} p=${s.pressure} (${s.x},${s.y}) co=${s.coalesced}`,
		);
		const downCount = this.rawLog.filter((s) => s.phase === 'down').length;
		return [
			`samples=${this.rawLog.length} downs=${downCount} committed=${this.committedStrokeCount} synthStarts=${this.synthStartCount} finalizedOnReentry=${this.finalizedOnReentryCount} maxMoveGapMs=${maxMoveGap}`,
			header,
			'',
			lines.join('\n'),
		].join('\n');
	}

	resetPencilTimingDiagnostics(): void {
		this.rawLog.length = 0;
		this.synthStartCount = 0;
		this.finalizedOnReentryCount = 0;
		this.committedStrokeCount = 0;
	}
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

// Apple Pencil reports contact force in Touch.force (0..1); fall back to a mid value when absent.
function touchForce(touch: Touch): number {
	return touch.force && touch.force > 0 ? touch.force : 0.5;
}

function findTouch(list: TouchList, id: number): Touch | null {
	for (let i = 0; i < list.length; i += 1) {
		const touch = list.item(i);
		if (touch && touch.identifier === id) {
			return touch;
		}
	}
	return null;
}
