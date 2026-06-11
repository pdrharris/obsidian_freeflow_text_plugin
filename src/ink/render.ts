// Rendering for the flowing-text ink model. All geometry comes from the shared layout engine
// (`layout.ts`); this module only paints. The inline (read-only) view and the drawer both use
// `drawLaidStroke`, and the inline view and click hit-testing share `inlineLayout` so they can
// never disagree.

import { InkCursor, InkDocument, InkSelection, selectionIsEmpty } from './doc';
import { LaidPoint, LaidWord, LayoutResult, layoutDocument } from './layout';

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
	velocityWidth: boolean;
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
	// Floor is low so a deliberately narrow (per-block resized) block isn't forced wider than its
	// container, which would overflow and clip; normal blocks are far wider than this anyway.
	const cssWidth = Math.max(160, canvas.parentElement?.clientWidth ?? canvas.clientWidth ?? 160);
	const contentWidth = Math.min(cssWidth, Math.max(120, options.wrapWidth));
	const targetLineHeight = clamp(INLINE_BASE_LINE_HEIGHT_PX * options.renderLineHeightScale, 10, 220);
	const layout = layoutDocument(doc, {
		contentWidthCss: contentWidth,
		targetLineHeightCss: targetLineHeight,
		sourceLineHeight: doc.meta.lineHeight,
		wordGapScale: options.wordGapScale,
		strokeFillScale: options.renderStrokeFillScale,
		velocityWidth: options.velocityWidth,
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
		// Draw one line per row at the writing baseline (same place relative to the strokes as the
		// drawer), so words sit on the line rather than floating between two lines.
		ctx.strokeStyle = WRITING_LINE_COLOR;
		ctx.lineWidth = 1;
		for (let y = layout.baselineOffset; y < cssHeight; y += layout.rowHeight) {
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
		const underline = wordUnderline(word);
		if (underline) {
			drawUnderline(
				ctx,
				underline.minX,
				underline.maxX,
				underline.baselineY,
				underline.color,
				underlineThickness(word, widthScale),
			);
		}
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
// If the points carry per-point widths (`w`, from velocity), the stroke is drawn as a series
// of width-varying segments; otherwise it's one smooth quadratic path at `widthPx`.
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

	if (points.length === 1) {
		const r = Math.max(1, (first.w ?? widthPx) / 2);
		ctx.beginPath();
		ctx.arc(first.x, first.y, r, 0, Math.PI * 2);
		ctx.fill();
		return;
	}

	const hasPerPoint = points.some((p) => typeof p.w === 'number');
	if (hasPerPoint) {
		for (let i = 1; i < points.length; i += 1) {
			const prev = points[i - 1];
			const curr = points[i];
			if (!prev || !curr) {
				continue;
			}
			ctx.lineWidth = Math.max(0.6, ((prev.w ?? widthPx) + (curr.w ?? widthPx)) / 2);
			ctx.beginPath();
			ctx.moveTo(prev.x, prev.y);
			ctx.lineTo(curr.x, curr.y);
			ctx.stroke();
		}
		return;
	}

	ctx.lineWidth = widthPx;
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

// The underline span for a laid word: the x-extent (in css px) covered by its underlined
// strokes, the baseline to sit under, and the colour to use. Null when nothing is underlined.
export function wordUnderline(
	word: LaidWord,
): { minX: number; maxX: number; baselineY: number; color: string } | null {
	let minX = Infinity;
	let maxX = -Infinity;
	let color = '#111827';
	let found = false;
	for (const laid of word.strokes) {
		if (!laid.stroke.underline) {
			continue;
		}
		found = true;
		color = laid.stroke.color;
		for (const p of laid.points) {
			if (p.x < minX) minX = p.x;
			if (p.x > maxX) maxX = p.x;
		}
	}
	if (!found || minX === Infinity) {
		return null;
	}
	return { minX, maxX, baselineY: word.baselineY, color };
}

// A hand-weight underline thickness for a word: about as heavy as a bold pen stroke, derived from
// the actual underlined strokes so it scales with the glyph size in both views.
export function underlineThickness(word: LaidWord, widthScale: number): number {
	let maxWidth = 0;
	for (const laid of word.strokes) {
		if (!laid.stroke.underline) {
			continue;
		}
		const w = laid.stroke.width * widthScale;
		if (w > maxWidth) {
			maxWidth = w;
		}
	}
	// Bold pen weight (~1.7x a normal stroke); never thinner than a visible hairline.
	return Math.max(1.5, maxWidth * 1.7);
}

// Draw an underline beneath a word span, just below the baseline, at a hand-drawn weight.
export function drawUnderline(
	ctx: CanvasRenderingContext2D,
	minX: number,
	maxX: number,
	baselineY: number,
	color: string,
	thickness: number,
): void {
	const y = baselineY + Math.max(2, thickness * 0.9);
	ctx.strokeStyle = color;
	ctx.lineWidth = Math.max(1.2, thickness);
	ctx.lineCap = 'round';
	ctx.beginPath();
	ctx.moveTo(minX, y);
	ctx.lineTo(maxX, y);
	ctx.stroke();
}
