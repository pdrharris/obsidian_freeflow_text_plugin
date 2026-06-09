// Bundles the TypeScript test suite with esbuild (already a dependency) and runs it in Node.
// Avoids adding a test framework; the suite reports its own pass/fail and exits non-zero on
// failure so `npm test` fails the build.

import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

const outfile = join(tmpdir(), `fii-ink-tests-${Date.now()}.mjs`);

await build({
	entryPoints: ['tests/ink.test.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	logLevel: 'warning',
});

try {
	await import(pathToFileURL(outfile).href);
} finally {
	try {
		rmSync(outfile);
	} catch {
		/* best-effort cleanup */
	}
}
