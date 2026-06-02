import { InkDocument, InkStroke, INK_WRAP_WORLD_WIDTH } from './model';

export interface InlineRenderMetrics {
	cssHeight: number;
	worldWidth: number;
	worldHeight: number;
}

const INLINE_MIN_HEIGHT = 140;
const INLINE_WRAP_MARGIN_X = 16;

interface StrokePlacement {
	wrapIndex: number;
	xOffset: number;
}

export function resizeCanvasForDpr(
	canvas: HTMLCanvasElement,
	cssWidth: number,
	cssHeight: number,
	setCssSize = true,
): void {
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	const nextWidth = Math.max(1, Math.floor(cssWidth * dpr));
	const nextHeight = Math.max(1, Math.floor(cssHeight * dpr));

	if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
		canvas.width = nextWidth;
		canvas.height = nextHeight;
	}

	if (setCssSize) {
		canvas.style.width = `${cssWidth}px`;
		canvas.style.height = `${cssHeight}px`;
	}
}

export function computeInlineMetrics(
	doc: InkDocument,
	cssWidth: number,
): InlineRenderMetrics {
	const bounds = getWrappedBounds(doc, INK_WRAP_WORLD_WIDTH);
	const contentWorldWidth = INK_WRAP_WORLD_WIDTH;
	const contentWorldHeight = Math.max(doc.meta.lineHeight, bounds.maxY + 50);
	const lineCount = Math.max(1, Math.ceil(contentWorldHeight / doc.meta.lineHeight));
	const uniformScale = cssWidth / contentWorldWidth;
	const scaledHeight = contentWorldHeight * uniformScale;
	const minLineHeight = lineCount * 90;
	const cssHeight = Math.max(INLINE_MIN_HEIGHT, Math.ceil(Math.max(scaledHeight, minLineHeight)));

	return {
		cssHeight,
		worldWidth: contentWorldWidth,
		worldHeight: contentWorldHeight,
	};
}

export function drawInlineCanvas(
	canvas: HTMLCanvasElement,
	doc: InkDocument,
): InlineRenderMetrics {
	const cssWidth = Math.max(280, canvas.parentElement?.clientWidth ?? canvas.clientWidth ?? 280);
	const metrics = computeInlineMetrics(doc, cssWidth);
	resizeCanvasForDpr(canvas, cssWidth, metrics.cssHeight);

	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return metrics;
	}

	const dpr = Math.max(1, window.devicePixelRatio || 1);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssWidth, metrics.cssHeight);
	ctx.fillStyle = '#fcfdff';
	ctx.fillRect(0, 0, cssWidth, metrics.cssHeight);

	const scale = cssWidth / metrics.worldWidth;
	const lineGap = doc.meta.lineHeight * scale;
	ctx.strokeStyle = '#e8ecf5';
	ctx.lineWidth = 1;
	for (let y = lineGap; y < metrics.cssHeight; y += lineGap) {
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(cssWidth, y);
		ctx.stroke();
	}

	drawWrappedInlineStrokes(ctx, doc, metrics.worldWidth, scale);
	return metrics;
}

export function drawDrawerCanvas(
	canvas: HTMLCanvasElement,
	doc: InkDocument,
	viewportX: number,
	lineOffsetY: number,
	activeStroke: InkStroke | null,
): void {
	const rect = canvas.getBoundingClientRect();
	const cssWidth = Math.floor(rect.width || canvas.clientWidth);
	const cssHeight = Math.floor(rect.height || canvas.clientHeight);
	if (cssWidth <= 0 || cssHeight <= 0) {
		return;
	}
	resizeCanvasForDpr(canvas, cssWidth, cssHeight, false);

	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return;
	}

	const dpr = Math.max(1, window.devicePixelRatio || 1);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssWidth, cssHeight);
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, cssWidth, cssHeight);

	ctx.strokeStyle = '#d4dbe8';
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(0, cssHeight - 1);
	ctx.lineTo(cssWidth, cssHeight - 1);
	ctx.stroke();

	const rightTrigger = cssWidth * 0.85;
	ctx.strokeStyle = '#f59e0b';
	ctx.setLineDash([8, 8]);
	ctx.beginPath();
	ctx.moveTo(rightTrigger, 0);
	ctx.lineTo(rightTrigger, cssHeight);
	ctx.stroke();
	ctx.setLineDash([]);

	const inLineStrokes = doc.strokes.filter((stroke) => {
		const first = stroke.points[0];
		const last = stroke.points[stroke.points.length - 1];
		if (!first || !last) {
			return false;
		}
		const minY = Math.min(first.y, last.y);
		const maxY = Math.max(first.y, last.y);
		const top = lineOffsetY - 24;
		const bottom = lineOffsetY + cssHeight + 24;
		return maxY >= top && minY <= bottom;
	});

	drawStrokes(ctx, inLineStrokes, (x, y) => ({
		x: x - viewportX,
		y: y - lineOffsetY,
	}));

	if (activeStroke) {
		drawStrokes(ctx, [activeStroke], (x, y) => ({
			x: x - viewportX,
			y: y - lineOffsetY,
		}));
	}
}

function getWrappedBounds(
	doc: InkDocument,
	wrapWidth: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
	let minX = 0;
	let maxX = 0;
	let minY = 0;
	let maxY = 0;
	let hasPoint = false;

	for (const stroke of doc.strokes) {
		const placement = getStrokePlacement(stroke, wrapWidth);
		for (const point of stroke.points) {
			const wrapped = wrapPoint(
				point.x,
				point.y,
				wrapWidth,
				doc.meta.lineHeight,
				placement,
			);
			if (!hasPoint) {
				minX = wrapped.x;
				maxX = wrapped.x;
				minY = wrapped.y;
				maxY = wrapped.y;
				hasPoint = true;
				continue;
			}
			if (wrapped.x < minX) minX = wrapped.x;
			if (wrapped.x > maxX) maxX = wrapped.x;
			if (wrapped.y < minY) minY = wrapped.y;
			if (wrapped.y > maxY) maxY = wrapped.y;
		}
	}

	if (!hasPoint) {
		return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	}

	return { minX, maxX, minY, maxY };
}

