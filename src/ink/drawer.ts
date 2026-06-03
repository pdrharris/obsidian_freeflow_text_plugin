import {
	createStrokeId,
	INK_BASELINE_RATIO_FROM_TOP,
	INK_LINE_BREAK_MARKER_PREFIX,
	InkDocument,
	InkStroke,
	InkViewport,
	isLineBreakMarkerStroke,
} from './model';
import { drawDrawerCanvas, type InsertionLinePreference } from './render';

const STEP_RATIO = 0.72;
const DEFAULT_PEN_COLOR = '#111827';
const DEFAULT_PEN_WIDTH = 3;
const NEW_LINE_START_PADDING = 24;

export interface DrawerSession {
	key: string;
	doc: InkDocument;
	viewport: InkViewport;
	cursorIndex: number;
	linePreference: InsertionLinePreference;
	onDocumentChanged: () => void;
	onViewportChanged: (viewport: InkViewport) => void;
	onCursorChanged: (cursorIndex: number) => void;
	onLinePreferenceChanged: (linePreference: InsertionLinePreference) => void;
	onClose: () => void;
}

export interface DrawerRuntimeConfig {
	wrapWidth: number;
	wordGapScale: number;
	idleAdvanceMs: number;
	showWritingLine: boolean;
}

export interface InkDiagnosticResult {
	name: string;
	pass: boolean;
	detail: string;
}

export class InkDrawer {
	private readonly getRuntimeConfig: () => DrawerRuntimeConfig;
	private readonly rootEl: HTMLDivElement;
	private readonly sheetEl: HTMLDivElement;
	private readonly canvasEl: HTMLCanvasElement;
	private readonly eraseButtonEl: HTMLButtonElement;
	private readonly newLineButtonEl: HTMLButtonElement;
	private readonly closeButtonEl: HTMLButtonElement;
	private readonly statusEl: HTMLDivElement;

