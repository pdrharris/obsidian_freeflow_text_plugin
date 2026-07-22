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
	MAX_INDENT_LEVEL,
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
	cursorLineIsBulleted,
	deleteSelection,
	eraseAtCursor,
	extractSelection,
	indentLines,
	insertFragmentAtCursor,
	insertWordAtCursor,
	isScribbleGesture,
	selectionStyleFlags,
	splitLineAtCursor,
	toggleBulletAtCursor,
	toggleCheckboxAtCursor,
	toggleLineChecked,
	wordFromStroke,
} from '../src/ink/edit';
import { layoutDocument } from '../src/ink/layout';
import { compactInkBlocksInContent } from '../src/ink/compact';
import { Text } from '@codemirror/state';
import { editViolatesInkBlock, inkBlockAt } from '../src/ink/guard';

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
			version: 4,
			meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
			lines: [{ words: [{ strokes: [{ points: [] }] }] }],
		}),
	);
	eq(d.lines[0]?.words.length, 0, 'word with only empty strokes should be dropped');
});

test('round-trip preserves line-absolute positions', () => {
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

// ---- v4 compact wire format -----------------------------------------------

test('v4 serialize packs points as arrays and omits ids', () => {
	const s = serializeInkDocument(mkDoc([W('a')]));
	ok(s.includes('"version":4'), 'writes version 4');
	ok(!s.includes('"id"'), 'no ids in the wire format');
	ok(!s.includes('"x":'), 'no per-point object keys');
	ok(s.includes('"points":[['), 'points are arrays');
});

test('v4 parse decodes fixed-point packed points', () => {
	const raw = JSON.stringify({
		version: 4,
		meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
		lines: [
			{
				words: [
					{
						strokes: [
							{ points: [[2997, -2934, 8, 0], [2971, -3013, 11, 9]], width: 1.27, color: '#111827' },
						],
					},
				],
			},
		],
	});
	const d = parseInkDocument(raw);
	const p0 = d.lines[0]!.words[0]!.strokes[0]!.points[0]!;
	const p1 = d.lines[0]!.words[0]!.strokes[0]!.points[1]!;
	eq(p0, { x: 29.97, y: -29.34, pressure: 0.08, time: 0 });
	eq(p1, { x: 29.71, y: -30.13, pressure: 0.11, time: 9 });
});

test('v4 serialize rounds to 2dp and rebases stroke times to zero', () => {
	const d = mkDoc([
		word('w', stroke('s', [
			{ x: 29.974736842105266, y: -29.338105263157896, pressure: 0.07999999999999999, time: 1784234164423 },
			{ x: 29.70947368421053, y: -30.13389473684211, pressure: 0.1139990005493164, time: 1784234164432 },
		])),
	]);
	const back = parseInkDocument(serializeInkDocument(d));
	const p0 = back.lines[0]!.words[0]!.strokes[0]!.points[0]!;
	const p1 = back.lines[0]!.words[0]!.strokes[0]!.points[1]!;
	eq(p0, { x: 29.97, y: -29.34, pressure: 0.08, time: 0 }, 'rounded + rebased');
	eq(p1.time, 9, 'within-stroke delta preserved');
});

test('v4 serialize is idempotent after one round-trip', () => {
	const d = mkDoc([
		word('w', stroke('s', [
			{ x: 12.345678, y: -0.999999, pressure: 0.333333, time: 1784234164423 },
			{ x: 13.111111, y: -5.555555, pressure: 0.666666, time: 1784234164440 },
		])),
	]);
	const s1 = serializeInkDocument(d);
	const s2 = serializeInkDocument(parseInkDocument(s1));
	eq(s2, s1, 'second serialize must be byte-identical');
});

test('legacy v2/v3 docs are rejected (support removed in 0.0.22)', () => {
	const v3 = JSON.stringify({
		version: 3,
		meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
		lines: [
			{
				id: 'l',
				words: [
					{
						id: 'w',
						strokes: [
							{
								id: 's',
								points: [{ x: 1.5, y: -2.5, pressure: 0.4, time: 100 }],
								width: 3,
								color: '#111827',
							},
						],
					},
				],
			},
		],
	});
	let threw = false;
	try {
		parseInkDocument(v3);
	} catch {
		threw = true;
	}
	ok(threw, 'v3 must throw, not silently parse to an empty document');
});

test('compactInkBlocksInContent: canonicalises loose v4 blocks, leaves other content alone', () => {
	// Same v4 data but pretty-printed — as an external tool or hand edit might leave it.
	const looseBody = JSON.stringify(
		{
			version: 4,
			meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
			lines: [
				{ words: [{ strokes: [{ points: [[2997, -2934, 50, 0]], width: 3, color: '#111827' }] }] },
			],
		},
		null,
		2,
	);
	const note = `# Heading\n\nSome text.\n\n\`\`\`fii-ink\n${looseBody}\n\`\`\`\n\nMore text.\n`;
	const result = compactInkBlocksInContent(note);
	eq(result.blocksCompacted, 1);
	eq(result.blocksFailed, 0);
	ok(result.bytesSaved > 0, 'canonicalising a pretty-printed block must shrink it');
	ok(result.content.startsWith('# Heading\n\nSome text.\n\n```fii-ink\n'), 'prose before the block untouched');
	ok(result.content.endsWith('\n```\n\nMore text.\n'), 'prose after the block untouched');
	ok(result.content.includes('"version":4'), 'block still v4');
	// Second pass is a no-op: already compact.
	const again = compactInkBlocksInContent(result.content);
	eq(again.blocksCompacted, 0);
	eq(again.content, result.content);
});

test('compactInkBlocksInContent: unparsable, legacy and empty blocks are left untouched', () => {
	const v3Block = '```fii-ink\n{"version":3,"meta":{},"lines":[]}\n```';
	const note = `\`\`\`fii-ink\nnot json at all\n\`\`\`\n\n${v3Block}\n\n\`\`\`fii-ink\n\n\`\`\`\n`;
	const result = compactInkBlocksInContent(note);
	eq(result.content, note, 'nothing rewritten');
	eq(result.blocksCompacted, 0);
	eq(result.blocksFailed, 2, 'invalid and legacy blocks count as failed; empty does not');
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

test('isScribbleGesture: horizontal back-and-forth scratch-out is detected', () => {
	// Five passes across a ~100-wide, ~20-tall box: clearly a strike-out.
	const pts: { x: number; y: number }[] = [];
	for (let pass = 0; pass < 5; pass += 1) {
		const leftToRight = pass % 2 === 0;
		for (let s = 0; s <= 10; s += 1) {
			const t = leftToRight ? s : 10 - s;
			pts.push({ x: t * 10, y: (pass % 2) * 20 });
		}
	}
	ok(isScribbleGesture(pts), 'zig-zag over its own width should read as a scribble');
});

test('isScribbleGesture: straight strokes and short strokes are not scribbles', () => {
	const horizontal = Array.from({ length: 20 }, (_, i) => ({ x: i * 6, y: 0 }));
	ok(!isScribbleGesture(horizontal), 'a straight horizontal line is not a scribble');
	const vertical = Array.from({ length: 20 }, (_, i) => ({ x: 0, y: i * 6 }));
	ok(!isScribbleGesture(vertical), 'a straight vertical line is not a scribble');
	ok(!isScribbleGesture([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 'too few points is not a scribble');
});

test('eraseAtCursor at line start joins with the previous line', () => {
	const d = mkDoc([W('a')], [W('b'), W('c')]);
	d.meta.cursor = { line: 1, word: 0 };
	const next = eraseAtCursor(d);
	eq(d.lines.length, 1);
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'b', 'c']);
	eq(next, { line: 0, word: 1 }, 'cursor should land at the join point');
});

test('eraseAtCursor join re-seats the joined words after the previous line (no overlap)', () => {
	// line0: a@0..40; line1: b@0..40, c@120..160. lineHeight 180 -> gap = 63. Joining line1 onto
	// line0 must shift its words to start at a.maxX + gap (40 + 63 = 103), not keep x≈0 on top of a.
	const d = mkDoc([Wx('a', 0)], [Wx('b', 0), Wx('c', 120)]);
	d.meta.cursor = { line: 1, word: 0 };
	eraseAtCursor(d);
	eq(d.lines.length, 1);
	eq(d.lines[0]?.words.map((w) => w.id), ['a', 'b', 'c']);
	eq(wordBounds(d.lines[0]!.words[0]!)?.minX, 0, 'a must not move');
	eq(wordBounds(d.lines[0]!.words[1]!)?.minX, 103, 'b should start a word-gap after a');
	eq(wordBounds(d.lines[0]!.words[2]!)?.minX, 223, 'c keeps its gap behind b (120 + 103)');
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

// ---- bullets & indents ----------------------------------------------------

test('parse round-trips bullet + indent and clamps the level', () => {
	const d = mkDoc([W('a')]);
	d.lines[0]!.bullet = true;
	d.lines[0]!.indent = 2;
	const back = parseInkDocument(serializeInkDocument(d));
	eq(back.lines[0]?.bullet, true);
	eq(back.lines[0]?.indent, 2);
	const over = parseInkDocument(
		JSON.stringify({
			version: INK_DOC_VERSION,
			meta: { lineHeight: 180, cursor: { line: 0, word: 0 }, selection: null },
			lines: [{ id: 'l', words: [], indent: 99, bullet: true }],
		}),
	);
	eq(over.lines[0]?.indent, MAX_INDENT_LEVEL, 'indent clamps to MAX_INDENT_LEVEL');
});

test('parse omits absent list fields (no bullet/indent on a plain line)', () => {
	const back = parseInkDocument(serializeInkDocument(mkDoc([W('a')])));
	eq(back.lines[0]?.bullet, undefined);
	eq(back.lines[0]?.indent, undefined);
});

test('indentLines increases, clamps at the max, and outdent to 0 clears the field', () => {
	const d = mkDoc([W('a')]);
	d.meta.cursor = { line: 0, word: 0 };
	indentLines(d, 1);
	eq(d.lines[0]?.indent, 1);
	for (let i = 0; i < 20; i += 1) {
		indentLines(d, 1);
	}
	eq(d.lines[0]?.indent, MAX_INDENT_LEVEL, 'indent saturates at the max level');
	for (let i = 0; i < 20; i += 1) {
		indentLines(d, -1);
	}
	eq(d.lines[0]?.indent, undefined, 'outdent to 0 removes the field rather than storing 0');
});

test('toggleBulletAtCursor toggles the cursor line on then off', () => {
	const d = mkDoc([W('a')]);
	d.meta.cursor = { line: 0, word: 0 };
	toggleBulletAtCursor(d);
	eq(d.lines[0]?.bullet, true);
	eq(cursorLineIsBulleted(d), true);
	toggleBulletAtCursor(d);
	eq(d.lines[0]?.bullet, undefined);
	eq(cursorLineIsBulleted(d), false);
});

test('list ops span every line of an active selection; mixed bullets all turn on', () => {
	const d = mkDoc([W('a')], [W('b')]);
	d.lines[0]!.bullet = true; // line 0 already bulleted, line 1 not
	d.meta.selection = { anchor: { line: 0, word: 0 }, focus: { line: 1, word: 1 } };
	toggleBulletAtCursor(d);
	eq(d.lines[0]?.bullet, true, 'a mixed selection becomes uniformly bulleted');
	eq(d.lines[1]?.bullet, true);
	indentLines(d, 1);
	eq(d.lines[0]?.indent, 1);
	eq(d.lines[1]?.indent, 1, 'indent applies to both selected lines');
});

test('splitLineAtCursor inherits indent + bullet onto the new line', () => {
	const d = mkDoc([W('a'), W('b')]);
	d.lines[0]!.bullet = true;
	d.lines[0]!.indent = 2;
	d.meta.cursor = { line: 0, word: 1 };
	splitLineAtCursor(d);
	eq(d.lines[1]?.bullet, true, 'new line continues the bulleted list');
	eq(d.lines[1]?.indent, 2, 'new line keeps the same indent');
});

test('splitLineAtCursor on an empty bullet ends the list instead of adding a line', () => {
	const d = mkDoc([]); // single empty line
	d.lines[0]!.bullet = true;
	d.lines[0]!.indent = 1;
	d.meta.cursor = { line: 0, word: 0 };
	const next = splitLineAtCursor(d);
	eq(d.lines.length, 1, 'no new line is created');
	eq(d.lines[0]?.bullet, undefined, 'the bullet is dropped (list terminated)');
	eq(d.lines[0]?.indent, 1, 'indent is left intact');
	eq(next, { line: 0, word: 0 });
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

test('layout indents content and emits one bullet mark per bulleted line', () => {
	const plain = layoutDocument(mkDoc([Wx('a', 0)]), layoutConfig);
	const d = mkDoc([Wx('a', 0)]);
	d.lines[0]!.bullet = true;
	d.lines[0]!.indent = 1;
	const listed = layoutDocument(d, layoutConfig);
	eq(listed.bullets.length, 1, 'one bullet mark for the bulleted line');
	ok(
		(listed.words[0]?.x ?? 0) > (plain.words[0]?.x ?? 0),
		'bulleted + indented content is pushed right of the plain line',
	);
	const bullet = listed.bullets[0]!;
	ok(bullet.x < (listed.words[0]?.x ?? 0), 'the bullet sits left of the first word');
	eq(plain.bullets.length, 0, 'a plain line emits no bullet mark');
});

test('a bulleted line still emits its bullet when it has no words', () => {
	const d = mkDoc([]);
	d.lines[0]!.bullet = true;
	const layout = layoutDocument(d, layoutConfig);
	eq(layout.bullets.length, 1, 'an empty bulleted line shows its bullet');
});

test('a wrapped bulleted line hangs its continuation under the first word, not the bullet', () => {
	// Three wide words on one indented+bulleted line, forced to wrap by a narrow content width.
	const d = mkDoc([Wx('a', 0), Wx('b', 300), Wx('c', 600)]);
	d.lines[0]!.bullet = true;
	d.lines[0]!.indent = 1;
	const layout = layoutDocument(d, { ...layoutConfig, contentWidthCss: 200 });
	const byRow = new Map<number, number>();
	for (const w of layout.words) {
		byRow.set(w.visualRow, Math.min(byRow.get(w.visualRow) ?? Infinity, w.x));
	}
	ok(byRow.size > 1, 'content should wrap to more than one visual row');
	const firstWordX = layout.words.find((w) => w.word === 0)?.x ?? 0;
	for (const [, left] of byRow) {
		ok(Math.abs(left - firstWordX) < 1, 'every wrapped row starts at the content inset (hanging)');
	}
});

test('preserves the drawn gap between words (absolute spacing)', () => {
	// b is drawn far to the right of a; the layout must keep that big gap, not normalise it.
	const near = layoutDocument(mkDoc([Wx('a', 0), Wx('b', 80)]), layoutConfig);
	const far = layoutDocument(mkDoc([Wx('a', 0), Wx('b', 400)]), layoutConfig);
	const nearGap = (near.words[1]?.x ?? 0) - (near.words[0]?.x ?? 0);
	const farGap = (far.words[1]?.x ?? 0) - (far.words[0]?.x ?? 0);
	ok(farGap > nearGap * 2, 'a larger drawn gap must produce a larger laid-out gap');
});

// ---- checkboxes ------------------------------------------------------------

test('toggleCheckboxAtCursor makes the cursor line a checkbox and replaces any bullet', () => {
	const d = mkDoc([Wx('a', 0)]);
	d.lines[0]!.bullet = true;
	toggleCheckboxAtCursor(d);
	eq(d.lines[0]!.checkbox, true);
	eq(d.lines[0]!.bullet, undefined, 'bullet and checkbox are mutually exclusive');
	toggleCheckboxAtCursor(d);
	eq(d.lines[0]!.checkbox, undefined, 'toggling again removes the checkbox');
});

test('toggleBulletAtCursor replaces a checkbox (and clears its checked state)', () => {
	const d = mkDoc([Wx('a', 0)]);
	d.lines[0]!.checkbox = true;
	d.lines[0]!.checked = true;
	toggleBulletAtCursor(d);
	eq(d.lines[0]!.bullet, true);
	eq(d.lines[0]!.checkbox, undefined);
	eq(d.lines[0]!.checked, undefined);
});

test('toggleLineChecked flips the state and rejects non-checkbox lines', () => {
	const d = mkDoc([Wx('a', 0)], [Wx('b', 0)]);
	d.lines[0]!.checkbox = true;
	eq(toggleLineChecked(d, 0), true);
	eq(d.lines[0]!.checked, true);
	eq(toggleLineChecked(d, 0), false);
	eq(d.lines[0]!.checked, undefined, 'unchecking deletes the flag (lean JSON)');
	eq(toggleLineChecked(d, 1), null, 'a plain line is not toggleable');
});

test('newline inherits the checkbox (unchecked); newline on an empty checkbox line ends the list', () => {
	const d = mkDoc([Wx('a', 0)]);
	d.lines[0]!.checkbox = true;
	d.lines[0]!.checked = true;
	d.meta.cursor = { line: 0, word: 1 };
	splitLineAtCursor(d);
	eq(d.lines[1]!.checkbox, true, 'the next list item is a checkbox too');
	eq(d.lines[1]!.checked, undefined, 'a new item starts unchecked');
	// The new line is empty: newline again drops the checkbox in place (ends the list).
	splitLineAtCursor(d);
	eq(d.lines.length, 2, 'no third line is created');
	eq(d.lines[1]!.checkbox, undefined);
});

test('checkbox and checked survive a serialize/parse round-trip', () => {
	const d = mkDoc([Wx('a', 0)], [Wx('b', 0)]);
	d.lines[0]!.checkbox = true;
	d.lines[0]!.checked = true;
	d.lines[1]!.checkbox = true;
	const round = parseInkDocument(serializeInkDocument(d));
	eq(round.lines[0]!.checkbox, true);
	eq(round.lines[0]!.checked, true);
	eq(round.lines[1]!.checkbox, true);
	eq(round.lines[1]!.checked, undefined);
});

test('layout emits a checkbox mark with a hit box tied to its logical line', () => {
	const d = mkDoc([Wx('a', 0)], [Wx('b', 0)]);
	d.lines[1]!.checkbox = true;
	d.lines[1]!.checked = true;
	const layout = layoutDocument(d, layoutConfig);
	eq(layout.checkboxes.length, 1);
	const box = layout.checkboxes[0]!;
	eq(box.line, 1);
	eq(box.checked, true);
	ok(box.size > 0, 'the box has a tappable size');
	ok(box.y > layout.rowHeight * 0.5, 'the box sits on the second visual row');
	ok(box.x < (layout.words.find((w) => w.line === 1)?.x ?? 0), 'the box sits left of the content');
});

// ---- guard.ts --------------------------------------------------------------

// Note layout: 1 text / 2 opener / 3 JSON body / 4 closer / 5 text.
const guardNote = Text.of([
	'Some text above',
	'```fii-ink',
	'{"version":2,"lines":[]}',
	'```',
	'Text below',
]);

test('inkBlockAt spans the fences and answers null outside', () => {
	const block = inkBlockAt(guardNote, guardNote.line(3).from + 2);
	eq(block, { from: guardNote.line(2).from, to: guardNote.line(4).to });
	eq(inkBlockAt(guardNote, guardNote.line(2).from), block, 'opener line is inside');
	eq(inkBlockAt(guardNote, guardNote.line(4).to), block, 'closer line end is inside');
	eq(inkBlockAt(guardNote, guardNote.line(1).from), null, 'text above is outside');
	eq(inkBlockAt(guardNote, guardNote.line(5).from), null, 'text below is outside');
});

test('an unclosed ink block is protected to the end of the note', () => {
	const open = Text.of(['```fii-ink', '{"version":2}', 'trailing']);
	const block = inkBlockAt(open, open.length);
	eq(block, { from: 0, to: open.length });
});

test('backspace merging the line below into the closing fence is a violation', () => {
	const closerEnd = guardNote.line(4).to;
	ok(
		editViolatesInkBlock(guardNote, closerEnd, guardNote.line(5).from, ''),
		'deleting the newline after the closer must be blocked',
	);
});

test('forward-delete merging the opener into the line above is a violation', () => {
	ok(
		editViolatesInkBlock(guardNote, guardNote.line(1).to, guardNote.line(2).from, ''),
		'deleting the newline before the opener must be blocked',
	);
});

test('typing inside the JSON body is a violation', () => {
	ok(editViolatesInkBlock(guardNote, guardNote.line(3).from + 3, guardNote.line(3).from + 3, 'x'));
	ok(
		editViolatesInkBlock(guardNote, guardNote.line(3).from, guardNote.line(3).to, 'oops'),
		'replacing the body must be blocked',
	);
});

test('deleting the whole block (or more) is allowed', () => {
	ok(!editViolatesInkBlock(guardNote, guardNote.line(2).from, guardNote.line(4).to, ''));
	ok(
		!editViolatesInkBlock(guardNote, guardNote.line(1).from, guardNote.line(5).to, ''),
		'a selection swallowing the block whole is a legitimate delete',
	);
});

test('boundary insertions are allowed only when they keep the fences intact', () => {
	const from = guardNote.line(2).from;
	const to = guardNote.line(4).to;
	ok(!editViolatesInkBlock(guardNote, from, from, '\n'), 'Enter above the opener is fine');
	ok(editViolatesInkBlock(guardNote, from, from, 'x'), 'a stray char breaks the opener fence');
	ok(!editViolatesInkBlock(guardNote, to, to, '\nnew line'), 'a new line after the closer is fine');
	ok(editViolatesInkBlock(guardNote, to, to, 'x'), 'a stray char breaks the closer fence');
});

test('ordinary edits elsewhere are untouched by the guard', () => {
	ok(!editViolatesInkBlock(guardNote, guardNote.line(5).from + 2, guardNote.line(5).from + 2, 'x'));
	const plainNote = Text.of(['no blocks here', 'just prose']);
	ok(!editViolatesInkBlock(plainNote, 3, 5, 'y'));
	const jsNote = Text.of(['```js', 'const a = 1;', '```', 'after']);
	ok(
		!editViolatesInkBlock(jsNote, jsNote.line(2).from + 1, jsNote.line(2).from + 1, 'z'),
		'other code blocks stay editable',
	);
	ok(
		!editViolatesInkBlock(jsNote, jsNote.line(3).to, jsNote.line(4).from, ''),
		'backspace below a non-ink block stays allowed',
	);
});

// ---- report ---------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
