// Rendering for the flowing-text ink model. All geometry comes from the shared layout engine
// (`layout.ts`); this module only paints. The inline (read-only) view and the drawer both use
// `drawLaidStroke`, and the inline view and click hit-testing share `inlineLayout` so they can
// never disagree.

import { InkCursor, InkDocument, InkSelection, selectionIsEmpty } from './doc';
import { LaidPoint, LaidWord, LayoutResult, layoutDocument } from './layout';

const INLINE_MIN_HEIGHT = 140;
const INLINE_BASE_LINE_HEIGHT_PX = 28;
// Dot-like strokes (full stops, the dot on an i, short ticks) are drawn at a fraction of the full
// pen width so they read as small dots rather than fat blobs. Tuned by eye.
const DOT_RADIUS_SCALE = 0.6;
const CARET_COLOR = '#2563eb';
const SELECTION_COLOR = 'rgba(37, 99, 235, 0.18)';
const WRITING_LINE_COLOR = '#e8ecf5';
const INLINE_BG = '#fcfdff';

// A broad-edge "calligraphy" nib: width depends on stroke direction. `angleRad` is the pen-edge
// angle; `contrast` (0..1) is how strong the thick/thin variation is (0 = round, 1 = razor edge).
export interface StrokeNib {
	angleRad: number;
	contrast: number;
}

export interface StrokeRenderOptions {
	taper?: boolean;
	nib?: StrokeNib | null;
}

