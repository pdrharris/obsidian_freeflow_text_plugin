// Turning ink into text — the engine-agnostic front half.
//
// `buildRecognitionStrokes` is a pure function (no Obsidian imports, so it's headless-testable):
// it lays the document out with NO soft-wrap, so each logical line becomes exactly one horizontal
// row, then emits per-stroke {x, y, t} arrays in that laid-out 2D plane. That is the shape every
// online handwriting engine (MyScript, ML Kit, …) wants — a faithful pen trace with the lines
// separated vertically — so the recognizer itself (see `myscript.ts`) only has to do the HTTP call.
//
// Point Y in the model is baseline-relative (every line shares the same range), so feeding raw
// stroke points would stack all lines on top of each other. Laying out first is what gives each
// line its own vertical band and lets multi-line recognition come back with real line breaks.

import { InkDocument, InkSelection, orderCursors, selectionIsEmpty } from './doc';
import { layoutDocument } from './layout';

// One stroke as parallel coordinate/time arrays (the MyScript batch stroke shape). x/y are CSS px
// in the laid-out plane; t is milliseconds, monotonically increasing across the whole input.
export interface RecognitionStroke {
	x: number[];
	y: number[];
	t: number[];
}

const POINT_MS = 8; // synthetic time step per point
const STROKE_GAP_MS = 80; // synthetic pen-up gap between strokes

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

// Build the recognizer input for a document, or for just the selected words when a selection is
// given. Returns [] when there is nothing to recognize.
export function buildRecognitionStrokes(
	doc: InkDocument,
	selection: InkSelection | null,
): RecognitionStroke[] {
	const layout = layoutDocument(doc, {
		contentWidthCss: Number.POSITIVE_INFINITY, // no wrap: one row per logical line
		targetLineHeightCss: 60,
		sourceLineHeight: doc.meta.lineHeight,
		wordGapScale: 1,
		strokeFillScale: 1,
		velocityWidth: false,
		pressureWidth: false,
		strokeWeight: 1,
		smoothing: 0,
	});

	let words = layout.words;
	if (selection && !selectionIsEmpty(selection)) {
		const [start, end] = orderCursors(selection.anchor, selection.focus);
		words = words.filter((w) => {
			if (w.line < start.line || w.line > end.line) return false;
			if (w.line === start.line && w.word < start.word) return false;
			if (w.line === end.line && w.word >= end.word) return false;
			return true;
		});
	}

	const strokes: RecognitionStroke[] = [];
	let clock = 0;
	for (const word of words) {
		for (const laid of word.strokes) {
			if (laid.points.length === 0) {
				continue;
			}
			const x: number[] = [];
			const y: number[] = [];
			const t: number[] = [];
			for (const p of laid.points) {
				x.push(round2(p.x));
				y.push(round2(p.y));
				t.push(clock);
				clock += POINT_MS;
			}
			clock += STROKE_GAP_MS;
			strokes.push({ x, y, t });
		}
	}
	return strokes;
}
