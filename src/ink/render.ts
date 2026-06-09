// Rendering for the flowing-text ink model. All geometry comes from the shared layout engine
// (`layout.ts`); this module only paints. The inline (read-only) view and the drawer both use
// `drawLaidStroke`, and the inline view and click hit-testing share `inlineLayout` so they can
// never disagree.

import { InkCursor, InkDocument, InkSelection, selectionIsEmpty } from './doc';
import { LaidPoint, LayoutResult, layoutDocument } from './layout';

const INLINE_MIN_HEIGHT = 140;
const INLINE_BASE_LINE_HEIGHT_PX = 28;
const CARET_COLOR = '#2563eb';
const SELECTION_COLOR = 'rgba(37, 99, 235, 0.18)';
const WRITING_LINE_COLOR = '#e8ecf5';
const INLINE_BG = '#fcfdff';

export interface InlineRenderOptions {
	wrapWidth: number;
	wordGapScale: number;
	renderLineHeightScale: number;
	renderStrokeFillScale: number;
	showWritingLine: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
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

// Build the layout used by the inline (read-only) canvas. Shared by drawing and click
// hit-testing so the caret/selection and click targets always line up.
export function inlineLayout(
	canvas: HTMLCanvasElement,
	doc: InkDocument,
	options: InlineRenderOptions,
): { layout: LayoutResult; cssWidth: number; cssHeight: number } {
	const cssWidth = Math.max(280, canvas.parentElement?.clientWidth ?? canvas.clientWidth ?? 280);
	const contentWidth = Math.min(cssWidth, Math.max(120, options.wrapWidth));
	const targetLineHeight = clamp(INLINE_BASE_LINE_HEIGHT_PX * options.renderLineHeightScale, 10, 220);
	const layout = layoutDocument(doc, {
		contentWidthCss: contentWidth,
		targetLineHeightCss: targetLineHeight,
		sourceLineHeight: doc.meta.lineHeight,
		wordGapScale: options.wordGapScale,
		strokeFillScale: options.renderStrokeFillScale,
	});
	const cssHeight = Math.max(INLINE_MIN_HEIGHT, Math.ceil(layout.height + targetLineHeight));
	return { layout, cssWidth, cssHeight };
}

export function drawInlineCanvas(
	canvas: HTMLCanvasElement,
	doc: InkDocument,
	options: InlineRenderOptions,
	cursor: InkCursor | null,
	selection: InkSelection | null,
): void {
	const { layout, cssWidth, cssHeight } = inlineLayout(canvas, doc, options);
	resizeCanvasForDpr(canvas, cssWidth, cssHeight);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		return;
	}
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssWidth, cssHeight);
	ctx.fillStyle = INLINE_BG;
	ctx.fillRect(0, 0, cssWidth, cssHeight);

	if (options.showWritingLine) {
		ctx.strokeStyle = WRITING_LINE_COLOR;
		ctx.lineWidth = 1;
		for (let y = layout.rowHeight; y < cssHeight; y += layout.rowHeight) {
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(cssWidth, y);
			ctx.stroke();
		}
	}

	if (selection && !selectionIsEmpty(selection)) {
		ctx.fillStyle = SELECTION_COLOR;
		for (const rect of layout.rangeRects(selection)) {
			ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
		}
	}

	const widthScale = layout.cssPerSource;
	for (const word of layout.words) {
		for (const laid of word.strokes) {
			const widthPx = Math.max(1, laid.stroke.width * widthScale * (laid.stroke.bold ? 1.7 : 1));
			drawLaidStroke(ctx, laid.points, widthPx, laid.stroke.color);
		}
	}

	if (cursor) {
		const caret = layout.caretRect(cursor);
		ctx.strokeStyle = CARET_COLOR;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(caret.x, caret.y);
		ctx.lineTo(caret.x, caret.y + caret.height);
		ctx.stroke();
	}
}

// Paint a single laid-out stroke (points already in CSS px). Shared by inline + drawer.
export function drawLaidStroke(
	ctx: CanvasRenderingContext2D,
	points: LaidPoint[],
	widthPx: number,
	color: string,
): void {
	const first = points[0];
	if (!first) {
		return;
	}
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.lineWidth = widthPx;

	if (points.length === 1) {
		ctx.beginPath();
		ctx.arc(first.x, first.y, Math.max(1, widthPx / 2), 0, Math.PI * 2);
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
