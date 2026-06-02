import {
	createStrokeId,
	INK_BASELINE_RATIO_FROM_TOP,
	InkDocument,
	InkStroke,
	InkViewport,
} from './model';
import { drawDrawerCanvas } from './render';

const STEP_RATIO = 0.72;
const DEFAULT_PEN_COLOR = '#111827';
const DEFAULT_PEN_WIDTH = 3;

export interface DrawerSession {
	key: string;
	doc: InkDocument;
	viewport: InkViewport;
	cursorIndex: number;
	onDocumentChanged: () => void;
	onViewportChanged: (viewport: InkViewport) => void;
	onCursorChanged: (cursorIndex: number) => void;
	onClose: () => void;
}

export interface DrawerRuntimeConfig {
	wrapWidth: number;
	idleAdvanceMs: number;
	showWritingLine: boolean;
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

	open(session: DrawerSession): void {
		if (this.session && this.session.key !== session.key) {
			this.close();
		}

		this.session = session;
		this.session.cursorIndex = this.clampCursorIndex(
			this.session.cursorIndex,
			this.session.doc.strokes.length,
		);
		this.session.onCursorChanged(this.session.cursorIndex);
		this.activePointerId = null;
		this.activeStroke = null;
		this.hasPenInSession = false;
		this.lastLocalX = null;
		this.snapNextStrokeToCursor = true;
		this.pendingAdvanceOnRelease = false;
		this.clearIdleAdvanceTimer();
		this.updateToolUi();

		this.rootEl.classList.add('is-open');
		this.requestDraw();
	}

	updateCursor(sessionKey: string, cursorIndex: number, viewport: InkViewport): void {
		if (!this.session || this.session.key !== sessionKey) {
			return;
		}
		if (this.activePointerId !== null) {
			return;
		}

		this.clearIdleAdvanceTimer();
		this.pendingAdvanceOnRelease = false;
		this.session.cursorIndex = this.clampCursorIndex(cursorIndex, this.session.doc.strokes.length);
		this.snapNextStrokeToCursor = true;
		this.session.viewport = viewport;
		this.session.onCursorChanged(this.session.cursorIndex);
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
		this.session = null;
		this.rootEl.classList.remove('is-open');
		closingSession.onClose();
	}

	private attachListeners(): void {
		this.canvasEl.addEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.addEventListener('pointermove', this.onPointerMove);
		this.canvasEl.addEventListener('pointerup', this.onPointerUp);
		this.canvasEl.addEventListener('pointercancel', this.onPointerCancel);
		this.canvasEl.addEventListener('lostpointercapture', this.onPointerCancel);
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
		this.canvasEl.removeEventListener('lostpointercapture', this.onPointerCancel);
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
		const anchor = this.getCursorAnchorPoint(session);
		const anchorY = anchor?.y ?? session.viewport.lineOffsetY;
		const targetLineStart = (Math.floor(anchorY / lineHeight) + 1) * lineHeight;
		session.viewport = {
			viewportX: 0,
			lineOffsetY: Math.max(lineHeight, targetLineStart),
		};
		session.onViewportChanged(session.viewport);
		this.snapNextStrokeToCursor = true;
		this.lastLocalX = null;
		this.pendingAdvanceOnRelease = false;
		this.requestDraw();
	};

	private onClose = (): void => {
		this.close();
	};

	private onPointerDown = (event: PointerEvent): void => {
		const session = this.session;
		if (!session || this.activePointerId !== null) {
			return;
		}
		this.clearIdleAdvanceTimer();
		if (this.hasPenInSession && event.pointerType !== 'pen') {
			return;
		}
		if (event.pointerType === 'pen') {
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
			const insertionIndex = this.clampCursorIndex(session.cursorIndex, session.doc.strokes.length);
			const cursorAnchor = this.getCursorAnchorPoint(session);
			if (this.snapNextStrokeToCursor) {
				if (cursorAnchor) {
					this.alignStrokeToCursorX(this.activeStroke, cursorAnchor.x);
				}
				this.snapNextStrokeToCursor = false;
			}
			const activeBounds = this.getStrokeBounds(this.activeStroke);
			if (activeBounds) {
				strokePeakLocalX = activeBounds.maxX - session.viewport.viewportX;
			}
			session.doc.strokes.splice(insertionIndex, 0, this.activeStroke);
			this.shiftFollowingStrokesForInsertion(session.doc, insertionIndex, cursorAnchor?.x ?? null);
			session.cursorIndex = insertionIndex + 1;
			session.onCursorChanged(session.cursorIndex);
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

		const cursorIndex = this.clampCursorIndex(session.cursorIndex, session.doc.strokes.length);
		if (cursorIndex <= 0) {
			return;
		}
		const removeIndex = cursorIndex - 1;

		session.doc.strokes.splice(removeIndex, 1);
		session.cursorIndex = removeIndex;
		session.onCursorChanged(session.cursorIndex);

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

		if (!anchorPoint) {
			const lineHeight = Math.max(80, session.doc.meta.lineHeight);
			session.viewport = {
				viewportX: 0,
				lineOffsetY: lineHeight,
			};
		} else {
			const lineHeight = Math.max(80, session.doc.meta.lineHeight);
			session.viewport = {
				viewportX: Math.max(0, anchorPoint.x - drawerWidth * 0.5),
				lineOffsetY: Math.max(0, Math.floor(anchorPoint.y / lineHeight) * lineHeight),
			};
		}

		session.onViewportChanged(session.viewport);
		session.onDocumentChanged();
		this.snapNextStrokeToCursor = true;
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

	private getInsertionWordGap(lineHeight: number): number {
		const wrapWordGapThreshold = Math.max(8, Math.min(26, lineHeight * 0.12));
		return wrapWordGapThreshold + 2;
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
		const prevBounds = prevStroke ? this.getStrokeBounds(prevStroke) : null;
		const nextBounds = nextStroke ? this.getStrokeBounds(nextStroke) : null;

		if (prevBounds && nextBounds) {
			const isSameLine = Math.abs(nextBounds.centerY - prevBounds.centerY) <= lineHeight * 0.6;
			return {
				x: isSameLine
					? (prevBounds.maxX + nextBounds.minX) * 0.5
					: prevBounds.maxX + 20,
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
}
