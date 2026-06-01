import { InkDocument, InkStroke, getInkBounds } from './model';

export interface InlineRenderMetrics {
	cssHeight: number;
	worldWidth: number;
	worldHeight: number;
}

const INLINE_MIN_HEIGHT = 140;
const INLINE_BASE_WORLD_WIDTH = 900;

export function resizeCanvasForDpr(
	canvas: HTMLCanvasElement,
	cssWidth: number,
	cssHeight: number,
): void {
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	const nextWidth = Math.max(1, Math.floor(cssWidth * dpr));
	const nextHeight = Math.max(1, Math.floor(cssHeight * dpr));

	if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
		canvas.width = nextWidth;
		canvas.height = nextHeight;
	}

	canvas.style.width = `${cssWidth}px`;
	canvas.style.height = `${cssHeight}px`;
}

export function computeInlineMetrics(
	doc: InkDocument,
	cssWidth: number,
): InlineRenderMetrics {
	const bounds = getInkBounds(doc);
	const contentWorldWidth = Math.max(INLINE_BASE_WORLD_WIDTH, bounds.maxX + 50);
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

	drawStrokes(ctx, doc.strokes, (x, y) => ({ x: x * scale, y: y * scale }));
	return metrics;
}

export function drawDrawerCanvas(
	canvas: HTMLCanvasElement,
	doc: InkDocument,
	viewportX: number,
	lineOffsetY: number,
	activeStroke: InkStroke | null,
): void {
	const cssWidth = Math.max(300, canvas.clientWidth || canvas.parentElement?.clientWidth || 300);
	const cssHeight = Math.max(140, canvas.clientHeight || 220);
	resizeCanvasForDpr(canvas, cssWidth, cssHeight);

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
