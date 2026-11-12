// Prints the coverage report: `npm run coverage`, or `npm run coverage -- --json` for a script to read.
import { coverageReport, formatCoverage } from '../src/data/coverage.ts';

const report = coverageReport();
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatCoverage(report));