function drawWrappedInlineStrokes(
	ctx: CanvasRenderingContext2D,
	doc: InkDocument,
	wrapWidth: number,
	scale: number,
): void {
	for (const stroke of doc.strokes) {
		if (!stroke.points.length) {
			continue;
		}

		const placement = getStrokePlacement(stroke, wrapWidth);
		const points: Array<{ x: number; y: number }> = [];

		for (const point of stroke.points) {
			const wrapped = wrapPoint(
				point.x,
				point.y,
				wrapWidth,
				doc.meta.lineHeight,
				placement,
			);
			points.push({
				x: wrapped.x * scale,
				y: wrapped.y * scale,
			});
		}

		ctx.strokeStyle = stroke.color;
		ctx.fillStyle = stroke.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = stroke.width;
		drawSmoothSegment(ctx, points, stroke.width);
	}
}

function drawSmoothSegment(
	ctx: CanvasRenderingContext2D,
	points: Array<{ x: number; y: number }>,
	width: number,
): void {
	const first = points[0];
	if (!first) {
		return;
	}

	if (points.length === 1) {
		ctx.beginPath();
		ctx.arc(first.x, first.y, Math.max(1, width / 2), 0, Math.PI * 2);
		ctx.fill();
		return;
	}

	ctx.beginPath();
	ctx.moveTo(first.x, first.y);

	for (let i = 1; i < points.length; i += 1) {
		const prev = points[i - 1];
		const curr = points[i];
		if (!prev || !curr) {
			continue;
		}
		const midX = (prev.x + curr.x) * 0.5;
		const midY = (prev.y + curr.y) * 0.5;
		ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
	}

	const last = points[points.length - 1];
	if (last) {
		ctx.lineTo(last.x, last.y);
	}
	ctx.stroke();
}

function wrapPoint(
	x: number,
	y: number,
	wrapWidth: number,
	lineHeight: number,
	placement: StrokePlacement,
): { x: number; y: number } {
	const wrappedX = x - placement.wrapIndex * wrapWidth + placement.xOffset;
	const wrappedY = y + placement.wrapIndex * lineHeight;
	return {
		x: wrappedX,
		y: wrappedY,
	};
}

function getStrokePlacement(stroke: InkStroke, wrapWidth: number): StrokePlacement {
	const firstPoint = stroke.points[0];
	if (!firstPoint) {
		return { wrapIndex: 0, xOffset: 0 };
	}

	const baseWrapIndex = Math.floor(Math.max(0, firstPoint.x) / wrapWidth);
	let minX = firstPoint.x;
	let maxX = firstPoint.x;
	for (const point of stroke.points) {
		if (point.x < minX) {
			minX = point.x;
		}
		if (point.x > maxX) {
			maxX = point.x;
		}
	}

	const localMin = minX - baseWrapIndex * wrapWidth;
	const localMax = maxX - baseWrapIndex * wrapWidth;
	if (localMin >= 0 && localMax <= wrapWidth) {
		return {
			wrapIndex: baseWrapIndex,
			xOffset: 0,
		};
	}

	if (localMax > wrapWidth) {
		const nextWrapIndex = baseWrapIndex + 1;
		const firstLocalX = firstPoint.x - nextWrapIndex * wrapWidth;
		return {
			wrapIndex: nextWrapIndex,
			xOffset: INLINE_WRAP_MARGIN_X - firstLocalX,
		};
	}

	if (localMin < 0 && baseWrapIndex > 0) {
		const prevWrapIndex = baseWrapIndex - 1;
		const firstLocalX = firstPoint.x - prevWrapIndex * wrapWidth;
		return {
			wrapIndex: prevWrapIndex,
			xOffset: INLINE_WRAP_MARGIN_X - firstLocalX,
		};
	}

	return {
		wrapIndex: baseWrapIndex,
		xOffset: 0,
	};
}

export function drawStrokes(
	ctx: CanvasRenderingContext2D,
	strokes: InkStroke[],
	transform: (x: number, y: number) => { x: number; y: number },
): void {
	for (const stroke of strokes) {
		const first = stroke.points[0];
		if (!first) {
			continue;
		}

		ctx.strokeStyle = stroke.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = stroke.width;

		if (stroke.points.length === 1) {
			const point = transform(first.x, first.y);
			ctx.beginPath();
			ctx.arc(point.x, point.y, Math.max(1, stroke.width / 2), 0, Math.PI * 2);
			ctx.fillStyle = stroke.color;
			ctx.fill();
			continue;
		}

		ctx.beginPath();
		const p0 = transform(first.x, first.y);
		ctx.moveTo(p0.x, p0.y);

		for (let i = 1; i < stroke.points.length; i += 1) {
			const prev = stroke.points[i - 1];
			const curr = stroke.points[i];
			if (!prev || !curr) {
				continue;
			}
			const midX = (prev.x + curr.x) * 0.5;
			const midY = (prev.y + curr.y) * 0.5;
			const control = transform(prev.x, prev.y);
			const mid = transform(midX, midY);
			ctx.quadraticCurveTo(control.x, control.y, mid.x, mid.y);
		}

		const last = stroke.points[stroke.points.length - 1];
		if (last) {
			const pLast = transform(last.x, last.y);
			ctx.lineTo(pLast.x, pLast.y);
		}
		ctx.stroke();
	}
}
