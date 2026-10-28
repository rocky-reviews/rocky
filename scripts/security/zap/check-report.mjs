// Reads a ZAP JSON report (zap-baseline.py -J) and fails on any High or Medium alert, whatever
// the rules file says (P7-3, ADR 0025): the rules file may accept Low and Informational alerts
// only. Prints counts per risk and the alert names, never request or response content.
//
//   node scripts/security/zap/check-report.mjs artifacts/zap/report.json
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: check-report.mjs <report.json>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch {
  console.error(`zap: cannot read the report at ${path} (fail closed)`);
  process.exit(2);
}

const RISKS = { 3: "High", 2: "Medium", 1: "Low", 0: "Informational" };
const counts = { High: 0, Medium: 0, Low: 0, Informational: 0 };
const names = new Map();
const sites = Array.isArray(report?.site) ? report.site : [];
if (sites.length === 0) {
  console.error("zap: the report has no site: the scan reached nothing (fail closed)");
  process.exit(2);
}
for (const site of sites) {
  for (const alert of Array.isArray(site?.alerts) ? site.alerts : []) {
    const risk = RISKS[Number(alert?.riskcode)] ?? "High";
    counts[risk] += 1;
    names.set(`${risk}\t${alert?.pluginid ?? "?"}\t${alert?.alert ?? alert?.name ?? "?"}`, true);
  }
}

console.log(
  `zap: High ${counts.High}, Medium ${counts.Medium}, Low ${counts.Low}, Informational ${counts.Informational}`,
);
for (const line of [...names.keys()].sort()) console.log(`  ${line}`);
process.exit(counts.High + counts.Medium === 0 ? 0 : 1);
