import {
	InkDocument,
	InkStroke,
	INK_BASELINE_RATIO_FROM_TOP,
	isLineBreakMarkerStroke,
} from './model';

export interface InlineRenderMetrics {
cssHeight: number;
worldWidth: number;
worldHeight: number;
scale: number;
lineWorldScale: number;
}

const INLINE_MIN_HEIGHT = 140;
const INLINE_WRAP_MARGIN_X = 16;
const INLINE_TARGET_LINE_HEIGHT_PX = 28;
const INLINE_FALLBACK_SOURCE_HEIGHT_RATIO = 0.28;

interface StrokeInfo {
stroke: InkStroke;
index: number;
minX: number;
maxX: number;
minY: number;
maxY: number;
rowIndex: number;
}

interface WordInfo {
strokes: StrokeInfo[];
minX: number;
maxX: number;
gapFromPrev: number;
}

interface PlacedWord extends WordInfo {
localLine: number;
xShift: number;
}

interface StrokePlacement {
xOffset: number;
rowIndex: number;
outputRow: number;
}

interface InlineLayout {
effectiveLineHeight: number;
baselineOffset: number;
strokePoints: Map<InkStroke, Array<{ x: number; y: number }>>;
minX: number;
maxX: number;
minY: number;
maxY: number;
}

export type InsertionLinePreference = 'auto' | 'prev' | 'next';

export interface InlineInsertionSelection {
	index: number;
	linePreference: InsertionLinePreference;
}

interface InsertionBoundary {
index: number;
x: number;
y: number;
	linePreference: InsertionLinePreference;
}

interface InlineCaretMarker {
x: number;
y: number;
height: number;
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
wrapWidth: number,
wordGapScale: number,
renderLineHeightScale: number,
renderStrokeFillScale: number,
): InlineRenderMetrics {
const lineSpacingScale = Math.max(0.1, renderLineHeightScale);
const viewportLayout = resolveInlineViewportLayout(doc, cssWidth, wrapWidth, lineSpacingScale);
const layout = layoutInlineStrokes(
	doc,
	viewportLayout.worldWidth,
	wordGapScale,
	viewportLayout.lineWorldScale,
	renderStrokeFillScale,
);
const contentWorldHeight = Math.max(layout.effectiveLineHeight, layout.maxY + 24);
const lineCount = Math.max(1, Math.ceil(contentWorldHeight / layout.effectiveLineHeight));
const scaledHeight = contentWorldHeight * viewportLayout.scale;
const minLineHeight =
	lineCount * Math.max(8, Math.round(INLINE_TARGET_LINE_HEIGHT_PX * lineSpacingScale));
const cssHeight = Math.max(INLINE_MIN_HEIGHT, Math.ceil(Math.max(scaledHeight, minLineHeight)));

return {
cssHeight,
worldWidth: viewportLayout.worldWidth,
worldHeight: contentWorldHeight,
scale: viewportLayout.scale,
	lineWorldScale: viewportLayout.lineWorldScale,
};
}

export function findInlineInsertionIndex(
doc: InkDocument,
wrapWidth: number,
wordGapScale: number,
renderLineHeightScale: number,
renderStrokeFillScale: number,
cssWidth: number,
clickCssX: number,
clickCssY: number,
): number {
const selection = findInlineInsertionSelection(
	doc,
	wrapWidth,
	wordGapScale,
	renderLineHeightScale,
	renderStrokeFillScale,
	cssWidth,
	clickCssX,
	clickCssY,
);
return selection.index;
}

export function findInlineInsertionSelection(
	doc: InkDocument,
	wrapWidth: number,
	wordGapScale: number,
	renderLineHeightScale: number,
	renderStrokeFillScale: number,
	cssWidth: number,
	clickCssX: number,
	clickCssY: number,
): InlineInsertionSelection {
if (doc.strokes.length === 0) {
	return {
		index: 0,
		linePreference: 'auto',
	};
}

const lineSpacingScale = Math.max(0.1, renderLineHeightScale);
const viewportLayout = resolveInlineViewportLayout(doc, cssWidth, wrapWidth, lineSpacingScale);
const layout = layoutInlineStrokes(
	doc,
	viewportLayout.worldWidth,
	wordGapScale,
	viewportLayout.lineWorldScale,
	renderStrokeFillScale,
);
const scale = viewportLayout.scale;
const clickWorldX = clickCssX / scale;
const clickWorldY = clickCssY / scale;

const boundaries = buildInsertionBoundaries(
doc,
layout.strokePoints,
layout.effectiveLineHeight,
);
if (boundaries.length === 0) {
	return {
		index: doc.strokes.length,
		linePreference: 'auto',
	};
}
const bestBoundary = resolveInsertionBoundaryFromClick(
boundaries,
clickWorldX,
clickWorldY,
layout.effectiveLineHeight,
);
	return {
		index: clamp(bestBoundary.index, 0, doc.strokes.length),
		linePreference: bestBoundary.linePreference,
	};
}

