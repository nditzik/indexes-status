// knn_parity_runner.mjs — Node-side half of the KNN parity test.
//
// Reads a spliced series JSON (produced by tests/knn_parity_test.py from
// the Python engine's own series builder), runs the BROWSER KNN engine
// (v2/patterns.js) on it, and prints the resulting matches as JSON.
//
// The Python test then compares these matches against the ones computed
// by scripts/update_forward_snapshots.py — same anchor, same series, two
// independent implementations. Any drift in features, normalization,
// weights, dedup or K shows up as a mismatch.
//
// Usage: node tests/knn_parity_runner.mjs <series.json>
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// patterns.js is a browser IIFE that attaches to `window` — shim it.
globalThis.window = globalThis;
const src = readFileSync(join(__dirname, '..', 'v2', 'patterns.js'), 'utf8');
(0, eval)(src);

const seriesPath = process.argv[2];
if (!seriesPath) {
    console.error('usage: node knn_parity_runner.mjs <series.json>');
    process.exit(2);
}
const series = JSON.parse(readFileSync(seriesPath, 'utf8'));

const analysis = window.Patterns.analyze(series, {
    k: 10,
    excludeRecent: 30,
    clusterDedup: 40,
});
if (analysis.error) {
    console.error('analyze error: ' + analysis.error);
    process.exit(1);
}
console.log(JSON.stringify({
    asOfDate: analysis.asOfDate,
    matches: analysis.matches.map(m => ({ date: m.date, distance: m.distance })),
}));
