#!/usr/bin/env node
// Retired: rewriting a published object in place breaks cached downloads and
// reproducibility. Schema-v2 export/migration normalizes legacy Metra seconds
// to milliseconds and creates immutable Parquet revisions instead.
console.error('Retired: use npm run migrate-positions for legacy archives. See docs/POSITIONS.md.');
process.exitCode = 1;