export function drawInlineCanvas(
canvas: HTMLCanvasElement,
doc: InkDocument,
wrapWidth: number,
wordGapScale: number,
renderLineHeightScale: number,
renderStrokeFillScale: number,
showWritingLine: boolean,
insertionIndex: number | null = null,
linePreference: InsertionLinePreference = 'auto',
): InlineRenderMetrics {
const cssWidth = Math.max(280, canvas.parentElement?.clientWidth ?? canvas.clientWidth ?? 280);
const metrics = computeInlineMetrics(
	doc,
	cssWidth,
	wrapWidth,
	wordGapScale,
	renderLineHeightScale,
	renderStrokeFillScale,
);
const layout = layoutInlineStrokes(
	doc,
	metrics.worldWidth,
	wordGapScale,
	metrics.lineWorldScale,
	renderStrokeFillScale,
);
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

const scale = metrics.scale;
if (showWritingLine) {
ctx.strokeStyle = '#e8ecf5';
ctx.lineWidth = 1;
for (
let baselineY = layout.baselineOffset * scale;
baselineY < metrics.cssHeight;
baselineY += layout.effectiveLineHeight * scale
) {
ctx.beginPath();
ctx.moveTo(0, baselineY);
ctx.lineTo(cssWidth, baselineY);
ctx.stroke();
}
}

drawWrappedInlineStrokes(ctx, doc, layout.strokePoints, scale);
if (typeof insertionIndex === 'number' && Number.isFinite(insertionIndex)) {
	const marker = getInlineCaretMarker(doc, layout, insertionIndex, linePreference);
if (marker) {
const caretX = marker.x * scale;
const caretY = marker.y * scale;
const caretHeight = marker.height * scale;
ctx.strokeStyle = '#2563eb';
ctx.lineWidth = 2;
ctx.beginPath();
ctx.moveTo(caretX, caretY - caretHeight * 0.5);
ctx.lineTo(caretX, caretY + caretHeight * 0.5);
ctx.stroke();
}
}
return metrics;
}


export function drawDrawerCanvas(
canvas: HTMLCanvasElement,
doc: InkDocument,
viewportX: number,
lineOffsetY: number,
cursorIndex: number,
activeStroke: InkStroke | null,
showWritingLine: boolean,
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

const baselineLocalY = getBaselineLocalY(cssHeight);
if (showWritingLine) {
ctx.strokeStyle = '#a5b4c6';
ctx.lineWidth = 1.2;
ctx.beginPath();
ctx.moveTo(0, baselineLocalY);
ctx.lineTo(cssWidth, baselineLocalY);
ctx.stroke();
}

const rightTrigger = cssWidth * 0.85;
ctx.strokeStyle = '#f59e0b';
ctx.setLineDash([8, 8]);
ctx.beginPath();
ctx.moveTo(rightTrigger, 0);
ctx.lineTo(rightTrigger, cssHeight);
ctx.stroke();
ctx.setLineDash([]);

const clampedCursorIndex = clamp(cursorIndex, 0, doc.strokes.length);
const visibleStrokes = doc.strokes.slice(0, clampedCursorIndex);
	const inLineStrokes = visibleStrokes.filter((stroke) => {
		if (isLineBreakMarkerStroke(stroke)) {
			return false;
		}
const first = stroke.points[0];
const last = stroke.points[stroke.points.length - 1];
if (!first || !last) {
return false;
}
const minY = Math.min(first.y, last.y);
const maxY = Math.max(first.y, last.y);
const top = lineOffsetY - baselineLocalY - 24;
const bottom = lineOffsetY + (cssHeight - baselineLocalY) + 24;
return maxY >= top && minY <= bottom;
});

drawStrokes(ctx, inLineStrokes, (x, y) => ({
x: x - viewportX,
y: y - lineOffsetY + baselineLocalY,
}));

if (activeStroke) {
drawStrokes(ctx, [activeStroke], (x, y) => ({
x: x - viewportX,
y: y - lineOffsetY + baselineLocalY,
}));
}
}

