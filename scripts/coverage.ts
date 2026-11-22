// Prints the coverage report: `npm run coverage`, or for a script to read, `npm run --silent coverage -- --json`
// (--silent keeps npm's banner out of stdout, so the output is only the JSON).
import { coverageReport, formatCoverage } from '../src/data/coverage.ts';

const report = coverageReport();
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatCoverage(report));
