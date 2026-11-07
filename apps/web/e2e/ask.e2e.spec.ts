import { ask, openAsk, questionBox, selectDiffRows, showAskTab } from "./ask-support.js";
import { seriousViolations } from "./axe.js";
import { mockPullApi, openRealPr } from "./real-pr-support.js";
import { CSRF_TOKEN } from "./review-api.js";
import { MODES, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * P9-2: the Ask tab. Questions go out with Enter, the button or a suggestion; an answer's
 * citations are links to the cited lines at the indexed commit; `/` opens Ask with the code
 * selected in the diff; every index and answer state says what it is. The fixture source
 * (`?ask=<scenario>`) drives the states; the server's endpoint (mocked here, tested on Postgres
 * in apps/server/src/ask/routes.db.test.ts) carries the selection and the CSRF token.
 */

const SHA = "5e0c8a9d27f14b6e93a1c4d8f0b2e7a6c3d9f141";
const answers = (page: Page) => page.locator(".chat-a:not(.typing)");

test.describe("asking", () => {
  test("Enter asks; the answer links each cited range at the indexed commit", async ({ page }) => {
    await openAsk(page);
    await showAskTab(page);
    await expect(page.getByText("Code indexed at 5e0c8a9")).toBeVisible();
    await ask(page, "What does an attacker need to exploit F1?");
    await expect(page.getByRole("status").filter({ hasText: "Reading the code" })).toBeVisible();
    await expect(questionBox(page)).toHaveValue("");
    const link = page.getByRole("link", { name: /src\/auth\/invitations\.ts:28/ });
    await expect(link).toHaveAttribute(
      "href",
      `https://github.com/acme/rocky-app/blob/${SHA}/src/auth/invitations.ts#L28`,
    );
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAccessibleName(
      "src/auth/invitations.ts:28 (opens on GitHub in a new tab)",
    );
  });

  test("the Ask button and a suggestion ask too; Shift+Enter adds a line", async ({ page }) => {
    await openAsk(page);
    await showAskTab(page);
    const box = questionBox(page);
    await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeDisabled();
    await box.fill("Who calls acceptInvitation?");
    await box.press("Shift+Enter");
    await expect(box).toHaveValue("Who calls acceptInvitation?\n");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(answers(page)).toHaveCount(1);
    await expect(page.getByRole("link", { name: /routes\/invitations\.ts:18–24/ })).toHaveAttribute(
      "href",
      `https://github.com/acme/rocky-app/blob/${SHA}/src/api/routes/invitations.ts#L18-L24`,
    );
    await page.getByRole("button", { name: "Is this change covered by tests?" }).click();
    await expect(answers(page)).toHaveCount(2);
    await expect(page.getByRole("link", { name: /invitations\.test\.ts:12–40/ })).toBeVisible();
  });

  test("Escape leaves the box, so the single-key shortcuts work again", async ({ page }) => {
    await openAsk(page);
    await showAskTab(page);
    await questionBox(page).focus();
    await page.keyboard.press("Escape");
    await expect(questionBox(page)).not.toBeFocused();
  });
});

test.describe("/ with code selected in the diff", () => {
  for (const size of WIDTHS) {
    test(`attaches the selection and focuses the box at ${size.width} px`, async ({ page }) => {
      await page.setViewportSize(size);
      await openAsk(page);
      const { start, end } = await selectDiffRows(page, "src/auth/invitations.ts");
      await page.keyboard.press("/");
      await expect(page.getByRole("tab", { name: "Ask" })).toHaveAttribute("aria-selected", "true");
      await expect(questionBox(page)).toBeFocused();
      await expect(page.locator(".ask-selection")).toContainText(
        `src/auth/invitations.ts:${start}–${end}`,
      );
      await page.getByRole("button", { name: "Remove the selected code" }).click();
      await expect(page.locator(".ask-selection")).toHaveCount(0);
    });
  }

  test("without a selection, / opens Ask with nothing attached", async ({ page }) => {
    await openAsk(page);
    await page.keyboard.press("/");
    await expect(questionBox(page)).toBeFocused();
    await expect(page.locator(".ask-selection")).toHaveCount(0);
  });
});