export interface InlineRenderOptions {
	wrapWidth: number;
	wordGapScale: number;
	renderLineHeightScale: number;
	renderStrokeFillScale: number;
	showWritingLine: boolean;
	velocityWidth: boolean;
	pressureWidth: boolean;
	taperStrokeEnds: boolean;
	strokeWeight: number;
	nib: StrokeNib | null;
	smoothing: number;
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
		pressureWidth: options.pressureWidth,
		strokeWeight: options.strokeWeight,
		smoothing: options.smoothing,
	});
	// `layout.height` already spans every row exactly (one row height per line). Add only a small
	// bottom margin for descenders — NOT a whole extra row, which used to leave a blank line (and an
	// extra writing-line guide) hanging below the last line of writing.
	const cssHeight = Math.max(INLINE_MIN_HEIGHT, Math.ceil(layout.height + targetLineHeight * 0.3));
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

	for (const bullet of layout.bullets) {
		ctx.fillStyle = bullet.color;
		ctx.beginPath();
		ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
		ctx.fill();
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
			const widthPx = Math.max(
				1,
				laid.stroke.width * widthScale * (laid.stroke.bold ? 1.7 : 1) * options.strokeWeight,
			);
			drawLaidStroke(ctx, laid.points, widthPx, laid.stroke.color, {
				taper: options.taperStrokeEnds,
				nib: options.nib,
			});
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
// When the points carry per-point widths (`w`, from velocity/pressure) or `taper` is on, the stroke
// is drawn as a smooth filled outline (a ribbon) so the width varies cleanly and the ends can taper
// to a point. A plain uniform-width stroke with no taper uses the cheaper quadratic stroke path.
export function drawLaidStroke(
	ctx: CanvasRenderingContext2D,
	points: LaidPoint[],
	widthPx: number,
	color: string,
	opts: StrokeRenderOptions = {},
): void {
	const taper = opts.taper ?? false;
	const nib = opts.nib ?? null;
	const first = points[0];
	if (!first) {
		return;
	}
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';

	if (points.length === 1) {
		// A lone point is a dot (full stop, i-dot): shrink it so it doesn't read as an oversized blob.
		const r = Math.max(0.8, ((first.w ?? widthPx) / 2) * DOT_RADIUS_SCALE);
		ctx.beginPath();
		ctx.arc(first.x, first.y, r, 0, Math.PI * 2);
		ctx.fill();
		return;
	}

	const hasPerPoint = points.some((p) => typeof p.w === 'number');
	if (hasPerPoint || taper || nib) {
		drawStrokeRibbon(ctx, points, widthPx, taper, nib);
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

interface XY {
	x: number;
	y: number;
}

// Build and fill a variable-width ribbon for a stroke: offset the centreline left/right by the
// per-point radius along the local normal, then fill the smooth closed outline. Optionally taper
// the radius to ~0 at both ends. This gives smooth position AND smooth width in one pass, which the
// old per-segment `lineTo` stroking could not (it was faceted and blunt-ended).
function drawStrokeRibbon(
	ctx: CanvasRenderingContext2D,
	points: LaidPoint[],
	widthPx: number,
	taper: boolean,
	nib: StrokeNib | null,
): void {
	const n = points.length;
	const radius: number[] = points.map((p) => Math.max(0.35, (p.w ?? widthPx) / 2));

	// Cumulative arc length + max radius, used for both the taper and the dot test.
	const arc: number[] = new Array<number>(n).fill(0);
	for (let i = 1; i < n; i += 1) {
		const a = points[i - 1];
		const b = points[i];
		arc[i] = (arc[i - 1] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0);
	}
	const total = arc[n - 1] ?? 0;
	const maxRadius = radius.reduce((m, r) => (r > m ? r : m), 0);

	// Don't taper a "dot-like" stroke (full stop, the dot on an i, a short tick): tapering both ends
	// to a point makes a tiny stroke vanish. Such strokes render at full width with round caps below.
	const isDot = total < Math.max(12, maxRadius * 4);
	const effectiveTaper = taper && !isDot;

	// Shrink a dot-like stroke so it renders as a small dot rather than a fat blob (it keeps its
	// round caps below since taper is skipped for dots).
	if (isDot) {
		for (let i = 0; i < n; i += 1) {
			radius[i] = (radius[i] ?? 0) * DOT_RADIUS_SCALE;
		}
	}

	if (effectiveTaper) {
		// Taper along arc length so it's independent of how densely the stroke was sampled.
		let taperDist = clamp(maxRadius * 2.4, 3, 16);
		if (total < taperDist * 2) {
			taperDist = total / 2; // short stroke: keep a symmetric, gentle taper
		}
		if (taperDist > 0) {
			for (let i = 0; i < n; i += 1) {
				const d = Math.min(arc[i] ?? 0, total - (arc[i] ?? 0));
				radius[i] = (radius[i] ?? 0) * Math.sqrt(clamp(d / taperDist, 0, 1));
			}
		}
	}

	// Optional calligraphy nib: scale each point's radius by how perpendicular the stroke runs to a
	// fixed pen-edge direction (thin when moving along the edge, full across it).
	const nibX = nib ? Math.cos(nib.angleRad) : 0;
	const nibY = nib ? Math.sin(nib.angleRad) : 0;
	let prevNibFactor = 1;

	// Per-point unit normals from the local tangent (central difference).
	const left: XY[] = new Array<XY>(n);
	const right: XY[] = new Array<XY>(n);
	let normalX = 0;
	let normalY = -1;
	for (let i = 0; i < n; i += 1) {
		const prev = points[Math.max(0, i - 1)];
		const next = points[Math.min(n - 1, i + 1)];
		const cur = points[i];
		if (!prev || !next || !cur) {
			continue;
		}
		const tx = next.x - prev.x;
		const ty = next.y - prev.y;
		const len = Math.hypot(tx, ty);
		if (len > 1e-4) {
			normalX = -ty / len;
			normalY = tx / len;
		}
		let nibFactor = prevNibFactor;
		if (nib && len > 1e-4) {
			const crossMag = Math.abs((tx / len) * nibY - (ty / len) * nibX);
			nibFactor = 1 - nib.contrast * (1 - crossMag);
			prevNibFactor = nibFactor;
		}
		const r = (radius[i] ?? 0) * nibFactor;
		left[i] = { x: cur.x + normalX * r, y: cur.y + normalY * r };
		right[i] = { x: cur.x - normalX * r, y: cur.y - normalY * r };
	}

	ctx.beginPath();
	traceSmooth(ctx, left, true);
	traceSmooth(ctx, right.slice().reverse(), false);
	ctx.closePath();
	ctx.fill();

	// Round caps/joints: a dot at each end keeps blunt ends round when not tapered (a no-op when
	// tapered, where the end radius is ~0). Also gives dot-like strokes a proper round shape.
	if (!effectiveTaper) {
		const ends = [
			{ p: points[0], r: radius[0] },
			{ p: points[n - 1], r: radius[n - 1] },
		];
		for (const end of ends) {
			if (end.p && end.r && end.r > 0.35) {
				ctx.beginPath();
				ctx.arc(end.p.x, end.p.y, end.r, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}
}

// Trace a polyline as a smooth quadratic path (through segment midpoints), either starting a new
// subpath (moveTo) or continuing the current one (lineTo to the first point).
function traceSmooth(ctx: CanvasRenderingContext2D, poly: XY[], startNew: boolean): void {
	const first = poly[0];
	if (!first) {
		return;
	}
	if (startNew) {
		ctx.moveTo(first.x, first.y);
	} else {
		ctx.lineTo(first.x, first.y);
	}
	for (let i = 1; i < poly.length; i += 1) {
		const prev = poly[i - 1];
		const cur = poly[i];
		if (!prev || !cur) {
			continue;
		}
		ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + cur.x) * 0.5, (prev.y + cur.y) * 0.5);
	}
	const last = poly[poly.length - 1];
	if (last) {
		ctx.lineTo(last.x, last.y);
	}
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
