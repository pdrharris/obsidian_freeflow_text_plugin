// Headless tests for the pure logic of the flowing-text ink model: doc, edit, layout.
// These modules have no DOM/Obsidian dependencies, so they run in plain Node (bundled by
// esbuild via `npm test`). They lock down parse/serialize, the editing splices, and layout
// hit-testing so they cannot regress as selection/copy-paste are added.

import {
	INK_DOC_VERSION,
	InkDocument,
	InkPoint,
	InkStroke,
	InkWord,
	clampCursor,
	createEmptyDocument,
	orderCursors,
	parseInkDocument,
	serializeInkDocument,
	wordBounds,
} from '../src/ink/doc';
import {
	appendStrokeToCurrentWord,
	applyStyleToSelection,
	deleteSelection,
	eraseAtCursor,
	extractSelection,
	insertFragmentAtCursor,
	insertWordAtCursor,
	selectionStyleFlags,
	splitLineAtCursor,
	wordFromStroke,
} from '../src/ink/edit';
import { layoutDocument } from '../src/ink/layout';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
	try {
		fn();
		passed += 1;
	} catch (error) {
		failed += 1;
		const message = error instanceof Error ? error.message : String(error);
		console.error(`FAIL  ${name}\n      ${message}`);
	}
}

function ok(cond: boolean, msg: string): void {
	if (!cond) {
		throw new Error(msg);
	}
}

function eq(actual: unknown, expected: unknown, msg = ''): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) {
		throw new Error(`${msg} expected ${b} got ${a}`);
	}
}

// ---- builders -------------------------------------------------------------

function pt(x: number, y: number): InkPoint {
	return { x, y, pressure: 0.5, time: 0 };
}
function stroke(id: string, points: InkPoint[]): InkStroke {
	return { id, points, width: 3, color: '#111827' };
}
function word(id: string, ...strokes: InkStroke[]): InkWord {
	return { id, strokes };
}
function mkDoc(words0: InkWord[], words1: InkWord[] = []): InkDocument {
	const lines = [{ id: 'l0', words: words0 }];
	if (words1.length > 0) {
		lines.push({ id: 'l1', words: words1 });
	}
	return {
		version: INK_DOC_VERSION,
		meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
		lines,
	};
}
const W = (id: string) => word(id, stroke(`${id}s`, [pt(0, -40), pt(40, 0)]));
// A word placed at a specific line-absolute x (for layout tests, where spacing matters).
const Wx = (id: string, x: number) => word(id, stroke(`${id}s`, [pt(x, -40), pt(x + 40, 0)]));

// ---- doc.ts ---------------------------------------------------------------

test('createEmptyDocument: one empty line, cursor 0/0', () => {
	const d = createEmptyDocument();
	eq(d.lines.length, 1);
	eq(d.lines[0]?.words.length, 0);
	eq(d.meta.cursor, { line: 0, word: 0 });
});

test('serialize -> parse round-trips structure', () => {
	const d = mkDoc([W('a'), W('b')], [W('c')]);
	const back = parseInkDocument(serializeInkDocument(d));
	eq(back.version, INK_DOC_VERSION);
	eq(back.lines.length, 2);
	eq(back.lines[0]?.words.length, 2);
	eq(back.lines[1]?.words.length, 1);
	eq(back.lines[0]?.words[0]?.strokes[0]?.points[1], pt(40, 0));
});

test('parse rejects v1 documents', () => {
	let threw = false;
	try {
		parseInkDocument('{"version":1,"strokes":[]}');
	} catch {
		threw = true;
	}
	ok(threw, 'expected parse to throw on version 1');
});

test('parse empty string -> empty doc', () => {
	const d = parseInkDocument('   ');
	eq(d.lines.length, 1);
	eq(d.lines[0]?.words.length, 0);
});

test('parse drops empty words/strokes', () => {
	const d = parseInkDocument(
		JSON.stringify({
			version: 2,
			meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
			lines: [{ id: 'l0', words: [{ id: 'w', strokes: [{ id: 's', points: [] }] }] }],
		}),
	);
	eq(d.lines[0]?.words.length, 0, 'word with only empty strokes should be dropped');
});

