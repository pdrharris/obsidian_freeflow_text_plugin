import {
	InkCanonicalCursor,
	InkCursorLinePreference,
	InkDocument,
	InkLineBreakInsertOperation,
} from './model';

// Shared canonical cursor helpers used by both drawer and renderer integration layers.
// Centralizing these rules avoids subtle divergence between UI paths.

export function normalizeLinePreference(value: unknown): InkCursorLinePreference {
	return value === 'prev' || value === 'next' ? value : 'auto';
}

export function clampCursorIndex(index: number, length: number): number {
	if (!Number.isFinite(index)) {
		return Math.max(0, length);
	}
	return Math.max(0, Math.min(Math.max(0, length), Math.floor(index)));
}

export function readCanonicalCursor(
	doc: InkDocument,
	fallbackIndex: number,
	fallbackPreference: InkCursorLinePreference = 'auto',
): InkCanonicalCursor {
	const source = doc.meta.cursor;
	const strokeCount = doc.strokes.length;
	return {
		index: clampCursorIndex(source?.index ?? fallbackIndex, strokeCount),
		linePreference: normalizeLinePreference(source?.linePreference ?? fallbackPreference),
		updatedAt:
			typeof source?.updatedAt === 'number' && Number.isFinite(source.updatedAt)
				? source.updatedAt
				: 0,
	};
}

export function writeCanonicalCursor(
	doc: InkDocument,
	index: number,
	linePreference: InkCursorLinePreference,
	now = Date.now(),
): InkCanonicalCursor {
	const next: InkCanonicalCursor = {
		index: clampCursorIndex(index, doc.strokes.length),
		linePreference: normalizeLinePreference(linePreference),
		updatedAt: now,
	};
	doc.meta.cursor = next;
	return next;
}

export function setLineBreakInsertOperation(
	doc: InkDocument,
	markerStrokeId: string,
	anchorIndexBefore: number,
	cursorAfter: InkCanonicalCursor,
	now = Date.now(),
): InkLineBreakInsertOperation {
	// This operation record provides deterministic "erase the just-added newline" behavior.
	const operation: InkLineBreakInsertOperation = {
		type: 'line-break-insert',
		markerStrokeId,
		createdAt: now,
		anchorIndexBefore: clampCursorIndex(anchorIndexBefore, doc.strokes.length),
		cursorAfter,
	};
	doc.meta.lastStructuralOp = operation;
	return operation;
}

export function getLineBreakInsertOperation(doc: InkDocument): InkLineBreakInsertOperation | null {
	const op = doc.meta.lastStructuralOp;
	if (!op || op.type !== 'line-break-insert') {
		return null;
	}
	return op;
}

export function clearStructuralOperation(doc: InkDocument): void {
	doc.meta.lastStructuralOp = null;
}
