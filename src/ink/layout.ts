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
	MAX_INDENT_LEVEL,
	orderCursors,
	wordBounds,
} from './doc';

const BASELINE_RATIO_FROM_TOP = 2 / 3;
const DEFAULT_MARGIN_X = 16;
const FALLBACK_SOURCE_HEIGHT_RATIO = 0.28;
// List geometry, all expressed as fractions of the row height so they track the glyph scale in
// both the small inline view and the large drawer strip.
const INDENT_STEP_RATIO = 1.1; // left inset added per indent level
const BULLET_RESERVE_RATIO = 0.85; // gap reserved between the bullet and the line's first word
const BULLET_RADIUS_RATIO = 0.085; // bullet dot radius
const BULLET_RISE_RATIO = 0.2; // how far above the baseline the bullet centre sits
const DEFAULT_BULLET_COLOR = '#111827';

export interface LayoutConfig {
	// Soft-wrap width in CSS px. Pass Number.POSITIVE_INFINITY to disable wrapping (drawer).
	contentWidthCss: number;
	// Desired visual row height in CSS px; drives glyph scale.
	targetLineHeightCss: number;
	// Source line height from doc.meta.lineHeight (capture space).
	sourceLineHeight: number;
	wordGapScale: number;
	strokeFillScale: number;
	// Render-time multiplier on stroke thickness (default 1). Applied to the per-point width base.
	strokeWeight?: number;
	marginXCss?: number;
	// When true, each laid point carries a per-point width (`LaidPoint.w`) derived from pen
	// speed so fast strokes render thinner and slow strokes thicker.
	velocityWidth?: boolean;
	// When true, fold per-point pen pressure into the width too (combined with velocity when both
	// are on). No-op for finger/mouse input, which reports a constant mid pressure.
	pressureWidth?: boolean;
	// Non-causal path smoothing strength 0..1 (0 = off). Cleans hand jitter at render time without
	// touching the stored points; widths are computed from the smoothed path too.
	smoothing?: number;
	// Fixed glyph-scale source ratio. When set, it overrides the per-document estimate so the scale
	// stays stable even as the laid-out content changes (the drawer pins this for the whole session,
	// so a growing line doesn't keep rescaling and jumping the caret).
	sourceHeightRatio?: number;
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

// A list bullet to paint at a line start (css px). Emitted once per bulleted logical line, on its
// first visual row; the renderer just fills a dot of `radius` at (x, y) in `color`.
export interface BulletMark {
	x: number;
	y: number;
	radius: number;
	color: string;
}

export interface LayoutResult {
	words: LaidWord[];
	bullets: BulletMark[];
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

export function estimateSourceStrokeHeightRatio(doc: InkDocument, lineHeight: number): number {
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
	const strokeWeight = clamp(config.strokeWeight ?? 1, 0.3, 4);
	const smoothing = clamp(config.smoothing ?? 0, 0, 1);
	const sourceHeightRatio =
		config.sourceHeightRatio ?? estimateSourceStrokeHeightRatio(doc, sourceLineHeight);
	// Glyph scale: a typical stroke (sourceHeightRatio * sourceLineHeight tall) maps to a
	// pleasant fraction of the row height. Independent of canvas width.
	const cssPerSource = (rowHeight * strokeFillScale) / (sourceLineHeight * sourceHeightRatio);
	const baselineOffset = rowHeight * BASELINE_RATIO_FROM_TOP;
	const marginX = config.marginXCss ?? DEFAULT_MARGIN_X;
	const indentStep = rowHeight * INDENT_STEP_RATIO;
	const bulletReserve = rowHeight * BULLET_RESERVE_RATIO;

	const laidWords: LaidWord[] = [];
	const bullets: BulletMark[] = [];
	// The left inset (css px) of each logical line's content, for caret placement on empty/indented
	// lines. Continuation (wrapped) rows hang to this same inset, so they align under the first word.
	const lineInsets = new Map<number, number>();
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
		// List structure → a left inset. The bullet (if any) sits at the indent stop; the line's
		// content (and every wrapped continuation row) starts a fixed gap to its right, so wrapped
		// rows hang under the first word rather than under the bullet.
		const indentLevel = clamp(line.indent ?? 0, 0, MAX_INDENT_LEVEL);
		const hasBullet = line.bullet === true;
		const indentCss = marginX + indentLevel * indentStep;
		const contentLeft = indentCss + (hasBullet ? bulletReserve : 0);
		lineInsets.set(lineIndex, contentLeft);
		const availableWidth = Number.isFinite(config.contentWidthCss)
			? Math.max(20, config.contentWidthCss - contentLeft - marginX)
			: Number.POSITIVE_INFINITY;
		const firstVisualRow = visualRow;
		let lineColor = DEFAULT_BULLET_COLOR;
		let lineColorFound = false;

		// Words are placed at their LINE-ABSOLUTE x so drawn whitespace is preserved exactly.
		// `rowOriginSource` is the source-x that maps to the content-left of the current row
		// (the first word of the line/row); on wrap it resets so the wrapped word starts at the
		// inset while keeping the within-row spacing of the words that follow it. When the caller
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
			let leftCss = contentLeft + (bounds.minX - rowOriginSource) * cssPerSource;

			if (rowHasContent && leftCss - contentLeft + wordWidth > availableWidth) {
				visualRow += 1;
				rowOriginSource = bounds.minX;
				rowHasContent = false;
				ensureRow(lineIndex, visualRow);
				leftCss = contentLeft;
			}
			if (!lineColorFound) {
				const firstStroke = word.strokes[0];
				if (firstStroke) {
					lineColor = firstStroke.color;
					lineColorFound = true;
				}
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
				config.pressureWidth === true,
				strokeWeight,
				smoothing,
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

		if (hasBullet) {
			// One dot per bulleted line, on its first visual row, centred in the reserved gap and
			// sitting just above the baseline so it reads like a mid-line list marker.
			bullets.push({
				x: indentCss + bulletReserve * 0.4,
				y: firstVisualRow * rowHeight + baselineOffset - rowHeight * BULLET_RISE_RATIO,
				radius: Math.max(1.2, rowHeight * BULLET_RADIUS_RATIO),
				color: lineColor,
			});
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
		bullets,
		width,
		height,
		rowHeight,
		baselineOffset,
		cssPerSource,
		marginX,
		cursorFromPoint: (x, y) => cursorFromPoint(rows, rowHeight, x, y),
		caretRect: (cursor) =>
			caretRect(laidWords, rows, rowHeight, lineInsets, marginX, baselineOffset, cursor),
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
	pressureWidth: boolean,
	strokeWeight: number,
	smoothing: number,
): LaidWord {
	const originX = bounds ? bounds.minX : 0;
	const strokes: LaidStroke[] = word.strokes.map((stroke) => {
		// Smooth the path (non-destructively) before measuring width and placing, so both the
		// geometry and the velocity/pressure widths come from the cleaned path.
		const srcPoints = smoothing > 0 ? smoothPolyline(stroke.points, smoothing) : stroke.points;
		const widths =
			velocityWidth || pressureWidth
				? strokePointWidths(stroke, srcPoints, cssPerSource, velocityWidth, pressureWidth, strokeWeight)
				: null;
		return {
			stroke,
			points: srcPoints.map((p, i) => {
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

// Per-point widths from pen speed and/or pressure. Both contribute a multiplicative factor that is
// centred at 1 (so each is a no-op when its signal is flat), then the result is lightly smoothed.
// Returns css-px widths with bold baked in.
//
// Velocity is self-normalising per stroke (relative to the stroke's own median speed) so it needs
// no absolute calibration: points faster than typical get thinner, slower points thicker. Pressure
// is centred at the neutral mid value (0.5) that finger/mouse report, so flat pressure → factor 1.
const VELOCITY_MIN_FACTOR = 0.55;
const VELOCITY_MAX_FACTOR = 1.75;
const PRESSURE_NEUTRAL = 0.5;
const PRESSURE_GAIN = 1.4; // how strongly pressure deviation from neutral moves the width
const PRESSURE_MIN_FACTOR = 0.6;
const PRESSURE_MAX_FACTOR = 1.8;
const COMBINED_MIN_FACTOR = 0.45;
const COMBINED_MAX_FACTOR = 2.2;

function strokePointWidths(
	stroke: InkStroke,
	pts: InkStroke['points'],
	cssPerSource: number,
	useVelocity: boolean,
	usePressure: boolean,
	strokeWeight: number,
): number[] {
	const n = pts.length;
	const base = Math.max(0.6, stroke.width * cssPerSource * (stroke.bold ? 1.7 : 1) * strokeWeight);
	if (n < 2) {
		return [base];
	}

	const velFactors = useVelocity ? velocityFactors(pts) : null;
	const preFactors = usePressure ? pressureFactors(pts) : null;

	const raw: number[] = new Array<number>(n);
	for (let i = 0; i < n; i += 1) {
		let factor = 1;
		if (velFactors) {
			factor *= velFactors[i] ?? 1;
		}
		if (preFactors) {
			factor *= preFactors[i] ?? 1;
		}
		raw[i] = base * clamp(factor, COMBINED_MIN_FACTOR, COMBINED_MAX_FACTOR);
	}

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

// Velocity factor per point, centred at ~1 around the stroke's median speed.
function velocityFactors(pts: InkStroke['points']): number[] {
	const n = pts.length;
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
		return new Array<number>(n).fill(1);
	}
	const factorAt = (speed: number): number => {
		const ratio = median / Math.max(speed, median * 0.05);
		return clamp(Math.sqrt(ratio), VELOCITY_MIN_FACTOR, VELOCITY_MAX_FACTOR);
	};
	const out: number[] = new Array<number>(n);
	out[0] = factorAt(segSpeed[0] ?? median);
	for (let i = 1; i < n - 1; i += 1) {
		out[i] = factorAt(((segSpeed[i - 1] ?? median) + (segSpeed[i] ?? median)) / 2);
	}
	out[n - 1] = factorAt(segSpeed[n - 2] ?? median);
	return out;
}

// Pressure factor per point, centred at 1 at the neutral pressure (0.5). Finger/mouse report a
// constant 0.5, so this yields a flat 1 (no effect) and the width falls back to velocity/base.
function pressureFactors(pts: InkStroke['points']): number[] {
	return pts.map((p) => {
		const pressure = typeof p.pressure === 'number' ? p.pressure : PRESSURE_NEUTRAL;
		const factor = 1 + (pressure - PRESSURE_NEUTRAL) * PRESSURE_GAIN;
		return clamp(factor, PRESSURE_MIN_FACTOR, PRESSURE_MAX_FACTOR);
	});
}

// Non-causal path smoothing: repeated 3-tap binomial averaging with the endpoints pinned (so the
// stroke keeps its start/end and overall extent). Because the whole stroke is known, this is
// lag-free — unlike a live one-euro filter — and cleans hand jitter while preserving letter shape.
// Generic over any point with x/y; other fields (pressure, time) are carried through unchanged.
export function smoothPolyline<T extends { x: number; y: number }>(pts: T[], strength: number): T[] {
	const n = pts.length;
	if (n < 3 || strength <= 0) {
		return pts;
	}
	const passes = 4;
	const lambda = clamp(strength, 0, 1) * 0.5;
	let cur: T[] = pts.map((p) => ({ ...p }));
	for (let pass = 0; pass < passes; pass += 1) {
		const next: T[] = cur.map((p) => ({ ...p }));
		for (let i = 1; i < n - 1; i += 1) {
			const prev = cur[i - 1];
			const mid = cur[i];
			const nxt = cur[i + 1];
			const out = next[i];
			if (!prev || !mid || !nxt || !out) {
				continue;
			}
			out.x = mid.x + ((prev.x + nxt.x) / 2 - mid.x) * lambda;
			out.y = mid.y + ((prev.y + nxt.y) / 2 - mid.y) * lambda;
		}
		cur = next;
	}
	return cur;
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
	lineInsets: Map<number, number>,
	marginX: number,
	baselineOffset: number,
	cursor: InkCursor,
): CaretRect {
	const caretHeight = Math.max(12, rowHeight * 0.8);
	const inset = lineInsets.get(cursor.line) ?? marginX;
	const onLine = laidWords.filter((w) => w.line === cursor.line);

	const fromRow = (visualRow: number, x: number): CaretRect => {
		const baselineY = visualRow * rowHeight + baselineOffset;
		return { x, y: baselineY - caretHeight, height: caretHeight, baselineY };
	};

	if (onLine.length === 0) {
		const row = rows.find((r) => r.line === cursor.line);
		return fromRow(row ? row.visualRow : 0, inset);
	}

	const before = onLine.find((w) => w.word === cursor.word);
	if (before) {
		return fromRow(before.visualRow, before.x);
	}
	const last = onLine[onLine.length - 1];
	if (!last) {
		return fromRow(0, inset);
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