test('parse migrates v2 word-local docs to spread, line-absolute words', () => {
	const v2 = JSON.stringify({
		version: 2,
		meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
		lines: [
			{
				id: 'l',
				words: [
					{ id: 'a', strokes: [{ id: 'as', points: [pt(0, -40), pt(40, 0)] }] },
					{ id: 'b', strokes: [{ id: 'bs', points: [pt(0, -40), pt(40, 0)] }] },
				],
			},
		],
	});
	const d = parseInkDocument(v2);
	eq(d.version, INK_DOC_VERSION);
	const a = wordBounds(d.lines[0]!.words[0]!);
	const b = wordBounds(d.lines[0]!.words[1]!);
	ok(!!a && !!b && b.minX > a.maxX, 'migrated v2 words should be spread apart, not overlapping');
});

test('v3 round-trip preserves line-absolute positions', () => {
	const d = mkDoc([Wx('a', 0), Wx('b', 200)]);
	const back = parseInkDocument(serializeInkDocument(d));
	eq(wordBounds(back.lines[0]!.words[1]!)?.minX, 200, 'absolute x must survive save/load unchanged');
});

test('parse preserves and clamps meta.widthScale; absent stays undefined', () => {
	const base = (widthScale?: number) =>
		JSON.stringify({
			version: INK_DOC_VERSION,
			meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null, widthScale },
			lines: [{ id: 'l', words: [] }],
		});
	eq(parseInkDocument(base(0.6)).meta.widthScale, 0.6);
	eq(parseInkDocument(base(5)).meta.widthScale, 1, 'over-max width clamps to 1');
	eq(parseInkDocument(base(0.05)).meta.widthScale, 0.3, 'below-min width clamps to 0.3');
	eq(parseInkDocument(base(undefined)).meta.widthScale, undefined, 'absent width stays undefined');
});

test('serialize -> parse round-trips meta.widthScale', () => {
	const d = mkDoc([W('a')]);
	d.meta.widthScale = 0.45;
	eq(parseInkDocument(serializeInkDocument(d)).meta.widthScale, 0.45);
});

test('wordBounds spans all strokes', () => {
	const w = word('w', stroke('a', [pt(0, -10), pt(10, 0)]), stroke('b', [pt(20, -30), pt(30, 5)]));
	eq(wordBounds(w), { minX: 0, maxX: 30, minY: -30, maxY: 5 });
});

test('orderCursors returns document order', () => {
	eq(orderCursors({ line: 1, word: 0 }, { line: 0, word: 3 }), [
		{ line: 0, word: 3 },
		{ line: 1, word: 0 },
	]);
});

test('clampCursor clamps line and word', () => {
	const d = mkDoc([W('a'), W('b')]);
	eq(clampCursor({ line: 9, word: 9 }, d.lines), { line: 0, word: 2 });
	eq(clampCursor({ line: -3, word: -3 }, d.lines), { line: 0, word: 0 });
});

// ---- edit.ts --------------------------------------------------------------

test('insertWordAtCursor inserts and advances cursor', () => {
	const d = mkDoc([W('a'), W('b')]);
	d.meta.cursor = { line: 0, word: 1 };
	const next = insertWordAtCursor(d, W('x'));
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'x', 'b']);
	eq(next, { line: 0, word: 2 });
});

test('appendStrokeToCurrentWord adds to the word before the cursor', () => {
	const d = mkDoc([W('a')]);
	d.meta.cursor = { line: 0, word: 1 };
	const did = appendStrokeToCurrentWord(d, stroke('extra', [pt(0, 0)]));
	ok(did, 'expected append to succeed');
	eq(d.lines[0]?.words[0]?.strokes.length, 2);
});

test('appendStrokeToCurrentWord fails at line start', () => {
	const d = mkDoc([W('a')]);
	d.meta.cursor = { line: 0, word: 0 };
	eq(appendStrokeToCurrentWord(d, stroke('extra', [pt(0, 0)])), false);
});

