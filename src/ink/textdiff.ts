// Pure text helper (no Obsidian/DOM imports, so it's unit-testable): the smallest single
// replacement that turns `before` into `after`. Used to apply a whole-note rewrite to an open
// editor as one targeted `replaceRange` instead of `setValue`, which would reset the scroll
// position, collapse the undo history, and (in an encrypted note) churn the whole document.

export interface TextReplacement {
	from: number; // offset into `before`
	to: number; // offset into `before` (exclusive)
	text: string; // replacement text
}

export function minimalReplacement(before: string, after: string): TextReplacement | null {
	if (before === after) {
		return null;
	}
	const maxPrefix = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
		prefix += 1;
	}
	const maxSuffix = Math.min(before.length, after.length) - prefix;
	let suffix = 0;
	while (
		suffix < maxSuffix &&
		before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
	) {
		suffix += 1;
	}
	return {
		from: prefix,
		to: before.length - suffix,
		text: after.slice(prefix, after.length - suffix),
	};
}
