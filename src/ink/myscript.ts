// MyScript iink Batch REST client — the swappable "engine" behind recognition.
//
// One call: strokes in, recognized text out. Isolated in its own module so the rest of the plugin
// depends on a plain `recognizeText(strokes, creds) => Promise<string>` and MyScript can be
// replaced (or joined by an offline engine) without touching the callers.
//
// Two deliberate platform choices:
//   - `requestUrl` (Obsidian), NOT fetch: MyScript Cloud sends no CORS headers, so a browser-origin
//     fetch from the Obsidian renderer would be blocked. requestUrl goes through the app, no CORS.
//   - Web Crypto (`crypto.subtle`) for the HMAC, NOT Node's `crypto`: Web Crypto exists on desktop
//     AND mobile (Capacitor) webviews, so the same code signs requests on the iPad too.
//
// Auth (per MyScript docs): send the application key as-is in the `applicationKey` header, and an
// HMAC-SHA512 of the exact request body — keyed by (applicationKey + hmacKey) concatenated — in the
// `hmac` header. The response is JIIX JSON whose root `label` is the full recognized text.

import { requestUrl } from 'obsidian';
import { RecognitionStroke } from './recognize';

const BATCH_ENDPOINT = 'https://cloud.myscript.com/api/v4.0/iink/batch';

export interface MyScriptCredentials {
	applicationKey: string;
	hmacKey: string;
	language: string; // MyScript locale, e.g. "en_US"
}

export function hasMyScriptKeys(creds: MyScriptCredentials): boolean {
	return creds.applicationKey.trim().length > 0 && creds.hmacKey.trim().length > 0;
}

async function hmacSha512Hex(key: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-512' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// Recognize the given strokes as text. Throws with a readable message on auth/HTTP/parse failure so
// the caller can surface it in a Notice; returns '' for empty input.
export async function recognizeText(
	strokes: RecognitionStroke[],
	creds: MyScriptCredentials,
): Promise<string> {
	if (strokes.length === 0) {
		return '';
	}
	const body = JSON.stringify({
		contentType: 'Text',
		xDPI: 96,
		yDPI: 96,
		configuration: { lang: creds.language || 'en_US' },
		strokeGroups: [{ strokes }],
	});
	const hmac = await hmacSha512Hex(creds.applicationKey + creds.hmacKey, body);

	const response = await requestUrl({
		url: BATCH_ENDPOINT,
		method: 'POST',
		headers: {
			applicationKey: creds.applicationKey,
			hmac,
			'Content-Type': 'application/json',
			Accept: 'application/vnd.myscript.jiix,application/json',
		},
		body,
		throw: false,
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`MyScript ${response.status}: ${describeError(response.text)}`);
	}

	let jiix: unknown;
	try {
		jiix = JSON.parse(response.text);
	} catch {
		throw new Error('MyScript returned an unreadable response.');
	}
	const label = (jiix as { label?: unknown })?.label;
	return typeof label === 'string' ? label : '';
}

function describeError(text: string): string {
	if (!text) {
		return 'no details';
	}
	try {
		const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
		const message = parsed.message ?? parsed.error;
		if (typeof message === 'string' && message.length > 0) {
			return message;
		}
	} catch {
		// not JSON; fall through to the raw text
	}
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