test('splitLineAtCursor splits the line and moves to the new line', () => {
	const d = mkDoc([W('a'), W('b'), W('c')]);
	d.meta.cursor = { line: 0, word: 1 };
	const next = splitLineAtCursor(d);
	eq(d.lines.length, 2);
	eq(d.lines[0]?.words.map((w) => w.id), ['a']);
	eq(d.lines[1]?.words.map((w) => w.id), ['b', 'c']);
	eq(next, { line: 1, word: 0 });
});

test('eraseAtCursor deletes the word before the cursor', () => {
	const d = mkDoc([W('a'), W('b')]);
	d.meta.cursor = { line: 0, word: 2 };
	const next = eraseAtCursor(d);
	eq(d.lines[0]?.words.map((w) => w.id), ['a']);
	eq(next, { line: 0, word: 1 });
});

test('eraseAtCursor closes up the gap when a mid-line word is deleted', () => {
	// a@0..40, b@120..160, c@240..280; lineHeight 180 -> gap = 63. Deleting b should pull c left
	// to sit one normal gap after a (40 + 63 = 103), not leave the hole b occupied.
	const d = mkDoc([Wx('a', 0), Wx('b', 120), Wx('c', 240)]);
	d.meta.cursor = { line: 0, word: 2 };
	eraseAtCursor(d);
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'c']);
	eq(wordBounds(d.lines[0]!.words[0]!)?.minX, 0, 'a must not move');
	eq(wordBounds(d.lines[0]!.words[1]!)?.minX, 103, 'c should close up behind a');
});

test('eraseAtCursor leaves trailing words in place (nothing to the right to close)', () => {
	const d = mkDoc([Wx('a', 0), Wx('b', 120)]);
	d.meta.cursor = { line: 0, word: 2 };
	eraseAtCursor(d);
	eq(d.lines[0]?.words.map((w) => w.id), ['a']);
	eq(wordBounds(d.lines[0]!.words[0]!)?.minX, 0, 'a must not move when the tail word is removed');
});

test('deleteSelection closes up the gap left by a mid-line range', () => {
	const d = mkDoc([Wx('a', 0), Wx('b', 120), Wx('c', 240), Wx('d', 360)]);
	d.meta.selection = { anchor: { line: 0, word: 1 }, focus: { line: 0, word: 3 } };
	deleteSelection(d, d.meta.selection);
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'd']);
	eq(wordBounds(d.lines[0]!.words[1]!)?.minX, 103, 'd should close up behind a after b,c removed');
});

test('eraseAtCursor at line start joins with the previous line', () => {
	const d = mkDoc([W('a')], [W('b'), W('c')]);
	d.meta.cursor = { line: 1, word: 0 };
	const next = eraseAtCursor(d);
	eq(d.lines.length, 1);
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'b', 'c']);
	eq(next, { line: 0, word: 1 }, 'cursor should land at the join point');
});

test('deleteSelection removes a same-line word range', () => {
	const d = mkDoc([W('a'), W('b'), W('c'), W('d')]);
	d.meta.selection = { anchor: { line: 0, word: 1 }, focus: { line: 0, word: 3 } };
	const next = deleteSelection(d, d.meta.selection);
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'd']);
	eq(next, { line: 0, word: 1 });
	eq(d.meta.selection, null);
});

test('deleteSelection merges across lines', () => {
	const d = mkDoc([W('a'), W('b')], [W('c'), W('d')]);
	const sel = { anchor: { line: 0, word: 1 }, focus: { line: 1, word: 1 } };
	const next = deleteSelection(d, sel);
	eq(d.lines.length, 1);
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'd']);
	eq(next, { line: 0, word: 1 });
});

test('wordFromStroke wraps a stroke into a single-stroke word', () => {
	const w = wordFromStroke(stroke('s', [pt(0, 0)]));
	eq(w.strokes.length, 1);
});

// ---- copy / paste ---------------------------------------------------------

test('extractSelection copies a same-line range without mutating the source', () => {
	const d = mkDoc([W('a'), W('b'), W('c'), W('d')]);
	const frag = extractSelection(d, { anchor: { line: 0, word: 1 }, focus: { line: 0, word: 3 } });
	eq(frag.segments.length, 1);
	eq(frag.segments[0]?.length, 2, 'should copy words b and c');
	eq(d.lines[0]?.words.length, 4, 'copy must not delete from the source');
});

