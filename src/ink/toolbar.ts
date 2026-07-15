// The unified floating toolbar: ONE set of style/list/clipboard buttons shared by the inline
// blocks and the drawer, so they are no longer duplicated at the bottom of every block and in
// the drawer's top bar. A singleton like the drawer; it binds to the "active" target (the last
// block the user placed a cursor in / opened the drawer for) and is context-sensitive:
//
//   - with a selection            → the style buttons restyle the selection (retroactive)
//   - no selection, drawer open   → the style buttons set the PEN for new strokes
//   - no selection, drawer closed → the style buttons are disabled (nothing to act on)
//
// List structure (bullet/checkbox/indent), select mode, clipboard, and the writing-line toggle
// act on the bound target regardless. The panel is draggable by its grip; the position persists
// via the injected get/setPosition callbacks (stored in plugin settings).

import { InkDocument, fragmentIsEmpty, selectionIsEmpty } from './doc';
import {
	applyStyleToSelection,
	colorAtCursor,
	cursorLineIsBulleted,
	cursorLineIsCheckbox,
	deleteSelection,
	extractSelection,
	indentLines,
	insertFragmentAtCursor,
	selectionStyleFlags,
	toggleBulletAtCursor,
	toggleCheckboxAtCursor,
} from './edit';
import { getClipboard, setClipboard } from './clipboard';
import { ColorPopupHandle, DEFAULT_INK_COLOR, openColorPopup } from './palette';

export interface PenStyle {
	color: string;
	bold: boolean;
	underline: boolean;
}

// The drawer, seen through the keyhole the toolbar needs: is a pen active, and what is it?
export interface ToolbarPenHost {
	isOpen(): boolean;
	getPen(): PenStyle;
	setPen(patch: Partial<PenStyle>): void;
}

// One inline block (or drawer session) the toolbar acts on.
export interface ToolbarTarget {
	key: string;
	doc: InkDocument;
	applyEdit(): void; // content changed: re-render + persist path
	renderOnly(): void; // visual-only refresh (copy, select-mode toggle)
	isSelectMode(): boolean;
	toggleSelectMode(): void;
	openDrawer(): void;
}

export interface ToolbarPosition {
	x: number;
	y: number;
}

export interface ToolbarOptions {
	penHost: ToolbarPenHost;
	getShowWritingLine(): boolean;
	setShowWritingLine(value: boolean): void;
	refreshAllInline(): void;
	getPosition(): ToolbarPosition | null;
	setPosition(pos: ToolbarPosition): void;
}

export class InkToolbar {
	private readonly opts: ToolbarOptions;
	private readonly rootEl: HTMLDivElement;
	private readonly gripEl: HTMLDivElement;
	private target: ToolbarTarget | null = null;
	private colorPopup: ColorPopupHandle | null = null;
	private readonly cleanups: Array<() => void> = [];

	private readonly writingLineBtn: HTMLButtonElement;
	private readonly selectBtn: HTMLButtonElement;
	private readonly boldBtn: HTMLButtonElement;
	private readonly underlineBtn: HTMLButtonElement;
	private readonly colorBtn: HTMLButtonElement;
	private readonly colorSwatchEl: HTMLSpanElement;
	private readonly bulletBtn: HTMLButtonElement;
	private readonly checkboxBtn: HTMLButtonElement;
	private readonly outdentBtn: HTMLButtonElement;
	private readonly indentBtn: HTMLButtonElement;
	private readonly copyBtn: HTMLButtonElement;
	private readonly cutBtn: HTMLButtonElement;
	private readonly pasteBtn: HTMLButtonElement;
	private readonly drawerBtn: HTMLButtonElement;