test.describe("every state says what it is", () => {
  const states: [string, RegExp][] = [
    ["not-indexed", /Not indexed yet/],
    ["indexing", /Indexing/],
    ["off", /Ask is off/],
    ["index-error", /Try again/],
  ];
  for (const [scenario, text] of states) {
    test(`${scenario}: a banner, and the box takes no question`, async ({ page }) => {
      await openAsk(page, scenario);
      await showAskTab(page);
      await expect(page.locator(".ask-banner")).toContainText(text);
      await expect(questionBox(page)).toBeDisabled();
    });
  }

  test("no good answer: says so, with the model's note, and no link", async ({ page }) => {
    await openAsk(page, "no-answer");
    await showAskTab(page);
    await ask(page, "Where are invitations emailed?");
    await expect(page.locator(".chat-a.no-answer")).toContainText("the mailer is not in");
    await expect(page.locator(".chat-a a")).toHaveCount(0);
  });

  test("error: an alert with Try again, which asks again", async ({ page }) => {
    await openAsk(page, "error");
    await showAskTab(page);
    await ask(page, "Who calls acceptInvitation?");
    const alert = page.locator(".chat-a.ask-error");
    await expect(alert).toHaveAttribute("role", "alert");
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Reading the code" })).toBeVisible();
    await expect(page.locator(".chat-a.ask-error")).toHaveCount(1);
  });

  for (const size of WIDTHS) {
    for (const mode of MODES) {
      test(`axe: no serious issues in the Ask states at ${size.width} px ${mode}`, async ({
        page,
      }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode });
        const found: Record<string, string[]> = {};
        for (const scenario of ["ready", "not-indexed", "no-answer", "error"]) {
          await openAsk(page, scenario);
          await showAskTab(page);
          if (scenario !== "not-indexed") {
            await ask(page, "What does an attacker need to exploit F1?");
            await answers(page).first().waitFor();
          } else await page.locator(".ask-banner").waitFor();
          const violations = await seriousViolations(page);
          if (violations.length > 0) found[scenario] = violations;
        }
        expect(found).toEqual({});
      });
    }
  }
});

test.describe("from the server", () => {
  test("sends the question and the selection with the CSRF token", async ({ page }) => {
    await mockPullApi(page);
    const sent: { csrf: string | undefined; body: unknown }[] = [];
    await page.route("**/api/repos/acme/rocky-app/pulls/847/ask", async (route) => {
      const request = route.request();
      if (request.method() === "GET")
        return route.fulfill({
          status: 200,
          json: { index: { status: "ready", indexedSha: SHA, updating: false } },
        });
      sent.push({ csrf: request.headers()["x-rocky-csrf"], body: request.postDataJSON() });
      return route.fulfill({
        status: 200,
        json: {
          status: "answered",
          answer: "Only the accept route calls it.",
          indexedSha: SHA,
          citations: [
            { path: "src/api/routes/invitations.ts", startLine: 18, endLine: 24 },
            { path: "../../etc/passwd", startLine: 1, endLine: 1 },
          ],
        },
      });
    });
    await openRealPr(page);
    const { start, end } = await selectDiffRows(page, "src/auth/invitations.ts", 2);
    await page.keyboard.press("/");
    await expect(questionBox(page)).toBeFocused();
    await page.keyboard.type("Who calls this?");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Only the accept route calls it.")).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.csrf).toBe(CSRF_TOKEN);
    expect(sent[0]?.body).toMatchObject({
      question: "Who calls this?",
      selection: { path: "src/auth/invitations.ts", startLine: start, endLine: end },
    });
    // The citation the page cannot link safely is not shown.
    await expect(page.locator(".ask-cites a")).toHaveCount(1);
  });
});
