// Flowing-text ink document model (v3).
//
// Content is a logical tree: Document -> Lines -> Words -> Strokes. Stroke points are stored
// in LINE-ABSOLUTE coordinates: x is the position along the line (so the whitespace you draw
// between strokes is preserved exactly) and y is relative to the line baseline. Words are just
// whitespace groupings of the line's strokes (used for selection and wrapping); they do NOT
// affect spacing. The layout engine scales these coordinates and wraps lines to width, but it
// never re-spaces what you drew. Editing is a tree splice + relayout (no coordinate patching).
//
// v2 (the previous convention) stored points in word-local space and normalised inter-word
// gaps; `parseInkDocument` migrates v2 docs to line-absolute on load.

export const INK_DOC_VERSION = 3 as const;
export const DEFAULT_LINE_HEIGHT = 180;
export const INK_CODE_BLOCK_LANGUAGE = 'fii-ink';

export interface InkPoint {
	x: number;
	y: number;
	pressure: number;
	time: number;
}

export interface InkStroke {
	id: string;
	// Points in line-absolute coordinates: x along the line, y relative to the baseline.
	points: InkPoint[];
	width: number;
	color: string;
	bold?: boolean;
	underline?: boolean;
}

export interface InkWord {
	id: string;
	strokes: InkStroke[];
}

export interface InkLine {
	id: string;
	words: InkWord[];
	// Optional list structure. Device-independent (no pixels): the layout engine turns these into
	// a left inset and a bullet glyph at render time. Absent = a normal flush-left line.
	indent?: number; // indent level, integer 0..MAX_INDENT_LEVEL
	bullet?: boolean; // draw a list bullet at the line start
	// Checkbox list item (shopping lists): draws a tappable box instead of a bullet. `checked`
	// persists with the document, and a checked line renders struck-through and dimmed.
	checkbox?: boolean;
	checked?: boolean; // only meaningful when checkbox is true
}

export const MAX_INDENT_LEVEL = 8;

// A logical insertion point: before `word` on line `line`. `word` ranges 0..words.length
// (length == "after the last word"). This is the single source of truth for the caret.
export interface InkCursor {
	line: number;
	word: number;
}

export interface InkSelection {
	anchor: InkCursor;
	focus: InkCursor;
}

export interface InkDocument {
	version: typeof INK_DOC_VERSION;
	meta: {
		lineHeight: number;
		cursor: InkCursor;
		selection: InkSelection | null;
		// Per-block display width as a fraction (0.3..1) of the available content column. Stored
		// with the block so a resized block keeps its width on every device and through sync. When
		// absent, the block uses the global "Displayed line width" default.
		widthScale?: number;
	};
	lines: InkLine[];
}

// Clamp a per-block width fraction to the supported range.
export function clampWidthScale(value: number): number {
	return value < MIN_WIDTH_SCALE
		? MIN_WIDTH_SCALE
		: value > MAX_WIDTH_SCALE
			? MAX_WIDTH_SCALE
			: value;
}

export const MIN_WIDTH_SCALE = 0.3;
export const MAX_WIDTH_SCALE = 1;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function createStrokeId(): string {
	return nextId('s');
}
export function createWordId(): string {
	return nextId('w');
}
export function createLineId(): string {
	return nextId('l');
}

export function createEmptyLine(): InkLine {
	return { id: createLineId(), words: [] };
}

// Deep clone with fresh ids — used when copying/pasting so duplicated content never shares ids.
export function cloneStroke(stroke: InkStroke): InkStroke {
	return { ...stroke, id: createStrokeId(), points: stroke.points.map((p) => ({ ...p })) };
}
export function cloneWord(word: InkWord): InkWord {
	return { id: createWordId(), strokes: word.strokes.map(cloneStroke) };
}

// A clipboard fragment: one word-list per copied line segment (length 1 == single-line copy).
export interface InkFragment {
	segments: InkWord[][];
}

export function cloneFragment(fragment: InkFragment): InkFragment {
	return { segments: fragment.segments.map((seg) => seg.map(cloneWord)) };
}

export function fragmentIsEmpty(fragment: InkFragment | null): boolean {
	return !fragment || fragment.segments.every((seg) => seg.length === 0);
}

