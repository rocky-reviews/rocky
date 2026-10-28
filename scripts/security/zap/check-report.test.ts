/**
 * P7-3 (ADR 0025), review round 1: the ZAP gate. `check-report.mjs` fails on any High or Medium
 * alert whatever `rules.tsv` says, and fails closed on a report it cannot use.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./check-report.mjs", import.meta.url));
const RULES = fileURLToPath(new URL("./rules.tsv", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "rocky-zap-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const check = (report: unknown) => {
  const path = join(dir, `report-${(n += 1)}.json`);
  writeFileSync(path, typeof report === "string" ? report : JSON.stringify(report));
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: "utf8" });
};

const alert = (pluginid: string, riskcode: string) => ({ pluginid, riskcode, alert: "Planted" });
const site = (alerts: unknown[]) => ({ site: [{ alerts }] });

/** Plugin ids rules.tsv accepts (IGNORE). */
const ignored = readFileSync(RULES, "utf8")
  .split("\n")
  .filter((line) => !line.startsWith("#") && line.split("\t")[1] === "IGNORE")
  .map((line) => line.split("\t")[0] ?? "");

describe("check-report.mjs", () => {
  it("passes Low and Informational alerts only", () => {
    const res = check(site([alert("10096", "1"), alert("10049", "0")]));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("High 0, Medium 0, Low 1, Informational 1");
  });

  it("a Medium alert under a rule rules.tsv IGNOREs still fails", () => {
    expect(ignored.length).toBeGreaterThan(0);
    for (const id of ignored) {
      expect(check(site([alert(id, "2")])).status, id).toBe(1);
      expect(check(site([alert(id, "3")])).status, id).toBe(1);
    }
  });

  it("an unknown risk counts as High", () => {
    expect(check(site([alert("1", "7")])).status).toBe(1);
  });

  it("fails closed on an unreadable or empty report", () => {
    expect(check("not json").status).toBe(2);
    expect(check({ site: [] }).status).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status).toBe(2);
  });
});
