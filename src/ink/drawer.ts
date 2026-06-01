import {
	createStrokeId,
	eraserHitTest,
	InkDocument,
	InkStroke,
	InkTool,
	InkViewport,
} from './model';
import { drawDrawerCanvas } from './render';

const STEP_RATIO = 0.72;
const ERASER_RADIUS = 18;
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
	private tool: InkTool = 'pen';
	private activePointerId: number | null = null;
	private activeStroke: InkStroke | null = null;
	private hasPenInSession = false;
	private redrawQueued = false;
	private lastLocalX: number | null = null;

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
		this.tool = 'pen';
		this.updateToolUi();

		this.rootEl.classList.add('is-open');
		this.requestDraw();
	}

	close(): void {
		if (!this.session) {
			return;
		}
		this.finishStroke();
		const closingSession = this.session;
		this.session = null;
		this.rootEl.classList.remove('is-open');
		closingSession.onClose();
	}

	private attachListeners(): void {
		this.canvasEl.addEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.addEventListener('pointermove', this.onPointerMove);
		this.canvasEl.addEventListener('pointerup', this.onPointerUpOrCancel);
		this.canvasEl.addEventListener('pointercancel', this.onPointerUpOrCancel);
		this.canvasEl.addEventListener('lostpointercapture', this.onPointerUpOrCancel);
		window.addEventListener('resize', this.onResize);
		this.eraseButtonEl.addEventListener('click', this.onToggleErase);
		this.newLineButtonEl.addEventListener('click', this.onNewLine);
		this.closeButtonEl.addEventListener('click', this.onClose);
		this.rootEl.addEventListener('click', this.onBackdropClick);
	}

	private detachListeners(): void {
		this.canvasEl.removeEventListener('pointerdown', this.onPointerDown);
		this.canvasEl.removeEventListener('pointermove', this.onPointerMove);
		this.canvasEl.removeEventListener('pointerup', this.onPointerUpOrCancel);
		this.canvasEl.removeEventListener('pointercancel', this.onPointerUpOrCancel);
		this.canvasEl.removeEventListener('lostpointercapture', this.onPointerUpOrCancel);
		window.removeEventListener('resize', this.onResize);
		this.eraseButtonEl.removeEventListener('click', this.onToggleErase);
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

	private onToggleErase = (): void => {
		this.tool = this.tool === 'eraser' ? 'pen' : 'eraser';
		this.updateToolUi();
	};

	private onNewLine = (): void => {
		const session = this.session;
		if (!session) {
			return;
		}
		session.viewport = {
			viewportX: 0,
			lineOffsetY: session.viewport.lineOffsetY + session.doc.meta.lineHeight,
		};
		session.onViewportChanged(session.viewport);
		this.lastLocalX = null;
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

		if (this.tool === 'eraser') {
			const changed = this.eraseAtEvent(event);
			if (changed) {
				session.onDocumentChanged();
			}
			this.requestDraw();
			return;
		}

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

		if (this.tool === 'eraser') {
			const changed = this.eraseAtEvent(event);
			if (changed) {
				session.onDocumentChanged();
			}
			this.requestDraw();
			return;
		}

		if (!this.activeStroke) {
			return;
		}

		this.pushStrokePoints(event);
		session.onDocumentChanged();
		this.requestDraw();
	};

	private onPointerUpOrCancel = (event: PointerEvent): void => {
		if (this.activePointerId !== event.pointerId) {
			return;
		}
		this.finishStroke();
	};

	private finishStroke(): void {
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

		this.activePointerId = null;
		this.activeStroke = null;
		this.lastLocalX = null;
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
				this.advanceStep(rect.width);
			} else if (
				this.lastLocalX !== null &&
				this.lastLocalX > rect.width * 0.9 &&
				localX < rect.width * 0.15
			) {
				this.advanceStep(rect.width);
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

	private eraseAtEvent(event: PointerEvent): boolean {
		const session = this.session;
		if (!session) {
			return false;
		}

		const rect = this.canvasEl.getBoundingClientRect();
		const localX = event.clientX - rect.left;
		const localY = event.clientY - rect.top;
		const worldX = session.viewport.viewportX + localX;
		const worldY = session.viewport.lineOffsetY + localY;

		const beforeCount = session.doc.strokes.length;
		session.doc.strokes = session.doc.strokes.filter(
			(stroke) => !eraserHitTest(stroke, worldX, worldY, ERASER_RADIUS),
		);
		return beforeCount !== session.doc.strokes.length;
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
		this.eraseButtonEl.classList.toggle('is-active', this.tool === 'eraser');
		this.statusEl.textContent = this.tool === 'eraser' ? 'Eraser' : 'Pen';
	}
}
