// Logical editing operations on the flowing-text ink model.
//
// Every operation is a tree splice on lines/words; there is NO coordinate manipulation.
// After any edit the caller re-runs the layout engine to recompute geometry. This is what
// makes newline/erase/cut/paste robust where the old absolute-coordinate model was fragile.

import {
	InkCursor,
	InkDocument,
	InkFragment,
	InkSelection,
	InkStroke,
	InkWord,
	cloneFragment,
	cloneWord,
	createEmptyLine,
	createWordId,
	orderCursors,
	selectionIsEmpty,
} from './doc';

function clampCursorToDoc(doc: InkDocument, cursor: InkCursor): InkCursor {
	const line = Math.max(0, Math.min(doc.lines.length - 1, cursor.line));
	const wordCount = doc.lines[line]?.words.length ?? 0;
	const word = Math.max(0, Math.min(wordCount, cursor.word));
	return { line, word };
}

export function wordFromStroke(stroke: InkStroke): InkWord {
	return { id: createWordId(), strokes: [stroke] };
}

// Insert a freshly-captured word at the cursor. Returns the cursor positioned after it.
export function insertWordAtCursor(doc: InkDocument, word: InkWord): InkCursor {
	const cursor = clampCursorToDoc(doc, doc.meta.cursor);
	const line = doc.lines[cursor.line];
	if (!line) {
		return cursor;
	}
	line.words.splice(cursor.word, 0, word);
	const next: InkCursor = { line: cursor.line, word: cursor.word + 1 };
	doc.meta.cursor = next;
	doc.meta.selection = null;
	return next;
}

// Append a stroke to the word immediately before the cursor (continuing the current word).
// Returns true if a word was available to append to.
export function appendStrokeToCurrentWord(doc: InkDocument, stroke: InkStroke): boolean {
	const cursor = clampCursorToDoc(doc, doc.meta.cursor);
	if (cursor.word <= 0) {
		return false;
	}
	const word = doc.lines[cursor.line]?.words[cursor.word - 1];
	if (!word) {
		return false;
	}
	word.strokes.push(stroke);
	return true;
}

// Split the current line at the cursor (manual newline). Returns the new cursor.
export function splitLineAtCursor(doc: InkDocument): InkCursor {
	const cursor = clampCursorToDoc(doc, doc.meta.cursor);
	const line = doc.lines[cursor.line];
	if (!line) {
		return cursor;
	}
	const tail = line.words.splice(cursor.word);
	const newLine = createEmptyLine();
	newLine.words = tail;
	doc.lines.splice(cursor.line + 1, 0, newLine);
	const next: InkCursor = { line: cursor.line + 1, word: 0 };
	doc.meta.cursor = next;
	doc.meta.selection = null;
	return next;
}

// Erase: delete the selection if present; otherwise delete the word before the cursor, or
// join with the previous line when the cursor is at the start of a line. Returns new cursor.
export function eraseAtCursor(doc: InkDocument): InkCursor {
	if (!selectionIsEmpty(doc.meta.selection)) {
		return deleteSelection(doc, doc.meta.selection as InkSelection);
	}
	const cursor = clampCursorToDoc(doc, doc.meta.cursor);
	const line = doc.lines[cursor.line];
	if (!line) {
		return cursor;
	}
	if (cursor.word > 0) {
		line.words.splice(cursor.word - 1, 1);
		const next: InkCursor = { line: cursor.line, word: cursor.word - 1 };
		doc.meta.cursor = next;
		return next;
	}
	// At line start: join with the previous line.
	if (cursor.line > 0) {
		const prev = doc.lines[cursor.line - 1];
		if (prev) {
			const joinAt = prev.words.length;
			prev.words.push(...line.words);
			doc.lines.splice(cursor.line, 1);
			const next: InkCursor = { line: cursor.line - 1, word: joinAt };
			doc.meta.cursor = next;
			return next;
		}
	}
	return cursor;
}

// Copy the word range covered by `selection` into a fragment (deep-cloned, fresh ids).
export function extractSelection(doc: InkDocument, selection: InkSelection): InkFragment {
	const [start, end] = orderCursors(
		clampCursorToDoc(doc, selection.anchor),
		clampCursorToDoc(doc, selection.focus),
	);
	const segments: InkWord[][] = [];
	if (start.line === end.line) {
		const line = doc.lines[start.line];
		segments.push((line?.words.slice(start.word, end.word) ?? []).map(cloneWord));
		return { segments };
	}
	for (let lineIndex = start.line; lineIndex <= end.line; lineIndex += 1) {
		const line = doc.lines[lineIndex];
		if (!line) {
			continue;
		}
		const from = lineIndex === start.line ? start.word : 0;
		const to = lineIndex === end.line ? end.word : line.words.length;
		segments.push(line.words.slice(from, to).map(cloneWord));
	}
	return { segments };
}

// Paste a fragment at the cursor (deletes the active selection first). Returns the new cursor.
export function insertFragmentAtCursor(doc: InkDocument, fragment: InkFragment): InkCursor {
	if (!selectionIsEmpty(doc.meta.selection)) {
		deleteSelection(doc, doc.meta.selection as InkSelection);
	}
	const clone = cloneFragment(fragment);
	const cursor = clampCursorToDoc(doc, doc.meta.cursor);
	const line = doc.lines[cursor.line];
	if (!line || clone.segments.length === 0) {
		return cursor;
	}

	const first = clone.segments[0] ?? [];
	if (clone.segments.length === 1) {
		line.words.splice(cursor.word, 0, ...first);
		const next: InkCursor = { line: cursor.line, word: cursor.word + first.length };
		doc.meta.cursor = next;
		doc.meta.selection = null;
		return next;
	}

	// Multi-segment paste: split the current line and stitch the fragment between the halves.
	const head = line.words.slice(0, cursor.word);
	const tail = line.words.slice(cursor.word);
	const last = clone.segments[clone.segments.length - 1] ?? [];
	const middle = clone.segments.slice(1, -1);

	line.words = [...head, ...first];
	const newLines = [
		...middle.map((seg) => {
			const l = createEmptyLine();
			l.words = seg;
			return l;
		}),
		(() => {
			const l = createEmptyLine();
			l.words = [...last, ...tail];
			return l;
		})(),
	];
	doc.lines.splice(cursor.line + 1, 0, ...newLines);

	const next: InkCursor = { line: cursor.line + clone.segments.length - 1, word: last.length };
	doc.meta.cursor = next;
	doc.meta.selection = null;
	return next;
}

export function deleteSelection(doc: InkDocument, selection: InkSelection): InkCursor {
	const [start, end] = orderCursors(
		clampCursorToDoc(doc, selection.anchor),
		clampCursorToDoc(doc, selection.focus),
	);
	doc.meta.selection = null;

	if (start.line === end.line) {
		const line = doc.lines[start.line];
		if (line) {
			line.words.splice(start.word, end.word - start.word);
		}
		doc.meta.cursor = start;
		return start;
	}

	const first = doc.lines[start.line];
	const last = doc.lines[end.line];
	if (first && last) {
		const head = first.words.slice(0, start.word);
		const tail = last.words.slice(end.word);
		first.words = [...head, ...tail];
		doc.lines.splice(start.line + 1, end.line - start.line);
	}
	doc.meta.cursor = start;
	return start;
}
