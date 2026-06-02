export type InkTool = 'pen' | 'eraser';

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

export interface InkDocument {
	version: 1;
	meta: {
		lineHeight: number;
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
	},
	strokes: [],
};

export const INK_CODE_BLOCK_LANGUAGE = 'fii-ink';
export const INK_WRAP_WORLD_WIDTH = 900;
export const INK_BASELINE_RATIO_FROM_TOP = 2 / 3;

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

	return {
		version: 1,
		meta: {
			lineHeight,
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
