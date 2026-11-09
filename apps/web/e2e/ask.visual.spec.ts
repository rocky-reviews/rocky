import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ask, openAsk, questionBox, selectDiffRows, showAskTab } from "./ask-support.js";
import { MODES, settle, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * P9-2: the Ask tab in every state at 375/1024/1440 px x light/dark, against the POC's Ask
 * (docs/design/poc/08-ask-*). Baselines in e2e/__screenshots__/, copies in
 * artifacts/screenshots/P9-2/, and `compare/` puts the POC and the app side by side.
 * P9-3's rate-limit states have no POC: their copies go to artifacts/screenshots/P9-3/ alone.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, "artifacts/screenshots");
const POC = join(ROOT, "docs/design/poc/08-ask");

type State = {
  id: string;
  scenario?: string;
  /** Whose copies these are; only P9-2's states are put beside the POC. */
  task?: "P9-3";
  run: (page: Page) => Promise<void>;
};

const ready = async (page: Page) => {
  await showAskTab(page);
  await expect(questionBox(page)).toBeEnabled();
};

const answered = async (page: Page, question: string) => {
  await ready(page);
  await ask(page, question);
  await page.locator(".ask-cites").last().waitFor();
};

const STATES: State[] = [
  { id: "ask-ready", run: ready },
  {
    id: "ask-answer",
    run: (page) => answered(page, "What does an attacker need to exploit F1?"),
  },
  {
    id: "ask-answers",
    run: async (page) => {
      await answered(page, "Who calls acceptInvitation?");
      await ask(page, "Is this covered by tests?");
      await expect(page.locator(".ask-cites")).toHaveCount(2);
    },
  },
  {
    id: "ask-answering",
    scenario: "slow",
    run: async (page) => {
      await ready(page);
      await ask(page, "Who calls acceptInvitation?");
      await page.getByRole("status").filter({ hasText: "Reading the code" }).waitFor();
    },
  },
  {
    id: "ask-no-answer",
    scenario: "no-answer",
    run: async (page) => {
      await ready(page);
      await ask(page, "Where are invitations emailed?");
      await page.locator(".chat-a.no-answer").waitFor();
    },
  },
  {
    id: "ask-error",
    scenario: "error",
    run: async (page) => {
      await ready(page);
      await ask(page, "Who calls acceptInvitation?");
      await page.locator(".chat-a.ask-error").waitFor();
    },
  },
  {
    id: "ask-rate-limited",
    scenario: "rate-limited",
    task: "P9-3",
    run: async (page) => {
      await ready(page);
      await ask(page, "Who calls acceptInvitation?");
      await page.locator(".chat-a.ask-error").waitFor();
    },
  },
  {
    id: "ask-org-limited",
    scenario: "org-rate-limited",
    task: "P9-3",
    run: async (page) => {
      await ready(page);
      await ask(page, "Who calls acceptInvitation?");
      await page.locator(".chat-a.ask-error").waitFor();
    },
  },
  {
    id: "ask-selection",
    run: async (page) => {
      await selectDiffRows(page, "src/auth/invitations.ts");
      await page.keyboard.press("/");
      await page.locator(".ask-selection").waitFor();
      await expect(questionBox(page)).toBeFocused();
    },
  },
  {
    id: "ask-not-indexed",
    scenario: "not-indexed",
    run: async (page) => {
      await showAskTab(page);
      await page.locator(".ask-banner").waitFor();
    },
  },
  {
    id: "ask-indexing",
    scenario: "indexing",
    run: async (page) => {
      await showAskTab(page);
      await page.locator(".ask-banner").waitFor();
    },
  },
  {
    id: "ask-off",
    scenario: "off",
    run: async (page) => {
      await showAskTab(page);
      await page.locator(".ask-banner").waitFor();
    },
  },
  {
    id: "ask-index-error",
    scenario: "index-error",
    run: async (page) => {
      await showAskTab(page);
      await page.getByRole("alert").filter({ hasText: "Try again" }).waitFor();
    },
  },
];

const sideBySide = async (
  page: Page,
  poc: Buffer,
  app: Buffer,
  size: { width: number; height: number },
  title: string,
) => {
  const img = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
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
  for (const size of WIDTHS) {
    for (const mode of MODES) {
      const name = `${state.id}-${size.width}-${mode}`;
      test(name, async ({ page }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        await openAsk(page, state.scenario);
        await settle(page);
        await state.run(page);
        await page.mouse.move(0, 0);
        await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

        await expect(page).toHaveScreenshot(`${name}.png`);
        const out = join(OUT, state.task ?? "P9-2");
        await mkdir(out, { recursive: true });
        const app = await page.screenshot({ path: join(out, `${name}.png`) });
        if (state.task !== undefined) return;
        await mkdir(join(out, "compare"), { recursive: true });
        const poc = await readFile(`${POC}-${size.width}-${mode}.png`);
        await sideBySide(page, poc, app, size, `${size.width} px ${mode}`);
        await page.screenshot({ path: join(out, "compare", `${name}.png`), fullPage: true });
      });
    }
  }
}
