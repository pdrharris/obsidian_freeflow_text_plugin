export type InkTool = 'pen' | 'eraser';
export type InkCursorLinePreference = 'auto' | 'prev' | 'next';

export interface InkPoint {
	x: number;
	y: number;
	pressure: number;
	time: number;
}

export interface InkStroke {
	id: string;
	tool: 'pen';
	width: number;
	color: string;
	points: InkPoint[];
}

export interface InkCanonicalCursor {
	index: number;
	linePreference: InkCursorLinePreference;
	updatedAt: number;
}

export interface InkLineBreakInsertOperation {
	type: 'line-break-insert';
	markerStrokeId: string;
	createdAt: number;
	anchorIndexBefore: number;
	cursorAfter: InkCanonicalCursor;
}

export type InkStructuralOperation = InkLineBreakInsertOperation;

export interface InkDocument {
	version: 1;
	meta: {
		lineHeight: number;
		// Canonical cursor state shared by drawer and renderer paths.
		cursor: InkCanonicalCursor;
		// Last structural operation enables deterministic erase semantics.
		lastStructuralOp: InkStructuralOperation | null;
	};
	strokes: InkStroke[];
}

export interface InkViewport {
	viewportX: number;
	lineOffsetY: number;
}

export const DEFAULT_INK_DOCUMENT: InkDocument = {
	version: 1,
	meta: {
		lineHeight: 180,
		cursor: {
			index: 0,
			linePreference: 'auto',
			updatedAt: 0,
		},
		lastStructuralOp: null,
	},
	strokes: [],
};

export const INK_CODE_BLOCK_LANGUAGE = 'fii-ink';
export const INK_WRAP_WORLD_WIDTH = 900;
export const INK_BASELINE_RATIO_FROM_TOP = 2 / 3;
export const INK_LINE_BREAK_MARKER_PREFIX = 'ff-nl-';

function normalizeCursorLinePreference(value: unknown): InkCursorLinePreference {
	return value === 'prev' || value === 'next' ? value : 'auto';
}

function clampCursorIndex(value: unknown, length: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return Math.max(0, Math.min(length, fallback));
	}
	return Math.max(0, Math.min(length, Math.floor(value)));
}

function normalizeCanonicalCursor(
	value: unknown,
	strokeCount: number,
	fallbackIndex: number,
): InkCanonicalCursor {
	const fallback: InkCanonicalCursor = {
		index: clampCursorIndex(fallbackIndex, strokeCount, strokeCount),
		linePreference: 'auto',
		updatedAt: 0,
	};
	if (!value || typeof value !== 'object') {
		return fallback;
	}
	const maybe = value as Partial<InkCanonicalCursor>;
	return {
		index: clampCursorIndex(maybe.index, strokeCount, fallback.index),
		linePreference: normalizeCursorLinePreference(maybe.linePreference),
		updatedAt:
			typeof maybe.updatedAt === 'number' && Number.isFinite(maybe.updatedAt)
				? maybe.updatedAt
				: fallback.updatedAt,
	};
}

function normalizeStructuralOperation(value: unknown, strokeCount: number): InkStructuralOperation | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const maybe = value as Partial<InkLineBreakInsertOperation>;
	if (maybe.type !== 'line-break-insert' || typeof maybe.markerStrokeId !== 'string') {
		return null;
	}
	const fallbackCursor = normalizeCanonicalCursor(undefined, strokeCount, strokeCount);
	const cursorAfter = normalizeCanonicalCursor(maybe.cursorAfter, strokeCount, fallbackCursor.index);
	return {
		type: 'line-break-insert',
		markerStrokeId: maybe.markerStrokeId,
		createdAt:
			typeof maybe.createdAt === 'number' && Number.isFinite(maybe.createdAt)
				? maybe.createdAt
				: 0,
		anchorIndexBefore: clampCursorIndex(maybe.anchorIndexBefore, strokeCount, cursorAfter.index),
		cursorAfter,
	};
}

export function isLineBreakMarkerStroke(stroke: InkStroke): boolean {
	return stroke.id.startsWith(INK_LINE_BREAK_MARKER_PREFIX);
}

export function parseInkDocument(source: string): InkDocument {
	if (!source.trim()) {
		return structuredClone(DEFAULT_INK_DOCUMENT);
	}

	const value = JSON.parse(source) as Partial<InkDocument>;
	if (value.version !== 1 || !Array.isArray(value.strokes)) {
		throw new Error('Invalid fii-ink JSON: expected { version: 1, strokes: [] }.');
	}

	const lineHeight =
		typeof value.meta?.lineHeight === 'number' && value.meta.lineHeight >= 80
			? value.meta.lineHeight
			: DEFAULT_INK_DOCUMENT.meta.lineHeight;

	const strokes: InkStroke[] = value.strokes
		.map((stroke, index) => {
			if (!stroke || !Array.isArray(stroke.points)) {
				return null;
			}

			const points: InkPoint[] = stroke.points
				.map((point) => {
					if (!point) {
						return null;
					}
					const x = Number(point.x);
					const y = Number(point.y);
					if (!Number.isFinite(x) || !Number.isFinite(y)) {
						return null;
					}
					return {
						x,
						y,
						pressure:
							typeof point.pressure === 'number' && Number.isFinite(point.pressure)
								? point.pressure
								: 0.5,
						time:
							typeof point.time === 'number' && Number.isFinite(point.time)
								? point.time
								: Date.now(),
					};
				})
				.filter((point): point is InkPoint => point !== null);

			if (!points.length) {
				return null;
			}

			return {
				id:
					typeof stroke.id === 'string' && stroke.id.length > 0
						? stroke.id
						: `stroke-${index}`,
				tool: 'pen',
				width:
					typeof stroke.width === 'number' && Number.isFinite(stroke.width)
						? Math.max(1, stroke.width)
						: 3,
				color: typeof stroke.color === 'string' ? stroke.color : '#111827',
				points,
			};
		})
		.filter((stroke): stroke is InkStroke => stroke !== null);

	const cursor = normalizeCanonicalCursor(value.meta?.cursor, strokes.length, strokes.length);
	const lastStructuralOp = normalizeStructuralOperation(value.meta?.lastStructuralOp, strokes.length);

	return {
		version: 1,
		meta: {
			lineHeight,
			cursor,
			lastStructuralOp,
		},
		strokes,
	};
}

export function serializeInkDocument(doc: InkDocument): string {
	return JSON.stringify(doc);
}

export function createStrokeId(): string {
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getInkBounds(doc: InkDocument): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
} {
	let minX = 0;
	let maxX = 0;
	let minY = 0;
	let maxY = 0;
	let hasPoint = false;

	for (const stroke of doc.strokes) {
		for (const point of stroke.points) {
			if (!hasPoint) {
				minX = point.x;
				maxX = point.x;
				minY = point.y;
				maxY = point.y;
				hasPoint = true;
				continue;
			}
			if (point.x < minX) minX = point.x;
			if (point.x > maxX) maxX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.y > maxY) maxY = point.y;
		}
	}

	if (!hasPoint) {
		return {
			minX: 0,
			maxX: 0,
			minY: 0,
			maxY: 0,
		};
	}

	return { minX, maxX, minY, maxY };
}

export function eraserHitTest(stroke: InkStroke, x: number, y: number, radius: number): boolean {
	const radiusSq = radius * radius;
	for (const point of stroke.points) {
		const dx = point.x - x;
		const dy = point.y - y;
		if (dx * dx + dy * dy <= radiusSq) {
			return true;
		}
	}
	return false;
}
