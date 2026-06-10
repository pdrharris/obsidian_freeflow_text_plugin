// The single layout engine for the flowing-text ink model.
//
// `layoutDocument` is a pure function: it takes the logical document (lines -> words ->
// strokes) plus a width/scale config and returns fully-placed geometry in CSS pixels, along
// with hit-testing helpers. BOTH the inline renderer and the drawer consume this, so the two
// views can never disagree. All editing is a tree splice followed by a relayout — there is no
// per-operation coordinate patching.
//
// Glyph scale is driven by `targetLineHeightCss` and is INDEPENDENT of the wrap width, so the
// drawer can render large "write big" glyphs with no soft-wrap (contentWidthCss = Infinity)
// while the inline view renders small glyphs that wrap to the note width.
//
// Input coordinate conventions:
//   - A word is a rigid cluster; its strokes share one local coordinate space.
//   - Stroke point Y is relative to the writing baseline (0 = baseline, negative = above).

import {
	InkBounds,
	InkCursor,
	InkDocument,
	InkSelection,
	InkStroke,
	InkWord,
	orderCursors,
	wordBounds,
} from './doc';

const BASELINE_RATIO_FROM_TOP = 2 / 3;
const DEFAULT_MARGIN_X = 16;
const FALLBACK_SOURCE_HEIGHT_RATIO = 0.28;

export interface LayoutConfig {
	// Soft-wrap width in CSS px. Pass Number.POSITIVE_INFINITY to disable wrapping (drawer).
	contentWidthCss: number;
	// Desired visual row height in CSS px; drives glyph scale.
	targetLineHeightCss: number;
	// Source line height from doc.meta.lineHeight (capture space).
	sourceLineHeight: number;
	wordGapScale: number;
	strokeFillScale: number;
	marginXCss?: number;
	// When true, each laid point carries a per-point width (`LaidPoint.w`) derived from pen
	// speed so fast strokes render thinner and slow strokes thicker.
	velocityWidth?: boolean;
	// When set, each line is anchored so this source-x maps to the left margin (the drawer passes
	// 0 for WYSIWYG — strokes stay exactly where drawn). When omitted, rows re-origin to the first
	// word's min-x, flushing content to the line start (the inline renderer's behaviour).
	rowOriginSource?: number;
}

export interface LaidPoint {
	x: number;
	y: number;
	// Per-point stroke width in css px (only set when velocity width is enabled); when absent,
	// the renderer uses a single width for the whole stroke.
	w?: number;
}

export interface LaidStroke {
	stroke: InkStroke;
	points: LaidPoint[];
}

export interface LaidWord {
	line: number; // logical line index
	word: number; // logical word index within the line
	visualRow: number; // output row after wrapping
	x: number; // left edge, css px
	baselineY: number; // baseline, css px
	width: number; // css px
	height: number; // css px (ascender..descender extent)
	strokes: LaidStroke[];
}

export interface CaretRect {
	x: number;
	y: number;
	height: number;
	baselineY: number;
}