function getBaselineLocalY(cssHeight: number): number {
return cssHeight * INK_BASELINE_RATIO_FROM_TOP;
}

function layoutInlineStrokes(
doc: InkDocument,
wrapWidth: number,
wordGapScale: number,
lineWorldScale: number,
renderStrokeFillScale: number,
): InlineLayout {
const lineHeight = Math.max(80, doc.meta.lineHeight);
const normalizedLineWorldScale = Math.max(0.02, lineWorldScale);
const strokeFillScale = Math.max(0.4, Math.min(1.6, renderStrokeFillScale));
const strokeInfos = doc.strokes
.map((stroke, index) => toStrokeInfo(stroke, index, lineHeight))
.filter((item): item is StrokeInfo => item !== null);
const sourceStrokeHeightRatio = estimateSourceStrokeHeightRatio(strokeInfos, lineHeight);
const glyphScale = (normalizedLineWorldScale * strokeFillScale) / sourceStrokeHeightRatio;

const effectiveLineHeight = Math.max(8, lineHeight * normalizedLineWorldScale);
const baselineOffset = effectiveLineHeight * INK_BASELINE_RATIO_FROM_TOP;

const rows = new Map<number, StrokeInfo[]>();
for (const info of strokeInfos) {
const rowItems = rows.get(info.rowIndex);
if (rowItems) {
rowItems.push(info);
} else {
rows.set(info.rowIndex, [info]);
}
}

const sortedRowIndexes = [...rows.keys()].sort((a, b) => a - b);
const placements = new Map<InkStroke, StrokePlacement>();
let runningOutputRow = 0;
let previousRowIndex: number | null = null;

for (const rowIndex of sortedRowIndexes) {
const rowInfos = rows.get(rowIndex);
if (!rowInfos || rowInfos.length === 0) {
continue;
}
rowInfos.sort((a, b) => a.index - b.index);

if (previousRowIndex !== null && rowIndex > previousRowIndex + 1) {
runningOutputRow += rowIndex - previousRowIndex - 1;
}
previousRowIndex = rowIndex;

	const words = buildWordsForRow(rowInfos, lineHeight, wordGapScale);
	const placementWrapWidth = Math.max(80, wrapWidth / glyphScale);
	const placedWords = placeWordsInRow(words, placementWrapWidth, lineHeight, wordGapScale);
const rowLineCount =
placedWords.length > 0
? Math.max(...placedWords.map((word) => word.localLine)) + 1
: 1;

for (const word of placedWords) {
const outputRow = runningOutputRow + word.localLine;
for (const info of word.strokes) {
placements.set(info.stroke, {
xOffset: word.xShift,
rowIndex,
outputRow,
});
}
}

runningOutputRow += rowLineCount;
}

const strokePoints = new Map<InkStroke, Array<{ x: number; y: number }>>();
let minX = 0;
let maxX = 0;
let minY = 0;
let maxY = 0;
let hasPoint = false;

for (const stroke of doc.strokes) {
const placement = placements.get(stroke);
if (!placement) {
continue;
}

const points = stroke.points.map((point) => {
const localY = (point.y - placement.rowIndex * lineHeight) * glyphScale;
			const shiftedX = point.x + placement.xOffset;
return {
x: INLINE_WRAP_MARGIN_X + (shiftedX - INLINE_WRAP_MARGIN_X) * glyphScale,
y: placement.outputRow * effectiveLineHeight + baselineOffset + localY,
};
});
strokePoints.set(stroke, points);

for (const point of points) {
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
minX = 0;
maxX = 0;
minY = 0;
maxY = 0;
}

return {
effectiveLineHeight,
baselineOffset,
strokePoints,
minX,
maxX,
minY,
maxY,
};
}

function resolveInlineViewportLayout(
	doc: InkDocument,
	cssWidth: number,
	wrapWidth: number,
	lineSpacingScale: number,
): { worldWidth: number; scale: number; lineWorldScale: number } {
	const sourceLineHeight = Math.max(80, doc.meta.lineHeight);
	const normalizedLineSpacing = Math.max(0.1, lineSpacingScale);
	const targetCssLineHeight = Math.max(8, INLINE_TARGET_LINE_HEIGHT_PX * normalizedLineSpacing);
	const worldWidth = Math.max(220, wrapWidth);
	const safeCssWidth = Math.max(1, cssWidth);
	const scale = safeCssWidth / worldWidth;
	const lineWorldScale = clamp(targetCssLineHeight / Math.max(1, sourceLineHeight * scale), 0.02, 6);
	return {
		worldWidth,
		scale,
		lineWorldScale,
	};
}

function estimateSourceStrokeHeightRatio(strokeInfos: StrokeInfo[], lineHeight: number): number {
	const measurableRatios = strokeInfos
		.filter((info) => !isLineBreakMarkerStroke(info.stroke))
		.map((info) => Math.max(1, info.maxY - info.minY) / Math.max(1, lineHeight))
		.filter((ratio) => Number.isFinite(ratio) && ratio > 0);
	if (measurableRatios.length < 10) {
		return INLINE_FALLBACK_SOURCE_HEIGHT_RATIO;
	}
	measurableRatios.sort((a, b) => a - b);
	const p90Index = Math.min(
		measurableRatios.length - 1,
		Math.max(0, Math.floor((measurableRatios.length - 1) * 0.9)),
	);
	const sampledRatio = measurableRatios[p90Index] ?? INLINE_FALLBACK_SOURCE_HEIGHT_RATIO;
	const blendedRatio = sampledRatio * 0.6 + INLINE_FALLBACK_SOURCE_HEIGHT_RATIO * 0.4;
	return clamp(Math.max(INLINE_FALLBACK_SOURCE_HEIGHT_RATIO, blendedRatio), 0.2, 0.75);
}

function buildInsertionBoundaries(
doc: InkDocument,
strokePoints: Map<InkStroke, Array<{ x: number; y: number }>>,
effectiveLineHeight: number,
): InsertionBoundary[] {
	const lineStartX = INLINE_WRAP_MARGIN_X;
	const strokeAnchors = doc.strokes.map((stroke) => {
		if (isLineBreakMarkerStroke(stroke)) {
			const markerPoints = strokePoints.get(stroke);
			const markerY = markerPoints?.[0]?.y;
			if (typeof markerY !== 'number' || !Number.isFinite(markerY)) {
				return null;
			}
			return {
				leftX: lineStartX,
				rightX: lineStartX,
				centerY: markerY,
			};
		}
const points = strokePoints.get(stroke);
if (!points || points.length === 0) {
return null;
}

		let minX = points[0]?.x ?? 0;
		let maxX = points[0]?.x ?? 0;
		let minY = points[0]?.y ?? 0;
		let maxY = points[0]?.y ?? 0;
		for (const point of points) {
			if (point.x < minX) minX = point.x;
			if (point.x > maxX) maxX = point.x;
			if (point.y < minY) minY = point.y;
			if (point.y > maxY) maxY = point.y;
		}

		return {
			leftX: minX,
			rightX: maxX,
			centerY: (minY + maxY) * 0.5,
		};
});

	const getPrevAnchor = (
		from: number,
	): { leftX: number; rightX: number; centerY: number } | null => {
for (let index = from; index >= 0; index -= 1) {
			const value = strokeAnchors[index];
if (value) {
return value;
}
}
return null;
};

	const getNextAnchor = (
		from: number,
	): { leftX: number; rightX: number; centerY: number } | null => {
		for (let index = from; index < strokeAnchors.length; index += 1) {
			const value = strokeAnchors[index];
if (value) {
return value;
}
}
return null;
};

	const boundaries: InsertionBoundary[] = [];
for (let index = 0; index <= doc.strokes.length; index += 1) {
		const prevAnchor = getPrevAnchor(index - 1);
		const nextAnchor = getNextAnchor(index);

		if (prevAnchor && nextAnchor) {
				const isSameVerticalBand =
					Math.abs(nextAnchor.centerY - prevAnchor.centerY) <= effectiveLineHeight * 0.6;
				const clearlyWrappedToNextLine =
					nextAnchor.leftX <= prevAnchor.rightX - Math.max(6, effectiveLineHeight * 0.2);
				const isSameLine = isSameVerticalBand && !clearlyWrappedToNextLine;
if (isSameLine) {
				const desiredX = (prevAnchor.rightX + nextAnchor.leftX) * 0.5;
				const minX = prevAnchor.rightX + 4;
				const maxX = nextAnchor.leftX - 4;
				const resolvedX =
					maxX >= minX
						? clamp(desiredX, minX, maxX)
						: desiredX;
				boundaries.push({
					index,
					x: Math.max(0, resolvedX),
					y: (prevAnchor.centerY + nextAnchor.centerY) * 0.5,
					linePreference: 'auto',
				});
			} else {
				const prevLinePadding = Math.max(6, effectiveLineHeight * 0.18);
				boundaries.push({
					index,
					x: prevAnchor.rightX + prevLinePadding,
					y: prevAnchor.centerY,
					linePreference: 'prev',
				});
				boundaries.push({
					index,
					x: lineStartX,
					y: nextAnchor.centerY,
					linePreference: 'next',
				});
}
continue;
}

		if (nextAnchor) {
boundaries.push({
index,
				x: lineStartX,
				y: nextAnchor.centerY,
				linePreference: 'next',
});
continue;
}

		if (prevAnchor) {
				const trailingPadding = Math.max(8, effectiveLineHeight * 0.22);
boundaries.push({
index,
					x: prevAnchor.rightX + trailingPadding,
				y: prevAnchor.centerY,
				linePreference: 'prev',
});
continue;
}

boundaries.push({ index: 0, x: 0, y: 0, linePreference: 'auto' });
}

return boundaries;
}

function resolveInsertionBoundaryFromClick(
boundaries: InsertionBoundary[],
clickWorldX: number,
clickWorldY: number,
effectiveLineHeight: number,
): InsertionBoundary {
const firstBoundary = boundaries[0];
if (!firstBoundary) {
	return {
		index: 0,
		x: 0,
		y: 0,
		linePreference: 'auto',
	};
}
	const verticalWindow = Math.max(6, effectiveLineHeight * 0.72);
	const nearbyRows = boundaries.filter(
		(boundary) => Math.abs(clickWorldY - boundary.y) <= verticalWindow,
	);
	const candidates = nearbyRows.length > 0 ? nearbyRows : boundaries;

const firstCandidate = candidates[0];
if (!firstCandidate) {
	return firstBoundary;
}

let best = firstCandidate;
let bestScore = Number.POSITIVE_INFINITY;
for (const candidate of candidates) {
const dx = Math.abs(clickWorldX - candidate.x);
const dy = Math.abs(clickWorldY - candidate.y);
	const score = dx + dy * 0.45;
if (score < bestScore) {
bestScore = score;
best = candidate;
}
}

return best;
}

function getInlineCaretMarker(
doc: InkDocument,
layout: InlineLayout,
insertionIndex: number,
linePreference: InsertionLinePreference,
): InlineCaretMarker | null {
const clampedIndex = clamp(insertionIndex, 0, doc.strokes.length);
if (doc.strokes.length === 0) {
return {
x: INLINE_WRAP_MARGIN_X,
y: layout.baselineOffset,
height: Math.max(20, layout.effectiveLineHeight * 0.72),
};
}

const boundaries = buildInsertionBoundaries(
doc,
layout.strokePoints,
layout.effectiveLineHeight,
);
const preferredBoundary =
	linePreference === 'auto'
		? null
		: boundaries.find(
			(item) => item.index === clampedIndex && item.linePreference === linePreference,
		);
const boundary = preferredBoundary ?? boundaries.find((item) => item.index === clampedIndex);
if (!boundary) {
return null;
}

return {
x: boundary.x,
y: boundary.y,
height: Math.max(20, layout.effectiveLineHeight * 0.72),
};
}

function toStrokeInfo(stroke: InkStroke, index: number, lineHeight: number): StrokeInfo | null {
const firstPoint = stroke.points[0];
if (!firstPoint) {
return null;
}

let minX = firstPoint.x;
let maxX = firstPoint.x;
let minY = firstPoint.y;
let maxY = firstPoint.y;
for (const point of stroke.points) {
if (point.x < minX) minX = point.x;
if (point.x > maxX) maxX = point.x;
if (point.y < minY) minY = point.y;
if (point.y > maxY) maxY = point.y;
}

const centerY = (minY + maxY) * 0.5;
const rowIndex = Math.max(0, Math.round(centerY / lineHeight));
return {
stroke,
index,
minX,
maxX,
minY,
maxY,
rowIndex,
};
}

function buildWordsForRow(
	rowInfos: StrokeInfo[],
	lineHeight: number,
	wordGapScale: number,
): WordInfo[] {
const firstInfo = rowInfos[0];
if (!firstInfo) {
return [];
}

const words: WordInfo[] = [];
	const gapThreshold = computeWordGapThreshold(lineHeight, wordGapScale);
let currentWord: WordInfo = {
strokes: [firstInfo],
minX: firstInfo.minX,
maxX: firstInfo.maxX,
gapFromPrev: 0,
};

for (let i = 1; i < rowInfos.length; i += 1) {
const info = rowInfos[i];
if (!info) {
continue;
}
const gap = info.minX - currentWord.maxX;
if (gap >= gapThreshold) {
words.push(currentWord);
currentWord = {
strokes: [info],
minX: info.minX,
maxX: info.maxX,
gapFromPrev: Math.max(0, gap),
};
continue;
}

currentWord.strokes.push(info);
if (info.minX < currentWord.minX) {
currentWord.minX = info.minX;
}
if (info.maxX > currentWord.maxX) {
currentWord.maxX = info.maxX;
}
}

words.push(currentWord);
return words;
}

function placeWordsInRow(
words: WordInfo[],
wrapWidth: number,
lineHeight: number,
wordGapScale: number,
): PlacedWord[] {
const placements: PlacedWord[] = [];
const availableWidth = Math.max(80, wrapWidth - INLINE_WRAP_MARGIN_X * 2);
let cursorX = 0;
let localLine = 0;

for (const word of words) {
const wordWidth = Math.max(1, word.maxX - word.minX);
let insertedGap = 0;
if (cursorX > 0) {
		insertedGap = normalizeWordGap(word.gapFromPrev, lineHeight, wordGapScale);
}

if (cursorX > 0 && cursorX + insertedGap + wordWidth > availableWidth) {
localLine += 1;
cursorX = 0;
insertedGap = 0;
}

const startX = INLINE_WRAP_MARGIN_X + cursorX + insertedGap;
cursorX += insertedGap + wordWidth;

placements.push({
...word,
localLine,
xShift: startX - word.minX,
});
}

return placements;
}

function computeWordGapThreshold(lineHeight: number, wordGapScale: number): number {
	const normalizedScale = clamp(wordGapScale, 0.8, 2.5);
	return clamp(lineHeight * 0.12 * normalizedScale, 8, 48);
}

function normalizeWordGap(
	originalGap: number,
	lineHeight: number,
	wordGapScale: number,
): number {
	const threshold = computeWordGapThreshold(lineHeight, wordGapScale);
if (originalGap < threshold) {
return 0;
}
return clamp(originalGap, threshold, threshold * 3.6);
}

function clamp(value: number, min: number, max: number): number {
if (value < min) {
return min;
}
if (value > max) {
return max;
}
return value;
}

function drawWrappedInlineStrokes(
ctx: CanvasRenderingContext2D,
doc: InkDocument,
strokePoints: Map<InkStroke, Array<{ x: number; y: number }>>,
scale: number,
): void {
for (const stroke of doc.strokes) {
		if (isLineBreakMarkerStroke(stroke)) {
			continue;
		}
const points = strokePoints.get(stroke);
if (!points || points.length === 0) {
continue;
}
const scaledPoints = points.map((point) => ({
x: point.x * scale,
y: point.y * scale,
}));

ctx.strokeStyle = stroke.color;
ctx.fillStyle = stroke.color;
ctx.lineCap = 'round';
ctx.lineJoin = 'round';
ctx.lineWidth = Math.max(1, stroke.width * scale);
drawSmoothSegment(ctx, scaledPoints, Math.max(1, stroke.width * scale));
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