	constructor(opts: ToolbarOptions) {
		this.opts = opts;
		this.rootEl = activeDocument.createElement('div');
		this.rootEl.className = 'freeflow-ink-toolbar';

		this.gripEl = activeDocument.createElement('div');
		this.gripEl.className = 'freeflow-ink-toolbar-grip';
		this.gripEl.setAttribute('aria-label', 'Drag to move toolbar');
		this.gripEl.setText('⠿');
		this.rootEl.appendChild(this.gripEl);

		const makeButton = (glyph: string, label: string, onClick: () => void): HTMLButtonElement => {
			const btn = activeDocument.createElement('button');
			btn.type = 'button';
			btn.className = 'freeflow-ink-toolbar-btn';
			btn.setAttribute('aria-label', label);
			btn.title = label;
			btn.setText(glyph);
			btn.addEventListener('click', onClick);
			// Drive from touch on iPad: a Pencil tap on a <button> otherwise hands focus back to the
			// editor and pops the keyboard. preventDefault suppresses that (and the synthetic click).
			const onTouchStart = (event: TouchEvent): void => {
				event.preventDefault();
			};
			const onTouchEnd = (event: TouchEvent): void => {
				event.preventDefault();
				if (!btn.disabled) {
					onClick();
				}
			};
			btn.addEventListener('touchstart', onTouchStart, { passive: false });
			btn.addEventListener('touchend', onTouchEnd, { passive: false });
			this.cleanups.push(() => {
				btn.removeEventListener('click', onClick);
				btn.removeEventListener('touchstart', onTouchStart);
				btn.removeEventListener('touchend', onTouchEnd);
			});
			this.rootEl.appendChild(btn);
			return btn;
		};

		this.writingLineBtn = makeButton('☰', 'Toggle writing lines', this.onWritingLine);
		this.selectBtn = makeButton('⬚', 'Select words', this.onSelect);
		this.boldBtn = makeButton('B', 'Bold', this.onBold);
		this.boldBtn.classList.add('is-bold-glyph');
		this.underlineBtn = makeButton('U', 'Underline', this.onUnderline);
		this.underlineBtn.classList.add('is-underline-glyph');

		this.colorBtn = makeButton('', 'Colour', this.onColor);
		this.colorBtn.classList.add('freeflow-ink-color-btn');
		this.colorSwatchEl = activeDocument.createElement('span');
		this.colorSwatchEl.className = 'freeflow-ink-color-btn-swatch';
		this.colorBtn.appendChild(this.colorSwatchEl);

		this.bulletBtn = makeButton('•', 'Bullet list', this.onBullet);
		this.checkboxBtn = makeButton('☐', 'Checkbox list', this.onCheckbox);
		this.outdentBtn = makeButton('⇤', 'Outdent', this.onOutdent);
		this.indentBtn = makeButton('⇥', 'Indent', this.onIndent);
		this.copyBtn = makeButton('⧉', 'Copy', this.onCopy);
		this.cutBtn = makeButton('✂', 'Cut', this.onCut);
		this.pasteBtn = makeButton('📋', 'Paste', this.onPaste);
		this.drawerBtn = makeButton('✏️', 'Open drawer', this.onOpenDrawer);

		this.attachDrag();
		activeDocument.body.appendChild(this.rootEl);
	}

	destroy(): void {
		this.colorPopup?.close();
		this.colorPopup = null;
		for (const cleanup of this.cleanups) {
			cleanup();
		}
		this.cleanups.length = 0;
		this.rootEl.remove();
	}

	bind(target: ToolbarTarget): void {
		this.target = target;
		this.rootEl.classList.add('is-open');
		this.applyStoredPosition();
		this.refresh();
	}

	// Hide the toolbar when the block it was bound to unmounts (note closed, mode switched).
	unbind(key: string): void {
		if (this.target?.key !== key) {
			return;
		}
		this.target = null;
		this.colorPopup?.close();
		this.colorPopup = null;
		this.rootEl.classList.remove('is-open');
	}

