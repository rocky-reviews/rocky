import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * P6-8 (ADR 0032): the axe run every page and state must pass. axe's default rule set (WCAG 2.0,
 * 2.1 and 2.2 A/AA plus best practices) and, on top, `target-size` (WCAG 2.2 2.5.8, 24 px),
 * which axe ships switched off. Only "serious" and "critical" findings fail.
 */
export const seriousViolations = async (page: Page): Promise<string[]> => {
  const results = await new AxeBuilder({ page })
    .options({ rules: { "target-size": { enabled: true } } })
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
};
