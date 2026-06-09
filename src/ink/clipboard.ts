// Process-wide in-app clipboard for ink fragments, shared by the inline view and the drawer so
// copy/cut in one surface can be pasted in the other (and across blocks/notes within a session).

import { InkFragment } from './doc';

let current: InkFragment | null = null;

export function setClipboard(fragment: InkFragment | null): void {
	current = fragment;
}

export function getClipboard(): InkFragment | null {
	return current;
}
