// Guards fii-ink code blocks against accidental keyboard edits in live preview. The rendered
// widget already swallows pointer events (blocks.ts), but ordinary editing in the surrounding
// markdown can still bite into the hidden source — e.g. backspace at the start of the line just
// below a block deletes the newline (or last backtick) of the closing fence, which breaks the
// fence and unfolds the whole block into raw JSON where further keystrokes corrupt it. Any user
// edit that would partially overlap a block is cancelled. Deleting a whole block (selection that
// fully contains it) stays allowed, programmatic/vault changes pass through, and source mode is
// untouched (the deliberate escape hatch for inspecting the JSON).

import { EditorState, Extension, Text, Transaction } from '@codemirror/state';
import { INK_CODE_BLOCK_LANGUAGE } from './doc';

export interface InkBlockRange {
	from: number;
	to: number;
}

// A fence line: up to 3 leading spaces, a run of 3+ backticks or tildes, then the info string.
// (CommonMark: closing fences never carry an info string, which is what lets an upward scan
// distinguish "the nearest fence above is our opener" from "…is some block's closer".)
const FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*(\S*)/;

function fenceInfo(lineText: string): string | null {
	const m = FENCE_RE.exec(lineText);
	return m ? (m[1] ?? '') : null;
}

// The fii-ink block containing `pos` (inclusive of its fence lines), or null. Scans upward for
// the nearest fence line: an fii-ink opener means we're inside; any other fence means we're not
// (a bare fence on the pos line itself may be our block's closer, so the scan continues past it).
export function inkBlockAt(doc: Text, pos: number): InkBlockRange | null {
	const posLine = doc.lineAt(pos).number;
	let openLine = 0;
	for (let n = posLine; n >= 1; n -= 1) {
		const info = fenceInfo(doc.line(n).text);
		if (info === null) {
			continue;
		}
		if (info === INK_CODE_BLOCK_LANGUAGE) {
			openLine = n;
			break;
		}
		if (info === '' && n === posLine) {
			continue;
		}
		return null;
	}
	if (openLine === 0) {
		return null;
	}
	let to = doc.length; // unclosed block runs to the end of the note
	for (let n = openLine + 1; n <= doc.lines; n += 1) {
		if (fenceInfo(doc.line(n).text) === '') {
			to = doc.line(n).to;
			break;
		}
	}
	const from = doc.line(openLine).from;
	return pos <= to ? { from, to } : null;
}

// Whether replacing [fromA, toA) with `inserted` would bite into an fii-ink block without
// removing it whole. Boundary insertions are allowed only when they keep the fence line intact
// (a newline pushed in front of the opener, or opening a fresh line after the closer).
export function editViolatesInkBlock(
	doc: Text,
	fromA: number,
	toA: number,
	inserted: string,
): boolean {
	const blockFrom = inkBlockAt(doc, fromA);
	const blockTo = toA === fromA ? blockFrom : inkBlockAt(doc, toA);
	if (!blockFrom && !blockTo) {
		return false;
	}
	if (fromA === toA) {
		const block = blockFrom!;
		if (fromA === block.from) {
			return !inserted.endsWith('\n');
		}
		if (fromA === block.to) {
			return !inserted.startsWith('\n');
		}
		return true; // insertion strictly inside the block
	}
	for (const block of [blockFrom, blockTo]) {
		if (block && !(fromA <= block.from && toA >= block.to)) {
			return true;
		}
	}
	return false;
}

// The editor extension: cancel user-driven transactions (typing, deleting, drag-move) that
// would partially overlap an ink block. `isLivePreview` is injected so this module stays free
// of the `obsidian` import and the pure logic above remains testable headlessly.
export function inkBlockGuard(isLivePreview: (state: EditorState) => boolean): Extension {
	return EditorState.transactionFilter.of((tr: Transaction) => {
		if (!tr.docChanged) {
			return tr;
		}
		if (!tr.isUserEvent('input') && !tr.isUserEvent('delete') && !tr.isUserEvent('move')) {
			return tr;
		}
		if (!isLivePreview(tr.startState)) {
			return tr;
		}
		let violates = false;
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			if (!violates && editViolatesInkBlock(tr.startState.doc, fromA, toA, inserted.toString())) {
				violates = true;
			}
		});
		return violates ? [] : tr;
	});
}
