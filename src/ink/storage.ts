import { App, TFile } from 'obsidian';
import { INK_CODE_BLOCK_LANGUAGE } from './doc';

export interface SectionInfoLike {
	lineStart: number;
	lineEnd: number;
}

export async function persistInkCodeBlock(
	app: App,
	sourcePath: string,
	sectionInfo: SectionInfoLike,
	serialized: string,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!(file instanceof TFile)) {
		throw new Error('Unable to persist fii-ink block: file not found.');
	}

	const replacementBlock = buildFenceBlock(serialized);
	const content = await app.vault.cachedRead(file);
	const newline = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);
	const start = clamp(sectionInfo.lineStart, 0, Math.max(0, lines.length - 1));
	const end = clamp(sectionInfo.lineEnd, start, Math.max(start, lines.length - 1));
	const replacedBySection = replaceBlockBySection(lines, start, end, replacementBlock);
	let nextContent: string;
	if (replacedBySection) {
		nextContent = lines.join(newline);
	} else {
		const fallback = replaceFirstInkFence(content, replacementBlock.join(newline), newline);
		if (fallback === null) {
			throw new Error('Unable to locate target fii-ink block for save.');
		}
		nextContent = fallback;
	}

	if (nextContent !== content) {
		await app.vault.modify(file, nextContent);
	}
}

// The note-frontmatter search sidecar: an "Indexed text" property holding a map of block id → the
// recognised lines (one list entry per handwritten line, so the property reads naturally and shows
// line breaks). Kept out of the note body so a search hit opens the properties, not the stroke JSON,
// and it doesn't clutter the writing area. Search still matches the words. Empty text removes the
// block's entry; an empty map removes the property entirely.
const FRONTMATTER_KEY = 'Indexed text';
const LEGACY_FRONTMATTER_KEY = 'ink-text'; // pre-0.0.31 key name; cleaned up on write

export async function persistInkSearchFrontmatter(
	app: App,
	sourcePath: string,
	blockId: string,
	text: string,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!(file instanceof TFile)) {
		throw new Error('Unable to persist fii-ink search text: file not found.');
	}
	// One list entry per handwritten line (recognition returns lines separated by "\n").
	const lines = text
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.filter((line) => line.length > 0);
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		const existing = fm[FRONTMATTER_KEY];
		const map: Record<string, string[]> =
			existing && typeof existing === 'object' && !Array.isArray(existing)
				? { ...(existing as Record<string, string[]>) }
				: {};
		if (lines.length > 0) {
			map[blockId] = lines;
		} else {
			delete map[blockId];
		}
		if (Object.keys(map).length === 0) {
			delete fm[FRONTMATTER_KEY];
		} else {
			fm[FRONTMATTER_KEY] = map;
		}
		delete fm[LEGACY_FRONTMATTER_KEY]; // migrate off the old key name
	});
}

// The (legacy 0.0.29) hidden search-text sidecar: a single-line `%%…%%` comment placed just below a block's closing
// fence. Kept OUT of the code block so a search hit opens only these words, not the stroke JSON.
const SEARCH_COMMENT_RE = /^\s*%%\s*ink-text:.*%%\s*$/;

function buildSearchCommentLine(text: string): string | null {
	// One line: collapse whitespace/newlines and neutralise any `%%` so the comment can't break.
	const clean = text.replace(/%%/g, '%').replace(/\s+/g, ' ').trim();
	return clean.length > 0 ? `%% ink-text: ${clean} %%` : null;
}

// Upsert (or, for empty text, remove) the hidden search-text comment for a block. Anchored to the
// block's closing fence via its section, so it stays attached to the right block in multi-block notes.
export async function persistInkSearchText(
	app: App,
	sourcePath: string,
	sectionInfo: SectionInfoLike,
	text: string,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!(file instanceof TFile)) {
		throw new Error('Unable to persist fii-ink search text: file not found.');
	}
	const content = await app.vault.cachedRead(file);
	const newline = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);
	const start = clamp(sectionInfo.lineStart, 0, Math.max(0, lines.length - 1));
	const end = clamp(sectionInfo.lineEnd, start, Math.max(start, lines.length - 1));

	const sectionLines = lines.slice(start, end + 1);
	const openIndex = sectionLines.findIndex((line) =>
		line.trimStart().startsWith(`\`\`\`${INK_CODE_BLOCK_LANGUAGE}`),
	);
	const closeIndex =
		openIndex === -1
			? -1
			: sectionLines.findIndex((line, index) => index > openIndex && line.trimStart().startsWith('```'));
	if (closeIndex === -1) {
		return; // can't anchor reliably; skip rather than write in the wrong place
	}

	const afterAbs = start + closeIndex + 1; // the line just below the closing fence
	const existing = afterAbs < lines.length && SEARCH_COMMENT_RE.test(lines[afterAbs] ?? '');
	const commentLine = buildSearchCommentLine(text);
	if (commentLine === null) {
		if (existing) {
			lines.splice(afterAbs, 1);
		}
	} else if (existing) {
		lines[afterAbs] = commentLine;
	} else {
		lines.splice(afterAbs, 0, commentLine);
	}

	const next = lines.join(newline);
	if (next !== content) {
		await app.vault.modify(file, next);
	}
}