test('extractSelection copies a multi-line range as multiple segments', () => {
	const d = mkDoc([W('a'), W('b')], [W('c'), W('d')]);
	const frag = extractSelection(d, { anchor: { line: 0, word: 1 }, focus: { line: 1, word: 1 } });
	eq(frag.segments.length, 2);
	eq(frag.segments[0]?.length, 1);
	eq(frag.segments[1]?.length, 1);
});

test('insertFragmentAtCursor pastes a single segment inline', () => {
	const d = mkDoc([W('a'), W('b')]);
	d.meta.cursor = { line: 0, word: 1 };
	const next = insertFragmentAtCursor(d, { segments: [[W('x'), W('y')]] });
	eq(d.lines[0]?.words.length, 4);
	eq(next, { line: 0, word: 3 });
});

test('insertFragmentAtCursor pastes a multi-segment fragment across lines', () => {
	const d = mkDoc([W('a'), W('b')]);
	d.meta.cursor = { line: 0, word: 1 };
	const next = insertFragmentAtCursor(d, { segments: [[W('x')], [W('y')]] });
	eq(d.lines.length, 2);
	eq(d.lines[0]?.words.length, 2, 'first line = a + x');
	eq(d.lines[1]?.words.length, 2, 'second line = y + b');
	eq(next, { line: 1, word: 1 });
});

test('pasting the same fragment twice yields unique stroke/word ids', () => {
	const d = mkDoc([W('a')]);
	const frag = extractSelection(
		mkDoc([W('p'), W('q')]),
		{ anchor: { line: 0, word: 0 }, focus: { line: 0, word: 2 } },
	);
	d.meta.cursor = { line: 0, word: 1 };
	insertFragmentAtCursor(d, frag);
	insertFragmentAtCursor(d, frag);
	const ids: string[] = [];
	for (const line of d.lines) {
		for (const w of line.words) {
			ids.push(w.id);
			for (const s of w.strokes) {
				ids.push(s.id);
			}
		}
	}
	eq(ids.length, new Set(ids).size, 'all word/stroke ids must be unique after repeated paste');
});

// ---- styling (bold / underline / colour on selection) ---------------------

test('applyStyleToSelection sets bold/underline/colour on the selected words only', () => {
	const d = mkDoc([W('a'), W('b'), W('c')]);
	const sel = { anchor: { line: 0, word: 1 }, focus: { line: 0, word: 3 } };
	applyStyleToSelection(d, sel, { bold: true, underline: true, color: '#ef4444' });
	const a = d.lines[0]!.words[0]!.strokes[0]!;
	const b = d.lines[0]!.words[1]!.strokes[0]!;
	ok(!a.bold && !a.underline, 'word a (outside selection) must be untouched');
	ok(b.bold === true && b.underline === true, 'word b should be bold + underlined');
	eq(b.color, '#ef4444', 'word b should be recoloured');
});

test('applyStyleToSelection bold:false removes the flag', () => {
	const d = mkDoc([W('a')]);
	const sel = { anchor: { line: 0, word: 0 }, focus: { line: 0, word: 1 } };
	applyStyleToSelection(d, sel, { bold: true });
	applyStyleToSelection(d, sel, { bold: false });
	ok(d.lines[0]!.words[0]!.strokes[0]!.bold === undefined, 'bold flag should be cleared');
});

test('selectionStyleFlags reports all-bold only when every stroke is bold', () => {
	const d = mkDoc([W('a'), W('b')]);
	const sel = { anchor: { line: 0, word: 0 }, focus: { line: 0, word: 2 } };
	eq(selectionStyleFlags(d, sel).allBold, false);
	applyStyleToSelection(d, sel, { bold: true });
	eq(selectionStyleFlags(d, sel).allBold, true);
	eq(selectionStyleFlags(d, sel).count, 2);
});

// ---- velocity width -------------------------------------------------------