export function createEmptyDocument(lineHeight = DEFAULT_LINE_HEIGHT): InkDocument {
	return {
		version: INK_DOC_VERSION,
		meta: {
			lineHeight,
			cursor: { line: 0, word: 0 },
			selection: null,
		},
		lines: [createEmptyLine()],
	};
}

// ---------------------------------------------------------------------------
// Geometry helpers (read-only)
// ---------------------------------------------------------------------------

export interface InkBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export function strokeBounds(stroke: InkStroke): InkBounds | null {
	if (stroke.points.length === 0) {
		return null;
	}
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const p of stroke.points) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	return { minX, maxX, minY, maxY };
}

// Translate every point of a word along the line by dx (line-absolute coordinates).
export function shiftWordX(word: InkWord, dx: number): void {
	if (dx === 0) {
		return;
	}
	for (const stroke of word.strokes) {
		for (const point of stroke.points) {
			point.x += dx;
		}
	}
}

export function wordBounds(word: InkWord): InkBounds | null {
	let bounds: InkBounds | null = null;
	for (const stroke of word.strokes) {
		const b = strokeBounds(stroke);
		if (!b) {
			continue;
		}
		if (!bounds) {
			bounds = { ...b };
			continue;
		}
		if (b.minX < bounds.minX) bounds.minX = b.minX;
		if (b.maxX > bounds.maxX) bounds.maxX = b.maxX;
		if (b.minY < bounds.minY) bounds.minY = b.minY;
		if (b.maxY > bounds.maxY) bounds.maxY = b.maxY;
	}
	return bounds;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeInkDocument(doc: InkDocument): string {
	return JSON.stringify(doc);
}

export function parseInkDocument(source: string): InkDocument {
	if (!source.trim()) {
		return createEmptyDocument();
	}
	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch {
		throw new Error('Invalid fii-ink JSON.');
	}
	if (!raw || typeof raw !== 'object') {
		throw new Error('Invalid fii-ink JSON: expected an object.');
	}
	const value = raw as Partial<InkDocument>;
	const version: unknown = (raw as { version?: unknown }).version;
	// Accept the current version and the previous one (which we migrate below).
	if ((version !== INK_DOC_VERSION && version !== 2) || !Array.isArray(value.lines)) {
		throw new Error(`Invalid fii-ink JSON: expected { version: ${INK_DOC_VERSION}, lines: [] }.`);
	}

	const lineHeight =
		typeof value.meta?.lineHeight === 'number' && value.meta.lineHeight >= 80
			? value.meta.lineHeight
			: DEFAULT_LINE_HEIGHT;

	const lines = value.lines
		.map((line) => normalizeLine(line))
		.filter((line): line is InkLine => line !== null);
	if (lines.length === 0) {
		lines.push(createEmptyLine());
	}

	if (version === 2) {
		// v2 stored word-local coordinates with normalised gaps. Spread each line's words to
		// line-absolute positions with a default gap so old content stays readable.
		migrateWordLocalToLineAbsolute(lines, lineHeight);
	}

	const cursor = clampCursor(value.meta?.cursor, lines);
	const selection = normalizeSelection(value.meta?.selection, lines);
	const rawWidthScale = value.meta?.widthScale;
	const widthScale =
		typeof rawWidthScale === 'number' && Number.isFinite(rawWidthScale)
			? clampWidthScale(rawWidthScale)
			: undefined;

	return {
		version: INK_DOC_VERSION,
		meta: { lineHeight, cursor, selection, ...(widthScale !== undefined ? { widthScale } : {}) },
		lines,
	};
}

function migrateWordLocalToLineAbsolute(lines: InkLine[], lineHeight: number): void {
	const defaultGap = lineHeight * 0.35;
	for (const line of lines) {
		let runningX = 0;
		for (const word of line.words) {
			const bounds = wordBounds(word);
			if (!bounds) {
				continue;
			}
			const shift = runningX - bounds.minX;
			for (const stroke of word.strokes) {
				for (const point of stroke.points) {
					point.x += shift;
				}
			}
			runningX += bounds.maxX - bounds.minX + defaultGap;
		}
	}
}

function normalizeLine(value: unknown): InkLine | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const maybe = value as Partial<InkLine>;
	if (!Array.isArray(maybe.words)) {
		return null;
	}
	const words = maybe.words
		.map((word) => normalizeWord(word))
		.filter((word): word is InkWord => word !== null);
	const line: InkLine = {
		id: typeof maybe.id === 'string' && maybe.id ? maybe.id : createLineId(),
		words,
	};
	if (typeof maybe.indent === 'number' && Number.isFinite(maybe.indent) && maybe.indent > 0) {
		line.indent = Math.min(MAX_INDENT_LEVEL, Math.floor(maybe.indent));
	}
	if (maybe.bullet === true) {
		line.bullet = true;
	}
	if (maybe.checkbox === true) {
		line.checkbox = true;
		if (maybe.checked === true) {
			line.checked = true;
		}
	}
	return line;
}

