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

import { InkDocument, InkLine, InkSelection, orderCursors, selectionIsEmpty } from './doc';
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

// A compact signature of a document's ink (FNV-1a over rounded stroke coordinates). It changes iff
// the handwriting changes, so the search sidecar can tell when its stored text has gone stale and
// skip re-recognising (and re-spending MyScript quota) when the strokes are unchanged. Independent
// of layout/render settings — only the drawn geometry matters.
export function inkSignature(doc: InkDocument): string {
	let h = 0x811c9dc5;
	const mix = (n: number): void => {
		h ^= n;
		h = Math.imul(h, 0x01000193);
	};
	for (const line of doc.lines) {
		for (const word of line.words) {
			for (const stroke of word.strokes) {
				for (const p of stroke.points) {
					mix(Math.round(p.x * 100));
					mix(Math.round(p.y * 100));
				}
				mix(0x7fffffff); // stroke boundary
			}
		}
		mix(0x5eeeeee5); // line boundary
	}
	return (h >>> 0).toString(16);
}

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

// The recognizer only ever sees pen strokes — it has no idea a line is a bullet or checkbox
// item, so plain recognized text loses that structure. Re-apply it afterwards by matching
// recognized lines, in order, against the document lines that actually contributed strokes to
// the request (the same lines buildRecognitionStrokes would have drawn from: any line with words
// in the requested range). If the counts don't agree — the recognizer merged or split a line,
// which it's free to do — there's no reliable way to attribute markup to the right line, so the
// original text comes back unchanged rather than risking a prefix on the wrong line.
export function applyListMarkupToRecognizedText(
	doc: InkDocument,
	selection: InkSelection | null,
	text: string,
): string {
	if (!text) {
		return text;
	}
	let from = 0;
	let to = doc.lines.length - 1;
	if (selection && !selectionIsEmpty(selection)) {
		const [start, end] = orderCursors(selection.anchor, selection.focus);
		from = start.line;
		to = end.line;
	}
	const sourceLines: InkLine[] = [];
	for (let i = from; i <= to; i += 1) {
		const line = doc.lines[i];
		if (line && line.words.length > 0) {
			sourceLines.push(line);
		}
	}
	const textLines = text.split('\n');
	if (sourceLines.length !== textLines.length) {
		return text;
	}
	return textLines
		.map((lineText, i) => {
			const line = sourceLines[i]!;
			const indent = '\t'.repeat(line.indent ?? 0);
			if (line.checkbox) {
				return `${indent}- [${line.checked ? 'x' : ' '}] ${lineText}`;
			}
			if (line.bullet) {
				return `${indent}- ${lineText}`;
			}
			return lineText;
		})
		.join('\n');
}