test('velocityWidth attaches per-point widths; off leaves them undefined', () => {
	// Stroke with varying inter-point timing so speed (and width) varies.
	const s: InkStroke = {
		id: 's',
		width: 3,
		color: '#111827',
		points: [
			{ x: 0, y: 0, pressure: 0.5, time: 0 },
			{ x: 10, y: 0, pressure: 0.5, time: 10 },
			{ x: 200, y: 0, pressure: 0.5, time: 20 },
			{ x: 210, y: 0, pressure: 0.5, time: 120 },
		],
	};
	const cfg = {
		contentWidthCss: Number.POSITIVE_INFINITY,
		targetLineHeightCss: 30,
		sourceLineHeight: 180,
		wordGapScale: 1,
		strokeFillScale: 1,
	};
	const d = mkDoc([word('w', s)]);
	const off = layoutDocument(d, cfg);
	ok(
		off.words[0]!.strokes[0]!.points.every((p) => p.w === undefined),
		'no per-point widths when velocity is off',
	);
	const on = layoutDocument(d, { ...cfg, velocityWidth: true });
	const widths = on.words[0]!.strokes[0]!.points.map((p) => p.w ?? 0);
	ok(widths.every((w) => w > 0), 'every point should get a width when velocity is on');
	ok(Math.max(...widths) > Math.min(...widths), 'a varying-speed stroke should vary in width');
});

// ---- layout.ts ------------------------------------------------------------

const layoutConfig = {
	contentWidthCss: Number.POSITIVE_INFINITY,
	targetLineHeightCss: 30,
	sourceLineHeight: 180,
	wordGapScale: 1,
	strokeFillScale: 1,
};

test('layoutDocument places every word on the cursor line', () => {
	const d = mkDoc([Wx('a', 0), Wx('b', 120)]);
	const layout = layoutDocument(d, layoutConfig);
	eq(layout.words.length, 2);
	ok(
		layout.words.every((w) => w.visualRow === 0),
		'both words should be on visual row 0 (no wrap)',
	);
	ok((layout.words[1]?.x ?? 0) > (layout.words[0]?.x ?? 0), 'second word should be to the right');
});

test('caretRect advances to the right as the cursor moves through words', () => {
	const d = mkDoc([Wx('a', 0), Wx('b', 120)]);
	const layout = layoutDocument(d, layoutConfig);
	const c0 = layout.caretRect({ line: 0, word: 0 });
	const c2 = layout.caretRect({ line: 0, word: 2 });
	ok(c2.x > c0.x, 'caret at end should be right of caret at start');
});

test('cursorFromPoint maps far-left/far-right clicks to word slots', () => {
	const d = mkDoc([Wx('a', 0), Wx('b', 120)]);
	const layout = layoutDocument(d, layoutConfig);
	const midY = layout.rowHeight * 0.5;
	eq(layout.cursorFromPoint(-100, midY), { line: 0, word: 0 });
	eq(layout.cursorFromPoint(100000, midY), { line: 0, word: 2 });
});

test('cursorFromPoint resolves the second line by Y', () => {
	const d = mkDoc([Wx('a', 0)], [Wx('b', 0)]);
	const layout = layoutDocument(d, layoutConfig);
	const secondRowY = layout.rowHeight * 1.5;
	eq(layout.cursorFromPoint(-100, secondRowY).line, 1);
});

test('rangeRects returns one rect per visual row for a same-line selection', () => {
	const d = mkDoc([Wx('a', 0), Wx('b', 120), Wx('c', 240)]);
	const layout = layoutDocument(d, layoutConfig);
	const rects = layout.rangeRects({ anchor: { line: 0, word: 0 }, focus: { line: 0, word: 2 } });
	eq(rects.length, 1);
	ok((rects[0]?.w ?? 0) > 0, 'selection rect should have width');
});

test('preserves the drawn gap between words (absolute spacing)', () => {
	// b is drawn far to the right of a; the layout must keep that big gap, not normalise it.
	const near = layoutDocument(mkDoc([Wx('a', 0), Wx('b', 80)]), layoutConfig);
	const far = layoutDocument(mkDoc([Wx('a', 0), Wx('b', 400)]), layoutConfig);
	const nearGap = (near.words[1]?.x ?? 0) - (near.words[0]?.x ?? 0);
	const farGap = (far.words[1]?.x ?? 0) - (far.words[0]?.x ?? 0);
	ok(farGap > nearGap * 2, 'a larger drawn gap must produce a larger laid-out gap');
});

// ---- report ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
