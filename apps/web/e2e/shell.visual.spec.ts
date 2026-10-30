import { expect, type Page, test } from "./test.js";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MODES, openShell, settle, WIDTHS } from "./support.js";

/**
 * P6-1 acceptance: the shell at 375/1024/1440 px x light/dark, against the POC's landing state
 * (docs/design/poc/01-briefing-*). Each state is a baseline in e2e/__screenshots__/ and a copy
 * in artifacts/screenshots/P6-1/; `compare/` puts the POC and the app side by side.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots/P6-1");
const POC = join(ROOT, "docs/design/poc");

type State = {
  id: string;
  /** Only at widths where the state exists (a drawer exists only where its panel is hidden). */
  widths: readonly number[];
  run: (page: Page) => Promise<void>;
};

const STATES: State[] = [
  { id: "pr-shell", widths: [375, 1024, 1440], run: async () => {} },
  {
    id: "pr-files-drawer",
    widths: [375],
    run: async (page) => {
      await page.getByRole("button", { name: "Files", exact: true }).click();
    },
  },
  {
    id: "pr-panel-drawer",
    widths: [375, 1024],
    run: async (page) => {
      await page.getByRole("button", { name: "Review panel", exact: true }).click();
    },
  },
];

/** The POC and the app next to each other, labelled, at the same viewport size. */
const sideBySide = async (
  page: Page,
  poc: Buffer,
  app: Buffer,
  size: { width: number; height: number },
  title: string,
) => {
  const img = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
  // Both at their native size: two viewports plus the gutters.
  await page.setViewportSize({ width: size.width * 2 + 40, height: size.height + 60 });
  await page.setContent(`<!doctype html><body style="margin:0;font:14px system-ui">
    <div style="display:flex;gap:16px;padding:12px;align-items:flex-start">
      <figure style="margin:0;flex:1"><figcaption>POC · ${title}</figcaption>
        <img src="${img(poc)}" style="width:100%;outline:1px solid"></figure>
      <figure style="margin:0;flex:1"><figcaption>App · ${title}</figcaption>
        <img src="${img(app)}" style="width:100%;outline:1px solid"></figure>
    </div></body>`);
};

for (const state of STATES) {
  for (const size of WIDTHS.filter((w) => state.widths.includes(w.width))) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openShell(page);
        await settle(page);
        await state.run(page);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

        await expect(page).toHaveScreenshot(`${name}.png`);
        await mkdir(join(OUT, "compare"), { recursive: true });
        const app = await page.screenshot({ path: join(OUT, `${name}.png`) });

        if (state.id === "pr-shell") {
          const poc = await readFile(join(POC, `01-briefing-${size.width}-${mode}.png`));
          await sideBySide(page, poc, app, size, `${size.width} px ${mode}`);
          await page.screenshot({ path: join(OUT, "compare", `${name}.png`), fullPage: true });
        }
      });
    }
  }
}
