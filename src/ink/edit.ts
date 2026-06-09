// Logical editing operations on the flowing-text ink model.
//
// Every operation is a tree splice on lines/words; there is NO coordinate manipulation.
// After any edit the caller re-runs the layout engine to recompute geometry. This is what
// makes newline/erase/cut/paste robust where the old absolute-coordinate model was fragile.

import {
	InkCursor,
	InkDocument,
	InkSelection,
	InkStroke,
	InkWord,
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
