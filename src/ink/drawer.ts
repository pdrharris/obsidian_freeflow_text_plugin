import {
	createStrokeId,
	InkDocument,
	InkStroke,
	InkViewport,
	INK_WRAP_WORLD_WIDTH,
} from './model';
import { drawDrawerCanvas } from './render';

const STEP_RATIO = 0.72;
const DEFAULT_PEN_COLOR = '#111827';
const DEFAULT_PEN_WIDTH = 3;

export interface DrawerSession {
	key: string;
	doc: InkDocument;
	viewport: InkViewport;
	onDocumentChanged: () => void;
	onViewportChanged: (viewport: InkViewport) => void;
	onClose: () => void;
}

export class InkDrawer {
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

	constructor() {
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
		this.rootEl.remove();
	}

	open(session: DrawerSession): void {
		if (this.session && this.session.key !== session.key) {
			this.close();
		}

		this.session = session;
		this.activePointerId = null;
		this.activeStroke = null;
		this.hasPenInSession = false;
		this.lastLocalX = null;
		this.pendingAdvanceOnRelease = false;
		this.updateToolUi();

		this.rootEl.classList.add('is-open');
		this.requestDraw();
	}

	close(): void {
		if (!this.session) {
			return;
		}
		this.finishStroke(false);
		const closingSession = this.session;
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
		this.eraseLastStroke();
	};

	private onNewLine = (): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		const lineHeight = Math.max(80, session.doc.meta.lineHeight);
		const lastPoint = getLastPoint(session.doc);
		const anchorY = Math.max(session.viewport.lineOffsetY, lastPoint?.y ?? 0);
		const wrappedLineOffset =
			Math.floor(Math.max(0, session.viewport.viewportX) / INK_WRAP_WORLD_WIDTH) * lineHeight;
		session.viewport = {
			viewportX: 0,
			lineOffsetY: anchorY + wrappedLineOffset + lineHeight,
		};
		session.onViewportChanged(session.viewport);
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

		if (this.activeStroke && this.activeStroke.points.length > 0) {
			session.doc.strokes.push(this.activeStroke);
			session.onDocumentChanged();
		}

		if (applyPendingAdvance && this.pendingAdvanceOnRelease) {
			const drawerWidth =
				this.canvasEl.getBoundingClientRect().width || this.canvasEl.clientWidth || 0;
			if (drawerWidth > 0) {
				this.advanceStep(drawerWidth);
			}
		}

		this.activePointerId = null;
		this.activeStroke = null;
		this.lastLocalX = null;
		this.pendingAdvanceOnRelease = false;
		this.requestDraw();
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

		session.doc.strokes.pop();

		const drawerWidth =
			this.canvasEl.getBoundingClientRect().width || this.canvasEl.clientWidth || 480;
		const lastStroke = session.doc.strokes[session.doc.strokes.length - 1];
		const lastPoint = lastStroke?.points[lastStroke.points.length - 1];
		if (!lastPoint) {
			session.viewport = {
				viewportX: 0,
				lineOffsetY: 0,
			};
		} else {
			const lineHeight = Math.max(80, session.doc.meta.lineHeight);
			session.viewport = {
				viewportX: Math.max(0, lastPoint.x - drawerWidth * 0.7),
				lineOffsetY: Math.max(0, Math.floor(lastPoint.y / lineHeight) * lineHeight),
			};
		}

		session.onViewportChanged(session.viewport);
		session.onDocumentChanged();
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

		for (const sample of points) {
			const localX = sample.clientX - rect.left;
			const localY = sample.clientY - rect.top;
			if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
				continue;
			}

			const worldX = session.viewport.viewportX + localX;
			const worldY = session.viewport.lineOffsetY + localY;
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
		drawDrawerCanvas(
			this.canvasEl,
			session.doc,
			session.viewport.viewportX,
			session.viewport.lineOffsetY,
			this.activeStroke,
		);
	}

	private updateToolUi(): void {
		this.eraseButtonEl.classList.remove('is-active');
		this.statusEl.textContent = 'Pen';
	}
}

function getLastPoint(doc: InkDocument): { x: number; y: number } | null {
	for (let i = doc.strokes.length - 1; i >= 0; i -= 1) {
		const stroke = doc.strokes[i];
		if (!stroke || stroke.points.length === 0) {
			continue;
		}
		const point = stroke.points[stroke.points.length - 1];
		if (point) {
			return { x: point.x, y: point.y };
		}
	}
	return null;
}
