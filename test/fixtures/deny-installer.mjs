// Deliberate installer trap: only writes inside the disposable fixture and never invokes a package manager.
import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\n");
process.stderr.write("Fixture denied package-manager execution.\n");
process.exitCode = 19;