// Remove an entire fii-ink fence (open line, body, close line) from the file.
export async function removeInkCodeBlock(
	app: App,
	sourcePath: string,
	sectionInfo: SectionInfoLike,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!(file instanceof TFile)) {
		throw new Error('Unable to delete fii-ink block: file not found.');
	}

	const content = await app.vault.cachedRead(file);
	const newline = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.split(/\r?\n/);
	const start = clamp(sectionInfo.lineStart, 0, Math.max(0, lines.length - 1));
	const end = clamp(sectionInfo.lineEnd, start, Math.max(start, lines.length - 1));
	// Also drop this block's hidden search-text comment (sits just below the closing fence) so it
	// doesn't linger as an orphan. Done before the block removal; it's past `end`, so indices hold.
	const secLines = lines.slice(start, end + 1);
	const openIdx = secLines.findIndex((line) =>
		line.trimStart().startsWith(`\`\`\`${INK_CODE_BLOCK_LANGUAGE}`),
	);
	const closeIdx =
		openIdx === -1
			? -1
			: secLines.findIndex((line, index) => index > openIdx && line.trimStart().startsWith('```'));
	if (closeIdx !== -1) {
		const commentAbs = start + closeIdx + 1;
		if (commentAbs < lines.length && SEARCH_COMMENT_RE.test(lines[commentAbs] ?? '')) {
			lines.splice(commentAbs, 1);
		}
	}
	const removedBySection = removeBlockBySection(lines, start, end);
	let nextContent: string;
	if (removedBySection) {
		nextContent = lines.join(newline);
	} else {
		const fallback = removeFirstInkFence(content);
		if (fallback === null) {
			throw new Error('Unable to locate target fii-ink block to delete.');
		}
		nextContent = fallback;
	}

	if (nextContent !== content) {
		await app.vault.modify(file, nextContent);
	}
}

function removeBlockBySection(lines: string[], start: number, end: number): boolean {
	const sectionLines = lines.slice(start, end + 1);
	const openIndex = sectionLines.findIndex((line) =>
		line.trimStart().startsWith(`\`\`\`${INK_CODE_BLOCK_LANGUAGE}`),
	);
	if (openIndex === -1) {
		return false;
	}
	const closeIndex = sectionLines.findIndex(
		(line, index) => index > openIndex && line.trimStart().startsWith('```'),
	);
	if (closeIndex === -1) {
		return false;
	}
	const before = sectionLines.slice(0, openIndex);
	const after = sectionLines.slice(closeIndex + 1);
	lines.splice(start, end - start + 1, ...before, ...after);
	return true;
}

function removeFirstInkFence(content: string): string | null {
	const escapedLanguage = escapeRegExp(INK_CODE_BLOCK_LANGUAGE);
	const pattern =
		'(^|\\r?\\n)```' +
		escapedLanguage +
		'[^\\r\\n]*\\r?\\n[\\s\\S]*?\\r?\\n```(?=\\r?\\n|$)';
	const match = content.match(new RegExp(pattern, 'm'));
	if (!match || typeof match.index !== 'number') {
		return null;
	}
	return `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`;
}

function buildFenceBlock(serialized: string): string[] {
	// The serialized document may span multiple lines now; split it so the fence block is a proper
	// one-string-per-line array (keeps the section splice line counts correct).
	return [`\`\`\`${INK_CODE_BLOCK_LANGUAGE}`, ...serialized.split('\n'), '```'];
}

function replaceBlockBySection(
	lines: string[],
	start: number,
	end: number,
	replacementBlock: string[],
): boolean {
	const sectionLines = lines.slice(start, end + 1);
	const openIndex = sectionLines.findIndex((line) =>
		line.trimStart().startsWith(`\`\`\`${INK_CODE_BLOCK_LANGUAGE}`),
	);
	if (openIndex === -1) {
		return false;
	}

	const closeIndex = sectionLines.findIndex(
		(line, index) => index > openIndex && line.trimStart().startsWith('```'),
	);
	if (closeIndex === -1) {
		return false;
	}

	const before = sectionLines.slice(0, openIndex);
	const after = sectionLines.slice(closeIndex + 1);
	const nextSection = [...before, ...replacementBlock, ...after];
	lines.splice(start, end - start + 1, ...nextSection);
	return true;
}

function replaceFirstInkFence(
	content: string,
	replacement: string,
	newline: string,
): string | null {
	const escapedLanguage = escapeRegExp(INK_CODE_BLOCK_LANGUAGE);
	const pattern =
		'(^|\\r?\\n)```' +
		escapedLanguage +
		'[^\\r\\n]*\\r?\\n[\\s\\S]*?\\r?\\n```(?=\\r?\\n|$)';
	const fencePattern = new RegExp(
		pattern,
		'm',
	);
	const match = content.match(fencePattern);
	if (!match || typeof match.index !== 'number') {
		return null;
	}

	const matched = match[0];
	const prefixNewline = matched.startsWith('\n') || matched.startsWith('\r\n');
	const next = `${prefixNewline ? newline : ''}${replacement}`;
	return `${content.slice(0, match.index)}${next}${content.slice(match.index + matched.length)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
