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
	return [`\`\`\`${INK_CODE_BLOCK_LANGUAGE}`, serialized, '```'];
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