	private session: DrawerSession | null = null;
	private activePointerId: number | null = null;
	private activeStroke: InkStroke | null = null;
	private hasPenInSession = false;
	private redrawQueued = false;
	private lastLocalX: number | null = null;
	private pendingAdvanceOnRelease = false;
	private idleAdvanceTimer = 0;
	private snapNextStrokeToCursor = false;
	private pendingSnapAnchorX: number | null = null;

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
		this.eraseButtonEl = activeDocument.createElement('button');
		this.eraseButtonEl.type = 'button';
		this.eraseButtonEl.className = 'freeflow-ink-drawer-btn';
		this.eraseButtonEl.textContent = 'Erase';
		rightButtons.appendChild(this.eraseButtonEl);
		this.newLineButtonEl = activeDocument.createElement('button');
		this.newLineButtonEl.type = 'button';
		this.newLineButtonEl.className = 'freeflow-ink-drawer-btn';
		this.newLineButtonEl.textContent = 'New line';
		rightButtons.appendChild(this.newLineButtonEl);

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
		this.updateToolUi();
	}

	destroy(): void {
		this.close();
		this.detachListeners();
		this.clearIdleAdvanceTimer();
		this.rootEl.remove();
	}

	refreshLayout(): void {
		this.requestDraw();
	}

	runBasicDiagnostics(): InkDiagnosticResult[] {
		const lineHeight = 180;
		const y1 = lineHeight;
		const y2 = lineHeight * 2;
		const y3 = lineHeight * 3;
		const now = Date.now();
		const epsilon = 0.01;
		const results: InkDiagnosticResult[] = [];

		const makeStroke = (id: string, minX: number, maxX: number, y: number): InkStroke => ({
			id,
			tool: 'pen',
			color: '#111827',
			width: 3,
			points: [
				{ x: minX, y, pressure: 0.5, time: now },
				{ x: maxX, y, pressure: 0.5, time: now + 1 },
			],
		});
		const approx = (value: number, expected: number): boolean =>
			Math.abs(value - expected) <= epsilon;
		const centerY = (stroke: InkStroke | undefined): number | null => {
			if (!stroke) {
				return null;
			}
			const bounds = this.getStrokeBounds(stroke);
			return bounds ? bounds.centerY : null;
		};
		const createSession = (doc: InkDocument): DrawerSession => ({
			key: 'diagnostic',
			doc,
			viewport: {
				viewportX: 0,
				lineOffsetY: lineHeight,
			},
			cursorIndex: 0,
			linePreference: 'auto',
			onDocumentChanged: () => {
				/* noop */
			},
			onViewportChanged: () => {
				/* noop */
			},
			onCursorChanged: () => {
				/* noop */
			},
			onLinePreferenceChanged: () => {
				/* noop */
			},
			onClose: () => {
				/* noop */
			},
		});

		const emptyDoc: InkDocument = {
			version: 1,
			meta: { lineHeight },
			strokes: [],
		};
		const emptyIndex = this.resolveNewlineInsertionIndex(
			emptyDoc,
			0,
			y1,
			NEW_LINE_START_PADDING,
			lineHeight,
		);
		const emptyChanged = this.applyCarriageReturnAtCursor(
			createSession(emptyDoc),
			emptyIndex,
			y1,
			y2,
			NEW_LINE_START_PADDING,
			NEW_LINE_START_PADDING,
			lineHeight,
		);
		results.push({
			name: 'Empty block newline baseline',
			pass: emptyIndex === 0 && !emptyChanged && emptyDoc.strokes.length === 0,
			detail: `index=${emptyIndex}, moved=${emptyChanged ? 'yes' : 'no'}, strokes=${emptyDoc.strokes.length}`,
		});

		const eolDoc: InkDocument = {
			version: 1,
			meta: { lineHeight },
			strokes: [
				makeStroke('eol-a', 40, 75, y1),
				makeStroke('eol-b', 95, 132, y1),
				makeStroke('eol-c', 155, 190, y1),
			],
		};
		const eolIndex = this.resolveNewlineInsertionIndex(
			eolDoc,
			eolDoc.strokes.length,
			y1,
			220,
			lineHeight,
		);
		const eolLastBefore = centerY(eolDoc.strokes[eolDoc.strokes.length - 1]);
		const eolChanged = this.applyCarriageReturnAtCursor(
			createSession(eolDoc),
			eolIndex,
			y1,
			y2,
			NEW_LINE_START_PADDING,
			220,
			lineHeight,
		);
		const eolLastAfter = centerY(eolDoc.strokes[eolDoc.strokes.length - 1]);
		results.push({
			name: 'End-of-line newline keeps trailing stroke',
			pass:
				eolIndex === eolDoc.strokes.length &&
				!eolChanged &&
				typeof eolLastBefore === 'number' &&
				typeof eolLastAfter === 'number' &&
				approx(eolLastBefore, eolLastAfter),
			detail: `index=${eolIndex}, moved=${eolChanged ? 'yes' : 'no'}, lastYBefore=${eolLastBefore ?? 'n/a'}, lastYAfter=${eolLastAfter ?? 'n/a'}`,
		});

		const splitDoc: InkDocument = {
			version: 1,
			meta: { lineHeight },
			strokes: [
				makeStroke('split-a', 38, 70, y1),
				makeStroke('split-b', 95, 124, y1),
				makeStroke('split-c', 145, 178, y1),
				makeStroke('split-d', 44, 86, y2),
			],
		};
		const splitIndex = this.resolveNewlineInsertionIndex(splitDoc, 1, y1, 90, lineHeight);
		const splitChanged = this.applyCarriageReturnAtCursor(
			createSession(splitDoc),
			splitIndex,
			y1,
			y2,
			NEW_LINE_START_PADDING,
			90,
			lineHeight,
		);
		const splitA = splitDoc.strokes.find((stroke) => stroke.id === 'split-a');
		const splitB = splitDoc.strokes.find((stroke) => stroke.id === 'split-b');
		const splitC = splitDoc.strokes.find((stroke) => stroke.id === 'split-c');
		const splitD = splitDoc.strokes.find((stroke) => stroke.id === 'split-d');
		const splitAY = centerY(splitA);
		const splitBY = centerY(splitB);
		const splitCY = centerY(splitC);
		const splitDY = centerY(splitD);
		results.push({
			name: 'Mid-line newline shifts trailing and downstream lines',
			pass:
				splitIndex === 1 &&
				splitChanged &&
				typeof splitAY === 'number' &&
				typeof splitBY === 'number' &&
				typeof splitCY === 'number' &&
				typeof splitDY === 'number' &&
				approx(splitAY, y1) &&
				approx(splitBY, y2) &&
				approx(splitCY, y2) &&
				approx(splitDY, y3),
			detail: `index=${splitIndex}, moved=${splitChanged ? 'yes' : 'no'}, y=[a:${splitAY ?? 'n/a'}, b:${splitBY ?? 'n/a'}, c:${splitCY ?? 'n/a'}, d:${splitDY ?? 'n/a'}]`,
		});

		const markerDoc: InkDocument = {
			version: 1,
			meta: { lineHeight },
			strokes: [
				this.createLineBreakMarkerStroke(NEW_LINE_START_PADDING, y2),
				this.createLineBreakMarkerStroke(NEW_LINE_START_PADDING, y3),
			],
		};
		const markerPruned = this.pruneLineBreakMarkersIfNoVisibleStrokes(markerDoc);
		results.push({
			name: 'Marker-only block cleanup after erase',
			pass: markerPruned && markerDoc.strokes.length === 0,
			detail: `pruned=${markerPruned ? 'yes' : 'no'}, remaining=${markerDoc.strokes.length}`,
		});

		return results;
	}

	open(session: DrawerSession): void {
		if (this.session && this.session.key !== session.key) {
			this.close();
		}

		this.session = session;
		this.session.cursorIndex = this.clampCursorIndex(
			this.session.cursorIndex,
			this.session.doc.strokes.length,
		);
		this.session.linePreference = this.session.linePreference ?? 'auto';
		this.session.onCursorChanged(this.session.cursorIndex);
		this.session.onLinePreferenceChanged(this.session.linePreference);
		this.activePointerId = null;
		this.activeStroke = null;
		this.hasPenInSession = false;
		this.lastLocalX = null;
		this.snapNextStrokeToCursor = true;
		this.pendingSnapAnchorX = null;
		this.pendingAdvanceOnRelease = false;
		this.clearIdleAdvanceTimer();
		this.updateToolUi();

		this.rootEl.classList.add('is-open');
		this.requestDraw();
	}

	updateCursor(
		sessionKey: string,
		cursorIndex: number,
		linePreference: InsertionLinePreference,
		viewport: InkViewport,
	): void {
		if (!this.session || this.session.key !== sessionKey) {
			return;
		}
		if (this.activePointerId !== null) {
			return;
		}

		this.clearIdleAdvanceTimer();
		this.pendingAdvanceOnRelease = false;
		this.session.cursorIndex = this.clampCursorIndex(cursorIndex, this.session.doc.strokes.length);
		this.session.linePreference = linePreference;
		this.snapNextStrokeToCursor = true;
		this.pendingSnapAnchorX = null;
		this.session.viewport = viewport;
		this.session.onCursorChanged(this.session.cursorIndex);
		this.session.onLinePreferenceChanged(this.session.linePreference);
		this.session.onViewportChanged(this.session.viewport);
		this.requestDraw();
	}

	close(): void {
		if (!this.session) {
			return;
		}
		this.clearIdleAdvanceTimer();
		this.finishStroke(false);
		const closingSession = this.session;
		this.snapNextStrokeToCursor = false;
		this.pendingSnapAnchorX = null;
		this.session = null;
		this.rootEl.classList.remove('is-open');
		closingSession.onClose();
	}

	private attachListeners(): void {
		this.canvasEl.addEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.addEventListener('pointermove', this.onPointerMove);
		this.canvasEl.addEventListener('pointerup', this.onPointerUp);
		this.canvasEl.addEventListener('pointercancel', this.onPointerCancel);
		this.canvasEl.addEventListener('lostpointercapture', this.onLostPointerCapture);
		window.addEventListener('resize', this.onResize);
		this.eraseButtonEl.addEventListener('click', this.onEraseLastStroke);
		this.newLineButtonEl.addEventListener('click', this.onNewLine);
		this.closeButtonEl.addEventListener('click', this.onClose);
		this.rootEl.addEventListener('click', this.onBackdropClick);
	}

	private detachListeners(): void {
		this.canvasEl.removeEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.removeEventListener('pointermove', this.onPointerMove);
		this.canvasEl.removeEventListener('pointerup', this.onPointerUp);
		this.canvasEl.removeEventListener('pointercancel', this.onPointerCancel);
		this.canvasEl.removeEventListener('lostpointercapture', this.onLostPointerCapture);
		window.removeEventListener('resize', this.onResize);
		this.eraseButtonEl.removeEventListener('click', this.onEraseLastStroke);
		this.newLineButtonEl.removeEventListener('click', this.onNewLine);
		this.closeButtonEl.removeEventListener('click', this.onClose);
		this.rootEl.removeEventListener('click', this.onBackdropClick);
	}

	private onResize = (): void => {
		this.requestDraw();
	};

	private onBackdropClick = (event: MouseEvent): void => {
		if (event.target === this.rootEl) {
			this.close();
		}
	};

	private onEraseLastStroke = (): void => {
		this.clearIdleAdvanceTimer();
		this.eraseLastStroke();
	};

	private onNewLine = (): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		this.clearIdleAdvanceTimer();
		const lineHeight = Math.max(80, session.doc.meta.lineHeight);
		const cursorAnchor = this.getCursorAnchorPoint(session);
		const splitX = cursorAnchor?.x ?? NEW_LINE_START_PADDING;
		const requestedIndex = this.resolveEffectiveInsertionIndex(session);
		const anchorY =
			typeof cursorAnchor?.y === 'number' && Number.isFinite(cursorAnchor.y)
				? Math.max(cursorAnchor.y, session.viewport.lineOffsetY)
				: session.viewport.lineOffsetY;
		const currentLineStart = this.quantizeLineOffset(anchorY, lineHeight);
		const targetLineStart = currentLineStart + lineHeight;
		const nextLineStartX = NEW_LINE_START_PADDING;
		const insertionIndex = this.resolveNewlineInsertionIndex(
			session.doc,
			requestedIndex,
			currentLineStart,
			splitX,
			lineHeight,
		);
		this.applyCarriageReturnAtCursor(
			session,
			insertionIndex,
			currentLineStart,
			targetLineStart,
			nextLineStartX,
			splitX,
			lineHeight,
		);
		session.doc.strokes.splice(
			insertionIndex,
			0,
			this.createLineBreakMarkerStroke(nextLineStartX, targetLineStart),
		);
		session.cursorIndex = insertionIndex + 1;
		session.linePreference = 'next';
		session.viewport = {
			viewportX: 0,
			lineOffsetY: Math.max(lineHeight, targetLineStart),
		};
		session.onViewportChanged(session.viewport);
		session.onCursorChanged(session.cursorIndex);
		session.onLinePreferenceChanged(session.linePreference);
		session.onDocumentChanged();
		this.snapNextStrokeToCursor = true;
		this.pendingSnapAnchorX = session.viewport.viewportX + nextLineStartX;
		this.lastLocalX = null;
		this.pendingAdvanceOnRelease = false;
		this.requestDraw();
	};

	private onClose = (): void => {
		this.close();
	};

	private onPointerDown = (event: PointerEvent): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		const incomingIsPenLike = this.isLikelyPenPointer(event);
		if (this.activePointerId !== null) {
			const activePointerLostCapture = !this.canvasEl.hasPointerCapture(this.activePointerId);
			if (activePointerLostCapture || incomingIsPenLike) {
				this.finishStroke(false);
			}
		}
		if (this.activePointerId !== null) {
			return;
		}
		this.clearIdleAdvanceTimer();
		if (this.hasPenInSession && !incomingIsPenLike) {
			return;
		}
		if (incomingIsPenLike) {
			this.hasPenInSession = true;
		}

		this.activePointerId = event.pointerId;
		this.canvasEl.setPointerCapture(event.pointerId);
		event.preventDefault();
		this.pendingAdvanceOnRelease = false;

		this.activeStroke = {
			id: createStrokeId(),
			tool: 'pen',
			color: DEFAULT_PEN_COLOR,
			width: DEFAULT_PEN_WIDTH,
			points: [],
		};
		this.pushStrokePoints(event);
		session.onDocumentChanged();
		this.requestDraw();
	};

	private onPointerMove = (event: PointerEvent): void => {
		const session = this.session;
		if (!session || this.activePointerId !== event.pointerId) {
			return;
		}
		event.preventDefault();

		if (!this.activeStroke) {
			return;
		}

		this.pushStrokePoints(event);
		session.onDocumentChanged();
		this.requestDraw();
	};

	private onPointerUp = (event: PointerEvent): void => {
		if (this.activePointerId !== event.pointerId) {
			return;
		}
		this.finishStroke(true);
	};

	private onPointerCancel = (event: PointerEvent): void => {
		if (this.activePointerId !== event.pointerId) {
			return;
		}
		this.finishStroke(false);
	};

	private onLostPointerCapture = (event: PointerEvent): void => {
		if (this.activePointerId === null) {
			return;
		}
		if (
			event.pointerId !== this.activePointerId &&
			this.canvasEl.hasPointerCapture(this.activePointerId)
		) {
			return;
		}
		this.finishStroke(false);
	};

	private finishStroke(applyPendingAdvance: boolean): void {
		const session = this.session;
		if (!session) {
			return;
		}
		if (this.activePointerId !== null && this.canvasEl.hasPointerCapture(this.activePointerId)) {
			this.canvasEl.releasePointerCapture(this.activePointerId);
		}

		let strokePeakLocalX: number | null = null;
		if (this.activeStroke && this.activeStroke.points.length > 0) {
			const insertionIndex = this.resolveEffectiveInsertionIndex(session);
			const cursorAnchor = this.getCursorAnchorPoint(session);
			const caretAnchorX =
				typeof this.pendingSnapAnchorX === 'number' && Number.isFinite(this.pendingSnapAnchorX)
					? this.pendingSnapAnchorX
					: (cursorAnchor?.x ?? null);
			if (this.snapNextStrokeToCursor) {
				this.snapNextStrokeToCursor = false;
				this.pendingSnapAnchorX = null;
			}
			const activeBounds = this.getStrokeBounds(this.activeStroke);
			const insertionAnchorX =
				activeBounds?.minX ??
				(typeof caretAnchorX === 'number' && Number.isFinite(caretAnchorX)
					? caretAnchorX
					: null);
			if (activeBounds) {
				strokePeakLocalX = activeBounds.maxX - session.viewport.viewportX;
			}
			session.doc.strokes.splice(insertionIndex, 0, this.activeStroke);
			this.shiftFollowingStrokesForInsertion(session.doc, insertionIndex, insertionAnchorX);
			session.cursorIndex = insertionIndex + 1;
			session.linePreference = 'prev';
			session.onCursorChanged(session.cursorIndex);
			session.onLinePreferenceChanged(session.linePreference);
			session.onDocumentChanged();
		}

		let didAdvanceOnRelease = false;
		if (applyPendingAdvance && this.pendingAdvanceOnRelease) {
			const drawerWidth =
				this.canvasEl.getBoundingClientRect().width || this.canvasEl.clientWidth || 0;
			if (drawerWidth > 0) {
				this.advanceStep(drawerWidth);
				didAdvanceOnRelease = true;
			}
		}

		this.activePointerId = null;
		this.activeStroke = null;
		this.lastLocalX = null;
		this.pendingAdvanceOnRelease = false;
		this.requestDraw();
		if (applyPendingAdvance && !didAdvanceOnRelease) {
			this.scheduleIdleAdvance(strokePeakLocalX);
		}
	}

	private eraseLastStroke(): void {
		const session = this.session;
		if (!session) {
			return;
		}

		if (this.activePointerId !== null) {
			return;
		}

		if (session.doc.strokes.length === 0) {
			return;
		}

		const cursorIndex = this.resolveEffectiveInsertionIndex(session);
		if (cursorIndex <= 0) {
			return;
		}
		const removeIndex = cursorIndex - 1;
		const removedStroke = session.doc.strokes[removeIndex];
		const removedBounds = removedStroke ? this.getStrokeBounds(removedStroke) : null;
		const removedWasLineBreak = !!removedStroke && isLineBreakMarkerStroke(removedStroke);

		session.doc.strokes.splice(removeIndex, 1);
		if (removedWasLineBreak && removedBounds) {
			const lineHeight = Math.max(80, session.doc.meta.lineHeight);
			this.collapseLineBreakGap(session.doc, removeIndex, removedBounds.centerY, lineHeight);
		}
		const removedOnlyMarkers = this.pruneLineBreakMarkersIfNoVisibleStrokes(session.doc);
		session.cursorIndex = removedOnlyMarkers ? 0 : removeIndex;
		session.linePreference = 'prev';
		session.onCursorChanged(session.cursorIndex);
		session.onLinePreferenceChanged(session.linePreference);

		const drawerWidth =
			this.canvasEl.getBoundingClientRect().width || this.canvasEl.clientWidth || 480;
		const prevStroke = removeIndex > 0 ? session.doc.strokes[removeIndex - 1] : undefined;
		const nextStroke = removeIndex < session.doc.strokes.length ? session.doc.strokes[removeIndex] : undefined;
		const prevPoint = prevStroke?.points[prevStroke.points.length - 1];
		const nextPoint = nextStroke?.points[0];
		const anchorPoint =
			prevPoint && nextPoint
				? {
					x: (prevPoint.x + nextPoint.x) * 0.5,
					y: (prevPoint.y + nextPoint.y) * 0.5,
				}
				: prevPoint || nextPoint;

		if (!anchorPoint || removedOnlyMarkers) {
			const lineHeight = Math.max(80, session.doc.meta.lineHeight);
			session.viewport = {
				viewportX: 0,
				lineOffsetY: lineHeight,
			};
		} else {
			const lineHeight = Math.max(80, session.doc.meta.lineHeight);
			session.viewport = {
				viewportX: Math.max(0, anchorPoint.x - drawerWidth * 0.5),
				lineOffsetY: this.quantizeLineOffset(anchorPoint.y, lineHeight),
			};
		}

		session.onViewportChanged(session.viewport);
		session.onDocumentChanged();
		this.snapNextStrokeToCursor = true;
		this.pendingSnapAnchorX = null;
		this.pendingAdvanceOnRelease = false;
		this.requestDraw();
	}

	private pushStrokePoints(event: PointerEvent): void {
		const session = this.session;
		if (!session || !this.activeStroke) {
			return;
		}

		const samples =
			typeof event.getCoalescedEvents === 'function'
				? event.getCoalescedEvents()
				: [event];
		const points = samples.length > 0 ? samples : [event];
		const rect = this.canvasEl.getBoundingClientRect();
		const rightEdgeTrigger = rect.width * 0.85;
		const baselineLocalY = rect.height * INK_BASELINE_RATIO_FROM_TOP;

		for (const sample of points) {
			const localX = sample.clientX - rect.left;
			const localY = sample.clientY - rect.top;
			if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
				continue;
			}

			const worldX = session.viewport.viewportX + localX;
			const worldY = session.viewport.lineOffsetY + (localY - baselineLocalY);
			const previous = this.activeStroke.points[this.activeStroke.points.length - 1];
			if (previous) {
				const dx = previous.x - worldX;
				const dy = previous.y - worldY;
				if (dx * dx + dy * dy < 0.35) {
					continue;
				}
			}

			this.activeStroke.points.push({
				x: worldX,
				y: worldY,
				pressure: sample.pressure > 0 ? sample.pressure : 0.5,
				time: Date.now(),
			});

			if (localX >= rightEdgeTrigger) {
				this.pendingAdvanceOnRelease = true;
			} else if (
				this.lastLocalX !== null &&
				this.lastLocalX > rect.width * 0.9 &&
				localX < rect.width * 0.15
			) {
				this.pendingAdvanceOnRelease = true;
			}

			this.lastLocalX = localX;
		}
	}

	private advanceStep(drawerWidth: number): void {
		const session = this.session;
		if (!session) {
			return;
		}
		const stepWidth = Math.max(120, Math.round(drawerWidth * STEP_RATIO));
		session.viewport = {
			viewportX: session.viewport.viewportX + stepWidth,
			lineOffsetY: session.viewport.lineOffsetY,
		};
		session.onViewportChanged(session.viewport);
	}

	private scheduleIdleAdvance(strokePeakLocalX: number | null): void {
		const session = this.session;
		if (!session || strokePeakLocalX === null) {
			return;
		}
		const delay = Math.max(500, this.getRuntimeConfig().idleAdvanceMs);
		this.clearIdleAdvanceTimer();
		this.idleAdvanceTimer = window.setTimeout(() => {
			this.idleAdvanceTimer = 0;
			if (!this.session || this.activePointerId !== null) {
				return;
			}
			const drawerWidth =
				this.canvasEl.getBoundingClientRect().width || this.canvasEl.clientWidth || 0;
			if (drawerWidth <= 0) {
				return;
			}
			const rightThreshold = drawerWidth * 0.52;
			if (strokePeakLocalX < rightThreshold) {
				return;
			}
			const targetLocalX = drawerWidth * 0.4;
			const rawShift = strokePeakLocalX - targetLocalX;
			if (rawShift <= drawerWidth * 0.05) {
				return;
			}
			const minShift = drawerWidth * 0.1;
			const maxShift = drawerWidth * 0.55;
			const shift = Math.round(Math.max(minShift, Math.min(maxShift, rawShift)));
			session.viewport = {
				viewportX: session.viewport.viewportX + shift,
				lineOffsetY: session.viewport.lineOffsetY,
			};
			session.onViewportChanged(session.viewport);
			this.requestDraw();
		}, delay);
	}

	private clearIdleAdvanceTimer(): void {
		if (!this.idleAdvanceTimer) {
			return;
		}
		window.clearTimeout(this.idleAdvanceTimer);
		this.idleAdvanceTimer = 0;
	}

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
		if (!session) {
			return;
		}
		const runtime = this.getRuntimeConfig();
		drawDrawerCanvas(
			this.canvasEl,
			session.doc,
			session.viewport.viewportX,
			session.viewport.lineOffsetY,
			session.cursorIndex,
			this.activeStroke,
			runtime.showWritingLine,
		);
	}

	private updateToolUi(): void {
		this.eraseButtonEl.classList.remove('is-active');
		this.statusEl.textContent = 'Pen';
	}

	private clampCursorIndex(cursorIndex: number, length: number): number {
		if (!Number.isFinite(cursorIndex)) {
			return Math.max(0, length);
		}
		const normalizedLength = Math.max(0, length);
		return Math.max(0, Math.min(normalizedLength, Math.floor(cursorIndex)));
	}

	private shiftFollowingStrokesForInsertion(
		doc: InkDocument,
		insertionIndex: number,
		insertionAnchorX: number | null,
	): void {
		const insertedStroke = doc.strokes[insertionIndex];
		if (!insertedStroke) {
			return;
		}
		const insertedBounds = this.getStrokeBounds(insertedStroke);
		if (!insertedBounds) {
			return;
		}

		const lineHeight = Math.max(80, doc.meta.lineHeight);
		const sameLineTolerance = Math.max(10, lineHeight * 0.6);
		const desiredGap = this.getInsertionWordGap(lineHeight);
		const boundaryX =
			typeof insertionAnchorX === 'number' && Number.isFinite(insertionAnchorX)
				? insertionAnchorX
				: insertedBounds.minX;
		const boundaryTolerance = Math.max(4, desiredGap * 0.5);

		let firstFollowingMinX = Number.POSITIVE_INFINITY;
		for (let index = insertionIndex + 1; index < doc.strokes.length; index += 1) {
			const stroke = doc.strokes[index];
			if (!stroke) {
				continue;
			}
			if (isLineBreakMarkerStroke(stroke)) {
				continue;
			}
			const bounds = this.getStrokeBounds(stroke);
			if (!bounds) {
				continue;
			}
			if (Math.abs(bounds.centerY - insertedBounds.centerY) > sameLineTolerance) {
				continue;
			}
			if (bounds.maxX < boundaryX - boundaryTolerance) {
				continue;
			}
			if (bounds.minX < firstFollowingMinX) {
				firstFollowingMinX = bounds.minX;
			}
		}

		if (!Number.isFinite(firstFollowingMinX)) {
			return;
		}

		const shiftDelta = insertedBounds.maxX + desiredGap - firstFollowingMinX;
		if (shiftDelta <= 0) {
			return;
		}

		for (let index = insertionIndex + 1; index < doc.strokes.length; index += 1) {
			const stroke = doc.strokes[index];
			if (!stroke) {
				continue;
			}
			if (isLineBreakMarkerStroke(stroke)) {
				continue;
			}
			const bounds = this.getStrokeBounds(stroke);
			if (!bounds) {
				continue;
			}
			if (Math.abs(bounds.centerY - insertedBounds.centerY) > sameLineTolerance) {
				continue;
			}
			if (bounds.maxX < boundaryX - boundaryTolerance) {
				continue;
			}
			for (const point of stroke.points) {
				point.x += shiftDelta;
			}
		}
	}

	private applyCarriageReturnAtCursor(
		session: DrawerSession,
		cursorIndex: number,
		currentLineStart: number,
		targetLineStart: number,
		targetStartX: number,
		splitX: number,
		lineHeight: number,
	): boolean {
		const sameLineTolerance = Math.max(10, lineHeight * 0.6);
		const splitXTolerance = Math.max(2, lineHeight * 0.03);

		let firstTrailingMinX = Number.POSITIVE_INFINITY;
		const trailingSameLineIndexes: number[] = [];
		const lowerLineIndexes: number[] = [];
		for (let index = cursorIndex; index < session.doc.strokes.length; index += 1) {
			const stroke = session.doc.strokes[index];
			if (!stroke) {
				continue;
			}
			const markerStroke = isLineBreakMarkerStroke(stroke);
			const bounds = this.getStrokeBounds(stroke);
			if (!bounds) {
				continue;
			}
			if (Math.abs(bounds.centerY - currentLineStart) <= sameLineTolerance) {
				if (bounds.maxX < splitX - splitXTolerance) {
					continue;
				}
				trailingSameLineIndexes.push(index);
				if (!markerStroke && bounds.minX < firstTrailingMinX) {
					firstTrailingMinX = bounds.minX;
				}
			}
		}

		for (let index = 0; index < session.doc.strokes.length; index += 1) {
			const stroke = session.doc.strokes[index];
			if (!stroke) {
				continue;
			}
			const bounds = this.getStrokeBounds(stroke);
			if (!bounds) {
				continue;
			}
			if (bounds.centerY > currentLineStart + sameLineTolerance) {
				lowerLineIndexes.push(index);
			}
		}

		if (trailingSameLineIndexes.length === 0 && lowerLineIndexes.length === 0) {
			return false;
		}

		const shiftX = Number.isFinite(firstTrailingMinX) ? targetStartX - firstTrailingMinX : 0;
		const shiftY = targetLineStart - currentLineStart;

		for (const index of trailingSameLineIndexes) {
			const stroke = session.doc.strokes[index];
			if (!stroke) {
				continue;
			}
			for (const point of stroke.points) {
				point.x += shiftX;
				point.y += shiftY;
			}
		}

		for (const index of lowerLineIndexes) {
			const stroke = session.doc.strokes[index];
			if (!stroke) {
				continue;
			}
			for (const point of stroke.points) {
				point.y += lineHeight;
			}
		}

		return true;
	}

	private resolveNewlineInsertionIndex(
		doc: InkDocument,
		requestedIndex: number,
		currentLineStart: number,
		splitX: number,
		lineHeight: number,
	): number {
		const clampedIndex = this.clampCursorIndex(requestedIndex, doc.strokes.length);
		const sameLineTolerance = Math.max(10, lineHeight * 0.6);
		const splitXTolerance = Math.max(2, lineHeight * 0.03);
		let firstLowerIndex: number | null = null;

		for (let index = clampedIndex; index < doc.strokes.length; index += 1) {
			const stroke = doc.strokes[index];
			if (!stroke) {
				continue;
			}
			const markerStroke = isLineBreakMarkerStroke(stroke);
			const bounds = this.getStrokeBounds(stroke);
			if (!bounds) {
				continue;
			}
			if (markerStroke) {
				if (
					firstLowerIndex === null &&
					bounds.centerY > currentLineStart + sameLineTolerance
				) {
					firstLowerIndex = index;
				}
				continue;
			}
			if (Math.abs(bounds.centerY - currentLineStart) <= sameLineTolerance) {
				if (bounds.maxX >= splitX - splitXTolerance) {
					return index;
				}
				continue;
			}
			if (bounds.centerY > currentLineStart + sameLineTolerance) {
				return firstLowerIndex ?? index;
			}
		}

		return firstLowerIndex ?? doc.strokes.length;
	}

	private resolveEffectiveInsertionIndex(session: DrawerSession): number {
		return this.clampCursorIndex(session.cursorIndex, session.doc.strokes.length);
	}

	private collapseLineBreakGap(
		doc: InkDocument,
		fromIndex: number,
		lineY: number,
		lineHeight: number,
	): void {
		const sameLineTolerance = Math.max(10, lineHeight * 0.6);
		for (let index = fromIndex; index < doc.strokes.length; index += 1) {
			const stroke = doc.strokes[index];
			if (!stroke) {
				continue;
			}
			const bounds = this.getStrokeBounds(stroke);
			if (!bounds) {
				continue;
			}
			if (bounds.centerY < lineY - sameLineTolerance) {
				continue;
			}
			for (const point of stroke.points) {
				point.y -= lineHeight;
			}
		}
	}

	private createLineBreakMarkerStroke(x: number, y: number): InkStroke {
		return {
			id: `${INK_LINE_BREAK_MARKER_PREFIX}${createStrokeId()}`,
			tool: 'pen',
			color: 'rgba(0,0,0,0)',
			width: 1,
			points: [
				{
					x,
					y,
					pressure: 0,
					time: Date.now(),
				},
			],
		};
	}

	private getInsertionWordGap(lineHeight: number): number {
		const wordGapScale = Math.max(0.8, Math.min(2.5, this.getRuntimeConfig().wordGapScale));
		const wrapWordGapThreshold = Math.max(8, Math.min(48, lineHeight * 0.12 * wordGapScale));
		return wrapWordGapThreshold + 6;
	}

	private alignStrokeToCursorX(stroke: InkStroke, cursorX: number): void {
		const firstPoint = stroke.points[0];
		if (!firstPoint) {
			return;
		}
		const shiftX = cursorX - firstPoint.x;
		if (!Number.isFinite(shiftX) || Math.abs(shiftX) < 0.5) {
			return;
		}
		for (const point of stroke.points) {
			point.x += shiftX;
		}
	}

	private getStrokeBounds(stroke: InkStroke): {
		minX: number;
		maxX: number;
		centerY: number;
	} | null {
		const firstPoint = stroke.points[0];
		if (!firstPoint) {
			return null;
		}

		let minX = firstPoint.x;
		let maxX = firstPoint.x;
		let minY = firstPoint.y;
		let maxY = firstPoint.y;
		for (const point of stroke.points) {
			if (point.x < minX) minX = point.x;
			if (point.x > maxX) maxX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.y > maxY) maxY = point.y;
		}

		return {
			minX,
			maxX,
			centerY: (minY + maxY) * 0.5,
		};
	}

	private getCursorAnchorPoint(session: DrawerSession): { x: number; y: number } | null {
		const cursorIndex = this.clampCursorIndex(session.cursorIndex, session.doc.strokes.length);
		const lineHeight = Math.max(80, session.doc.meta.lineHeight);
		const prevStroke = cursorIndex > 0 ? session.doc.strokes[cursorIndex - 1] : undefined;
		const nextStroke =
			cursorIndex < session.doc.strokes.length ? session.doc.strokes[cursorIndex] : undefined;
		const prevBounds = prevStroke ? this.getCursorAnchorBounds(prevStroke) : null;
		const nextBounds = nextStroke ? this.getCursorAnchorBounds(nextStroke) : null;

		if (prevBounds && nextBounds) {
			const isSameLine = Math.abs(nextBounds.centerY - prevBounds.centerY) <= lineHeight * 0.6;
			if (!isSameLine) {
				if (session.linePreference === 'prev') {
					return {
						x: prevBounds.maxX + 20,
						y: prevBounds.centerY,
					};
				}
				if (session.linePreference === 'next') {
					return {
						x: Math.max(0, nextBounds.minX - 24),
						y: nextBounds.centerY,
					};
				}
				const viewportLineStart =
					Math.floor(Math.max(lineHeight, session.viewport.lineOffsetY) / lineHeight) * lineHeight;
				const prevDistance = Math.abs(prevBounds.centerY - viewportLineStart);
				const nextDistance = Math.abs(nextBounds.centerY - viewportLineStart);
				if (nextDistance < prevDistance) {
					return {
						x: Math.max(0, nextBounds.minX - 24),
						y: nextBounds.centerY,
					};
				}
				return {
					x: prevBounds.maxX + 20,
					y: prevBounds.centerY,
				};
			}
			return {
				x: (prevBounds.maxX + nextBounds.minX) * 0.5,
				y: (prevBounds.centerY + nextBounds.centerY) * 0.5,
			};
		}

		if (prevBounds) {
			return {
				x: prevBounds.maxX + 24,
				y: prevBounds.centerY,
			};
		}

		if (nextBounds) {
			return {
				x: Math.max(0, nextBounds.minX - 24),
				y: nextBounds.centerY,
			};
		}

		return null;
	}

	private getCursorAnchorBounds(stroke: InkStroke): {
		minX: number;
		maxX: number;
		centerY: number;
	} | null {
		if (isLineBreakMarkerStroke(stroke)) {
			const markerPoint = stroke.points[0];
			if (!markerPoint) {
				return null;
			}
			const markerX = Number.isFinite(markerPoint.x) ? markerPoint.x : NEW_LINE_START_PADDING;
			const markerY = Number.isFinite(markerPoint.y) ? markerPoint.y : 0;
			return {
				minX: markerX,
				maxX: markerX,
				centerY: markerY,
			};
		}
		return this.getStrokeBounds(stroke);
	}

	private isLikelyPenPointer(event: PointerEvent): boolean {
		if (event.pointerType === 'pen') {
			return true;
		}
		if (event.pointerType !== 'touch') {
			return false;
		}
		if (event.pressure > 0.15) {
			return true;
		}
		return event.width <= 3 && event.height <= 3;
	}

	private pruneLineBreakMarkersIfNoVisibleStrokes(doc: InkDocument): boolean {
		if (doc.strokes.length === 0) {
			return false;
		}
		const hasVisibleStroke = doc.strokes.some((stroke) => !isLineBreakMarkerStroke(stroke));
		if (hasVisibleStroke) {
			return false;
		}
		doc.strokes.splice(0, doc.strokes.length);
		return true;
	}

	private quantizeLineOffset(y: number, lineHeight: number): number {
		if (!Number.isFinite(y)) {
			return lineHeight;
		}
		return Math.max(lineHeight, Math.round(y / lineHeight) * lineHeight);
	}
}