	refresh(): void {
		const target = this.target;
		if (!target) {
			return;
		}
		const doc = target.doc;
		const sel = doc.meta.selection;
		const hasSelection = !selectionIsEmpty(sel);
		const penActive = this.opts.penHost.isOpen();
		const styleEnabled = hasSelection || penActive;

		this.boldBtn.disabled = !styleEnabled;
		this.underlineBtn.disabled = !styleEnabled;
		this.colorBtn.disabled = !styleEnabled;
		this.copyBtn.disabled = !hasSelection;
		this.cutBtn.disabled = !hasSelection;
		this.pasteBtn.disabled = fragmentIsEmpty(getClipboard());

		this.writingLineBtn.classList.toggle('is-active', this.opts.getShowWritingLine());
		this.selectBtn.classList.toggle('is-active', target.isSelectMode());
		this.bulletBtn.classList.toggle('is-active', cursorLineIsBulleted(doc));
		this.checkboxBtn.classList.toggle('is-active', cursorLineIsCheckbox(doc));

		if (hasSelection) {
			const flags = selectionStyleFlags(doc, sel!);
			this.boldBtn.classList.toggle('is-active', flags.allBold);
			this.underlineBtn.classList.toggle('is-active', flags.allUnderline);
		} else if (penActive) {
			const pen = this.opts.penHost.getPen();
			this.boldBtn.classList.toggle('is-active', pen.bold);
			this.underlineBtn.classList.toggle('is-active', pen.underline);
		} else {
			this.boldBtn.classList.remove('is-active');
			this.underlineBtn.classList.remove('is-active');
		}

		const swatchColor = penActive
			? this.opts.penHost.getPen().color
			: colorAtCursor(doc, DEFAULT_INK_COLOR);
		this.colorSwatchEl.style.backgroundColor = swatchColor;
		this.colorSwatchEl.style.color = swatchColor;
	}

	// ------------------------------------------------------------- actions

	// Style toggles: selection wins; otherwise set the pen (only reachable while the drawer is open).
	private onBold = (): void => {
		this.withStyleContext(
			(doc, sel) => {
				const flags = selectionStyleFlags(doc, sel);
				applyStyleToSelection(doc, sel, { bold: !flags.allBold });
			},
			(pen) => this.opts.penHost.setPen({ bold: !pen.bold }),
		);
	};

	private onUnderline = (): void => {
		this.withStyleContext(
			(doc, sel) => {
				const flags = selectionStyleFlags(doc, sel);
				applyStyleToSelection(doc, sel, { underline: !flags.allUnderline });
			},
			(pen) => this.opts.penHost.setPen({ underline: !pen.underline }),
		);
	};

	private onColor = (): void => {
		if (this.colorPopup) {
			this.colorPopup.close();
			this.colorPopup = null;
			return;
		}
		const target = this.target;
		if (!target) {
			return;
		}
		const penActive = this.opts.penHost.isOpen();
		const current = penActive
			? this.opts.penHost.getPen().color
			: colorAtCursor(target.doc, DEFAULT_INK_COLOR);
		this.colorPopup = openColorPopup(this.colorBtn, current, (color) => {
			this.colorPopup = null;
			this.withStyleContext(
				(doc, sel) => applyStyleToSelection(doc, sel, { color }),
				() => this.opts.penHost.setPen({ color }),
			);
		});
	};

	private withStyleContext(
		onSelection: (doc: InkDocument, sel: NonNullable<InkDocument['meta']['selection']>) => void,
		onPen: (pen: PenStyle) => void,
	): void {
		const target = this.target;
		if (!target) {
			return;
		}
		const sel = target.doc.meta.selection;
		if (!selectionIsEmpty(sel)) {
			onSelection(target.doc, sel!);
			target.applyEdit();
		} else if (this.opts.penHost.isOpen()) {
			onPen(this.opts.penHost.getPen());
		}
		this.refresh();
	}

	private onSelect = (): void => {
		this.target?.toggleSelectMode();
		this.refresh();
	};

	private onWritingLine = (): void => {
		this.opts.setShowWritingLine(!this.opts.getShowWritingLine());
		this.opts.refreshAllInline();
		this.refresh();
	};