function normalizeWord(value: unknown): InkWord | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const maybe = value as Partial<InkWord>;
	if (!Array.isArray(maybe.strokes)) {
		return null;
	}
	const strokes = maybe.strokes
		.map((stroke) => normalizeStroke(stroke))
		.filter((stroke): stroke is InkStroke => stroke !== null);
	if (strokes.length === 0) {
		return null;
	}
	return {
		id: typeof maybe.id === 'string' && maybe.id ? maybe.id : createWordId(),
		strokes,
	};
}

function normalizeStroke(value: unknown): InkStroke | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const maybe = value as Partial<InkStroke>;
	if (!Array.isArray(maybe.points)) {
		return null;
	}
	const points = maybe.points
		.map((point) => normalizePoint(point))
		.filter((point): point is InkPoint => point !== null);
	if (points.length === 0) {
		return null;
	}
	const stroke: InkStroke = {
		id: typeof maybe.id === 'string' && maybe.id ? maybe.id : createStrokeId(),
		points,
		width:
			typeof maybe.width === 'number' && Number.isFinite(maybe.width)
				? Math.max(1, maybe.width)
				: 3,
		color: typeof maybe.color === 'string' ? maybe.color : '#111827',
	};
	if (maybe.bold === true) {
		stroke.bold = true;
	}
	if (maybe.underline === true) {
		stroke.underline = true;
	}
	return stroke;
}

function normalizePoint(value: unknown): InkPoint | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const maybe = value as Partial<InkPoint>;
	const x = Number(maybe.x);
	const y = Number(maybe.y);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return null;
	}
	return {
		x,
		y,
		pressure:
			typeof maybe.pressure === 'number' && Number.isFinite(maybe.pressure)
				? maybe.pressure
				: 0.5,
		time:
			typeof maybe.time === 'number' && Number.isFinite(maybe.time) ? maybe.time : 0,
	};
}

// ---------------------------------------------------------------------------
// Cursor / selection clamping
// ---------------------------------------------------------------------------

export function clampCursor(value: unknown, lines: InkLine[]): InkCursor {
	const maxLine = Math.max(0, lines.length - 1);
	let line = 0;
	let word = 0;
	if (value && typeof value === 'object') {
		const maybe = value as Partial<InkCursor>;
		if (typeof maybe.line === 'number' && Number.isFinite(maybe.line)) {
			line = Math.floor(maybe.line);
		}
		if (typeof maybe.word === 'number' && Number.isFinite(maybe.word)) {
			word = Math.floor(maybe.word);
		}
	}
	line = Math.max(0, Math.min(maxLine, line));
	const wordCount = lines[line]?.words.length ?? 0;
	word = Math.max(0, Math.min(wordCount, word));
	return { line, word };
}

function normalizeSelection(value: unknown, lines: InkLine[]): InkSelection | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const maybe = value as Partial<InkSelection>;
	if (!maybe.anchor || !maybe.focus) {
		return null;
	}
	return {
		anchor: clampCursor(maybe.anchor, lines),
		focus: clampCursor(maybe.focus, lines),
	};
}

export function cursorsEqual(a: InkCursor, b: InkCursor): boolean {
	return a.line === b.line && a.word === b.word;
}

// Orders two cursors; returns [start, end] with start <= end in document order.
export function orderCursors(a: InkCursor, b: InkCursor): [InkCursor, InkCursor] {
	if (a.line < b.line || (a.line === b.line && a.word <= b.word)) {
		return [a, b];
	}
	return [b, a];
}

export function selectionIsEmpty(sel: InkSelection | null): boolean {
	return !sel || cursorsEqual(sel.anchor, sel.focus);
}