export interface HighlightRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface LayoutResult {
	words: LaidWord[];
	width: number; // css px (wrap width if finite, else content extent)
	height: number; // css px
	rowHeight: number; // effective visual line height, css px
	baselineOffset: number; // css px from the top of a row down to the writing baseline
	cssPerSource: number; // scale factor source -> css
	marginX: number; // css px left margin
	cursorFromPoint(x: number, y: number): InkCursor;
	caretRect(cursor: InkCursor): CaretRect;
	rangeRects(selection: InkSelection): HighlightRect[];
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

function estimateSourceStrokeHeightRatio(doc: InkDocument, lineHeight: number): number {
	const ratios: number[] = [];
	for (const line of doc.lines) {
		for (const word of line.words) {
			for (const stroke of word.strokes) {
				let minY = Infinity;
				let maxY = -Infinity;
				for (const p of stroke.points) {
					if (p.y < minY) minY = p.y;
					if (p.y > maxY) maxY = p.y;
				}
				if (minY === Infinity) {
					continue;
				}
				const ratio = Math.max(1, maxY - minY) / Math.max(1, lineHeight);
				if (Number.isFinite(ratio) && ratio > 0) {
					ratios.push(ratio);
				}
			}
		}
	}
	if (ratios.length < 10) {
		return FALLBACK_SOURCE_HEIGHT_RATIO;
	}
	ratios.sort((a, b) => a - b);
	const p90 =
		ratios[Math.min(ratios.length - 1, Math.floor((ratios.length - 1) * 0.9))] ??
		FALLBACK_SOURCE_HEIGHT_RATIO;
	const blended = p90 * 0.6 + FALLBACK_SOURCE_HEIGHT_RATIO * 0.4;
	return clamp(Math.max(FALLBACK_SOURCE_HEIGHT_RATIO, blended), 0.2, 0.75);
}

interface RowInfo {
	line: number;
	visualRow: number;
	words: LaidWord[];
}

export function layoutDocument(doc: InkDocument, config: LayoutConfig): LayoutResult {
	const sourceLineHeight = Math.max(80, config.sourceLineHeight);
	const strokeFillScale = clamp(config.strokeFillScale, 0.4, 1.6);
	const rowHeight = Math.max(8, config.targetLineHeightCss);
	const sourceHeightRatio = estimateSourceStrokeHeightRatio(doc, sourceLineHeight);
	// Glyph scale: a typical stroke (sourceHeightRatio * sourceLineHeight tall) maps to a
	// pleasant fraction of the row height. Independent of canvas width.
	const cssPerSource = (rowHeight * strokeFillScale) / (sourceLineHeight * sourceHeightRatio);
	const baselineOffset = rowHeight * BASELINE_RATIO_FROM_TOP;
	const marginX = config.marginXCss ?? DEFAULT_MARGIN_X;
	const availableWidth = Math.max(20, config.contentWidthCss - marginX * 2);

	const laidWords: LaidWord[] = [];
	const rows: RowInfo[] = [];
	let visualRow = 0;
	let maxRight = marginX;

	const ensureRow = (lineIndex: number, row: number): RowInfo => {
		let info = rows.find((r) => r.visualRow === row);
		if (!info) {
			info = { line: lineIndex, visualRow: row, words: [] };
			rows.push(info);
		}
		return info;
	};

	for (let lineIndex = 0; lineIndex < doc.lines.length; lineIndex += 1) {
		const line = doc.lines[lineIndex];
		if (!line) {
			continue;
		}
		// Words are placed at their LINE-ABSOLUTE x so drawn whitespace is preserved exactly.
		// `rowOriginSource` is the source-x that maps to the left margin of the current row
		// (the first word of the line/row); on wrap it resets so the wrapped word starts at the
		// margin while keeping the within-row spacing of the words that follow it. When the caller
		// pins it (drawer WYSIWYG), the first row keeps that fixed origin instead of re-flushing.
		let rowOriginSource: number | null = config.rowOriginSource ?? null;
		let rowHasContent = false;
		ensureRow(lineIndex, visualRow);

		for (let wordIndex = 0; wordIndex < line.words.length; wordIndex += 1) {
			const word = line.words[wordIndex];
			if (!word) {
				continue;
			}
			const bounds = wordBounds(word);
			if (!bounds) {
				continue;
			}
			const wordWidth = Math.max(0, bounds.maxX - bounds.minX) * cssPerSource;
			if (rowOriginSource === null) {
				rowOriginSource = bounds.minX;
			}
			let leftCss = marginX + (bounds.minX - rowOriginSource) * cssPerSource;

			if (rowHasContent && leftCss - marginX + wordWidth > availableWidth) {
				visualRow += 1;
				rowOriginSource = bounds.minX;
				rowHasContent = false;
				ensureRow(lineIndex, visualRow);
				leftCss = marginX;
			}

			const baselineY = visualRow * rowHeight + baselineOffset;
			const placed = placeWord(
				word,
				bounds,
				leftCss,
				baselineY,
				cssPerSource,
				wordWidth,
				rowHeight,
				config.velocityWidth === true,
			);
			placed.line = lineIndex;
			placed.word = wordIndex;
			placed.visualRow = visualRow;
			laidWords.push(placed);
			ensureRow(lineIndex, visualRow).words.push(placed);

			rowHasContent = true;
			if (leftCss + wordWidth + marginX > maxRight) {
				maxRight = leftCss + wordWidth + marginX;
			}
		}

		visualRow += 1; // next logical line starts on a fresh row
	}

	const totalRows = Math.max(1, visualRow);
	const height = totalRows * rowHeight;
	const width = Number.isFinite(config.contentWidthCss)
		? config.contentWidthCss
		: Math.max(marginX * 2, maxRight);

	rows.sort((a, b) => a.visualRow - b.visualRow);

	return {
		words: laidWords,
		width,
		height,
		rowHeight,
		baselineOffset,
		cssPerSource,
		marginX,
		cursorFromPoint: (x, y) => cursorFromPoint(rows, rowHeight, x, y),
		caretRect: (cursor) => caretRect(laidWords, rows, rowHeight, marginX, baselineOffset, cursor),
		rangeRects: (selection) => rangeRects(laidWords, rowHeight, selection),
	};
}

function placeWord(
	word: InkWord,
	bounds: InkBounds | null,
	leftCss: number,
	baselineY: number,
	cssPerSource: number,
	wordWidth: number,
	rowHeight: number,
	velocityWidth: boolean,
): LaidWord {
	const originX = bounds ? bounds.minX : 0;
	const strokes: LaidStroke[] = word.strokes.map((stroke) => {
		const widths = velocityWidth ? velocityWidths(stroke, cssPerSource) : null;
		return {
			stroke,
			points: stroke.points.map((p, i) => {
				const laid: LaidPoint = {
					x: leftCss + (p.x - originX) * cssPerSource,
					y: baselineY + p.y * cssPerSource,
				};
				if (widths) {
					laid.w = widths[i];
				}
				return laid;
			}),
		};
	});
	const top = bounds ? baselineY + bounds.minY * cssPerSource : baselineY - rowHeight * 0.6;
	const bottom = bounds ? baselineY + bounds.maxY * cssPerSource : baselineY;
	return {
		line: 0,
		word: 0,
		visualRow: 0,
		x: leftCss,
		baselineY,
		width: wordWidth,
		height: Math.max(rowHeight * 0.3, bottom - top),
		strokes,
	};
}

// Per-point widths from pen speed. Self-normalising per stroke (relative to the stroke's own
// median speed) so it needs no absolute calibration: points drawn faster than the stroke's
// typical speed get thinner, slower points thicker. Returns css-px widths, bold baked in.
const VELOCITY_MIN_FACTOR = 0.55;
const VELOCITY_MAX_FACTOR = 1.75;
function velocityWidths(stroke: InkStroke, cssPerSource: number): number[] {
	const pts = stroke.points;
	const n = pts.length;
	const base = Math.max(0.6, stroke.width * cssPerSource * (stroke.bold ? 1.7 : 1));
	if (n < 2) {
		return [base];
	}
	const segSpeed: number[] = [];
	for (let i = 1; i < n; i += 1) {
		const a = pts[i - 1];
		const b = pts[i];
		if (!a || !b) {
			segSpeed.push(0);
			continue;
		}
		const dist = Math.hypot(b.x - a.x, b.y - a.y);
		const dt = Math.max(1, b.time - a.time);
		segSpeed.push(dist / dt);
	}
	const sorted = [...segSpeed].filter((s) => s > 0).sort((a, b) => a - b);
	const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] ?? 0 : 0;
	if (median <= 0) {
		return new Array<number>(n).fill(base);
	}
	const widthAt = (speed: number): number => {
		const ratio = median / Math.max(speed, median * 0.05);
		const factor = clamp(Math.sqrt(ratio), VELOCITY_MIN_FACTOR, VELOCITY_MAX_FACTOR);
		return base * factor;
	};
	const raw: number[] = new Array<number>(n);
	raw[0] = widthAt(segSpeed[0] ?? median);
	for (let i = 1; i < n - 1; i += 1) {
		raw[i] = widthAt(((segSpeed[i - 1] ?? median) + (segSpeed[i] ?? median)) / 2);
	}
	raw[n - 1] = widthAt(segSpeed[n - 2] ?? median);
	// Light smoothing so the ribbon doesn't jitter point-to-point.
	const out: number[] = new Array<number>(n);
	for (let i = 0; i < n; i += 1) {
		const prev = raw[i - 1] ?? raw[i] ?? base;
		const cur = raw[i] ?? base;
		const next = raw[i + 1] ?? raw[i] ?? base;
		out[i] = (prev + cur * 2 + next) / 4;
	}
	return out;
}