	private onBullet = (): void => {
		this.applyListEdit((doc) => toggleBulletAtCursor(doc));
	};

	private onCheckbox = (): void => {
		this.applyListEdit((doc) => toggleCheckboxAtCursor(doc));
	};

	private onIndent = (): void => {
		this.applyListEdit((doc) => indentLines(doc, 1));
	};

	private onOutdent = (): void => {
		this.applyListEdit((doc) => indentLines(doc, -1));
	};

	private applyListEdit(fn: (doc: InkDocument) => void): void {
		const target = this.target;
		if (!target) {
			return;
		}
		fn(target.doc);
		target.applyEdit();
		this.refresh();
	}

	private onCopy = (): void => {
		const target = this.target;
		if (!target || selectionIsEmpty(target.doc.meta.selection)) {
			return;
		}
		setClipboard(extractSelection(target.doc, target.doc.meta.selection!));
		target.renderOnly();
		this.refresh();
	};

	private onCut = (): void => {
		const target = this.target;
		if (!target || selectionIsEmpty(target.doc.meta.selection)) {
			return;
		}
		setClipboard(extractSelection(target.doc, target.doc.meta.selection!));
		deleteSelection(target.doc, target.doc.meta.selection!);
		target.applyEdit();
		this.refresh();
	};

	private onPaste = (): void => {
		const target = this.target;
		const clip = getClipboard();
		if (!target || fragmentIsEmpty(clip)) {
			return;
		}
		insertFragmentAtCursor(target.doc, clip!);
		target.applyEdit();
		this.refresh();
	};

	private onOpenDrawer = (): void => {
		this.target?.openDrawer();
		this.refresh();
	};

	// ------------------------------------------------------------- drag

	private attachDrag(): void {
		let dragging = false;
		let pointerId: number | null = null;
		let offsetX = 0;
		let offsetY = 0;
		const onDown = (event: PointerEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			dragging = true;
			pointerId = event.pointerId;
			const rect = this.rootEl.getBoundingClientRect();
			offsetX = event.clientX - rect.left;
			offsetY = event.clientY - rect.top;
			try {
				this.gripEl.setPointerCapture(event.pointerId);
			} catch {
				/* best-effort */
			}
		};
		const onMove = (event: PointerEvent): void => {
			if (!dragging || pointerId !== event.pointerId) {
				return;
			}
			event.preventDefault();
			this.moveTo(event.clientX - offsetX, event.clientY - offsetY);
		};
		const onUp = (event: PointerEvent): void => {
			if (!dragging || pointerId !== event.pointerId) {
				return;
			}
			dragging = false;
			pointerId = null;
			const rect = this.rootEl.getBoundingClientRect();
			this.opts.setPosition({ x: rect.left, y: rect.top });
		};
		this.gripEl.addEventListener('pointerdown', onDown);
		this.gripEl.addEventListener('pointermove', onMove);
		this.gripEl.addEventListener('pointerup', onUp);
		this.gripEl.addEventListener('pointercancel', onUp);
		this.cleanups.push(() => {
			this.gripEl.removeEventListener('pointerdown', onDown);
			this.gripEl.removeEventListener('pointermove', onMove);
			this.gripEl.removeEventListener('pointerup', onUp);
			this.gripEl.removeEventListener('pointercancel', onUp);
		});
	}

	private moveTo(left: number, top: number): void {
		const vw = activeWindow.innerWidth;
		const vh = activeWindow.innerHeight;
		const rect = this.rootEl.getBoundingClientRect();
		const x = Math.max(4, Math.min(vw - rect.width - 4, left));
		const y = Math.max(4, Math.min(vh - rect.height - 4, top));
		this.rootEl.setCssStyles({ left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
	}

	// Restore the saved position (clamped to the current viewport); without one, the stylesheet's
	// default placement applies.
	private applyStoredPosition(): void {
		const pos = this.opts.getPosition();
		if (pos) {
			this.moveTo(pos.x, pos.y);
		}
	}
}
