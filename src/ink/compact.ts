// Bulk re-serialization of fii-ink blocks into the current compact wire format. Pure
// string -> string (no Obsidian imports) so it is testable headlessly and can be run inside
// `vault.process` by the "Compact all ink blocks in vault" command.

import { INK_CODE_BLOCK_LANGUAGE, parseInkDocument, serializeInkDocument } from './doc';

export interface CompactContentResult {
	content: string;
	blocksCompacted: number;
	blocksFailed: number;
	bytesSaved: number;
}

// Re-serialize every fii-ink block in a note's content. Blocks whose body fails to parse are
// left byte-for-byte untouched and counted in `blocksFailed`; empty bodies are skipped.
export function compactInkBlocksInContent(content: string): CompactContentResult {
	const escapedLanguage = escapeRegExp(INK_CODE_BLOCK_LANGUAGE);
	// Open fence line, single-line-JSON body (serialized docs never contain a newline), close
	// fence at the start of a line. Lazy body match stops at the first newline+``` pair.
	const pattern = new RegExp(
		'(```' + escapedLanguage + '[^\\r\\n]*\\r?\\n)([\\s\\S]*?)(\\r?\\n```)',
		'g',
	);
	let blocksCompacted = 0;
	let blocksFailed = 0;
	let bytesSaved = 0;
	const next = content.replace(pattern, (match, open: string, body: string, close: string) => {
		if (!body.trim()) {
			return match;
		}
		let serialized: string;
		try {
			serialized = serializeInkDocument(parseInkDocument(body));
		} catch {
			blocksFailed += 1;
			return match;
		}
		if (serialized === body) {
			return match;
		}
		blocksCompacted += 1;
		bytesSaved += body.length - serialized.length;
		return `${open}${serialized}${close}`;
	});
	return { content: next, blocksCompacted, blocksFailed, bytesSaved };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