function cursorFromPoint(rows: RowInfo[], rowHeight: number, x: number, y: number): InkCursor {
	const firstRow = rows[0];
	if (!firstRow) {
		return { line: 0, word: 0 };
	}
	const targetRow = Math.floor(y / Math.max(1, rowHeight));
	let row = firstRow;
	let bestDelta = Infinity;
	for (const candidate of rows) {
		const delta = Math.abs(candidate.visualRow - targetRow);
		if (delta < bestDelta) {
			bestDelta = delta;
			row = candidate;
		}
	}

	const line = row.line;
	const words = row.words;
	const last = words[words.length - 1];
	if (!last) {
		return { line, word: 0 };
	}
	for (const w of words) {
		if (x < w.x + w.width * 0.5) {
			return { line, word: w.word };
		}
	}
	return { line, word: last.word + 1 };
}

function caretRect(
	laidWords: LaidWord[],
	rows: RowInfo[],
	rowHeight: number,
	marginX: number,
	baselineOffset: number,
	cursor: InkCursor,
): CaretRect {
	const caretHeight = Math.max(12, rowHeight * 0.8);
	const onLine = laidWords.filter((w) => w.line === cursor.line);

	const fromRow = (visualRow: number, x: number): CaretRect => {
		const baselineY = visualRow * rowHeight + baselineOffset;
		return { x, y: baselineY - caretHeight, height: caretHeight, baselineY };
	};

	if (onLine.length === 0) {
		const row = rows.find((r) => r.line === cursor.line);
		return fromRow(row ? row.visualRow : 0, marginX);
	}

	const before = onLine.find((w) => w.word === cursor.word);
	if (before) {
		return fromRow(before.visualRow, before.x);
	}
	const last = onLine[onLine.length - 1];
	if (!last) {
		return fromRow(0, marginX);
	}
	return fromRow(last.visualRow, last.x + last.width);
}

function rangeRects(
	laidWords: LaidWord[],
	rowHeight: number,
	selection: InkSelection,
): HighlightRect[] {
	const [start, end] = orderCursors(selection.anchor, selection.focus);
	const selected = laidWords.filter((w) => {
		if (w.line < start.line || w.line > end.line) {
			return false;
		}
		if (w.line === start.line && w.word < start.word) {
			return false;
		}
		if (w.line === end.line && w.word >= end.word) {
			return false;
		}
		return true;
	});
	const byRow = new Map<number, LaidWord[]>();
	for (const w of selected) {
		const list = byRow.get(w.visualRow);
		if (list) {
			list.push(w);
		} else {
			byRow.set(w.visualRow, [w]);
		}
	}
	const rects: HighlightRect[] = [];
	for (const [visualRow, list] of byRow) {
		let minX = Infinity;
		let maxX = -Infinity;
		for (const w of list) {
			if (w.x < minX) minX = w.x;
			if (w.x + w.width > maxX) maxX = w.x + w.width;
		}
		rects.push({ x: minX, y: visualRow * rowHeight, w: maxX - minX, h: rowHeight });
	}
	return rects;
}
