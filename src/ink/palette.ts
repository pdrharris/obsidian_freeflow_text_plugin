// A small colour palette + popup swatch picker, shared by the drawer (pen colour) and the
// inline view (recolour the current selection). The popup is a floating grid anchored to a
// button; clicking a swatch picks a colour, clicking outside (or Escape) dismisses it.

export const DEFAULT_INK_COLOR = '#111827';

// 32 colours: greys, then a spectrum in two tones (deep + bright).
export const INK_PALETTE: string[] = [
	'#111827', '#374151', '#6b7280', '#9ca3af', '#d1d5db', '#ffffff',
	'#7f1d1d', '#b91c1c', '#ef4444', '#f87171',
	'#7c2d12', '#c2410c', '#f97316', '#fb923c',
	'#78350f', '#b45309', '#f59e0b', '#fbbf24',
	'#365314', '#4d7c0f', '#84cc16', '#a3e635',
	'#14532d', '#15803d', '#22c55e', '#4ade80',
	'#134e4a', '#0f766e', '#14b8a6', '#2dd4bf',
	'#1e3a8a', '#1d4ed8', '#3b82f6', '#60a5fa',
	'#312e81', '#4338ca', '#6366f1', '#818cf8',
	'#581c87', '#7e22ce', '#a855f7', '#c084fc',
	'#831843', '#be185d', '#ec4899', '#f472b6',
];

export interface ColorPopupHandle {
	close(): void;
}

// Open a swatch grid near `anchorEl`. Calls `onPick` with the chosen colour (the popup stays
// open so several picks are possible only if you want — here we close on pick). Returns a handle
// so callers can close it programmatically (e.g. on unload).
export function openColorPopup(
	anchorEl: HTMLElement,
	current: string,
	onPick: (color: string) => void,
): ColorPopupHandle {
	const doc = anchorEl.ownerDocument;
	const popup = doc.createElement('div');
	popup.className = 'freeflow-ink-color-popup';

	const grid = doc.createElement('div');
	grid.className = 'freeflow-ink-color-grid';
	popup.appendChild(grid);

	let closed = false;
	const close = (): void => {
		if (closed) {
			return;
		}
		closed = true;
		doc.removeEventListener('pointerdown', onOutside, true);
		doc.removeEventListener('keydown', onKey, true);
		popup.remove();
	};

	const onOutside = (event: Event): void => {
		const target = event.target as Node | null;
		if (target && (popup.contains(target) || anchorEl.contains(target))) {
			return;
		}
		close();
	};
	const onKey = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	};

	const normalizedCurrent = current.toLowerCase();
	for (const color of INK_PALETTE) {
		const swatch = doc.createElement('button');
		swatch.type = 'button';
		swatch.className = 'freeflow-ink-color-swatch';
		swatch.style.backgroundColor = color;
		swatch.setAttribute('aria-label', color);
		swatch.title = color;
		if (color.toLowerCase() === normalizedCurrent) {
			swatch.classList.add('is-current');
		}
		swatch.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			onPick(color);
			close();
		});
		grid.appendChild(swatch);
	}

	doc.body.appendChild(popup);

	// Position below the anchor, kept within the viewport.
	const rect = anchorEl.getBoundingClientRect();
	const popupRect = popup.getBoundingClientRect();
	const margin = 8;
	let left = rect.left;
	let top = rect.bottom + 4;
	const maxLeft = (doc.defaultView?.innerWidth ?? 1024) - popupRect.width - margin;
	const maxTop = (doc.defaultView?.innerHeight ?? 768) - popupRect.height - margin;
	if (left > maxLeft) {
		left = Math.max(margin, maxLeft);
	}
	if (top > maxTop) {
		top = Math.max(margin, rect.top - popupRect.height - 4);
	}
	popup.style.left = `${Math.max(margin, left)}px`;
	popup.style.top = `${Math.max(margin, top)}px`;

	// Defer outside-click wiring so the opening click doesn't immediately dismiss it.
	window.setTimeout(() => {
		if (!closed) {
			doc.addEventListener('pointerdown', onOutside, true);
			doc.addEventListener('keydown', onKey, true);
		}
	}, 0);

	return { close };
}
