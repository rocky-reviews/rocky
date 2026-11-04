import { seriousViolations } from "./axe.js";
import { MODES, openShell, WIDTHS } from "./support.js";
import { expect, type Page, test } from "./test.js";

/**
 * H4-12: the change tree modal. The sidebar's Tree button, `t` and the briefing's "View as
 * tree" each open it; Escape closes it and returns focus to the opener; a file clicked in it
 * opens in the diff and moves focus to the main column; at 375 px it opens from the Files
 * drawer, fits the width and closes back into the drawer; axe finds nothing serious with it
 * open; `t` does nothing while typing.
 */

const dialog = (page: Page) => page.getByRole("dialog", { name: "Change tree" });
const treeButton = (page: Page) =>
  page.locator("#sidebar").getByRole("button", { name: "Change Tree" });
const ready = (page: Page) => page.locator("#review-panel .tally").waitFor({ state: "attached" });

const open = async (page: Page) => {
  await openShell(page);
  await ready(page);
};

test("the sidebar's Tree button opens the tree; Escape returns focus to it", async ({ page }) => {
  await open(page);
  await treeButton(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
  await expect(dialog(page).getByRole("button", { name: "Close" })).toBeFocused();
  await expect(dialog(page)).toContainText("9 files in 5 folders · 4 to read carefully");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(treeButton(page)).toBeFocused();
});

test("t opens the tree, Tab stays inside, Escape goes back", async ({ page }) => {
  await open(page);
  await page.keyboard.press("t");
  await expect(dialog(page)).toBeVisible();
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("#change-tree-dialog")),
    ).toBe(true);
  }
  // Other shortcuts do nothing behind the modal.
  await page.keyboard.press("k");
  await expect(page.locator("#file-title")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("#main")).toBeFocused();
});

test("the briefing's View as tree opens the tree and Escape returns to it", async ({ page }) => {
  await open(page);
  const link = page.getByRole("button", { name: "View as tree" });
  await link.click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
});

test("a click outside closes the tree", async ({ page }) => {
  await open(page);
  await page.keyboard.press("t");
  await page.mouse.click(5, 5);
  await expect(dialog(page)).toHaveCount(0);
});

test("the tree's folders are disclosure buttons, and folded files unfold in place", async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press("t");
  const db = dialog(page).getByRole("button", { name: /^db\/migrations\// });
  await expect(db).toHaveAttribute("aria-expanded", "false");
  const migration = dialog(page).getByRole("button", {
    name: "Open db/migrations/20261020_add_invitations.sql (critical)",
  });
  await expect(migration).toBeHidden();
  await db.press("Enter");
  await expect(db).toHaveAttribute("aria-expanded", "true");
  await expect(migration).toBeVisible();

  const more = dialog(page).getByRole("button", { name: "+ 1 more file (1 test)" });
  await more.press("Enter");
  const test = dialog(page).getByRole("button", {
    name: "Open src/auth/invitations.test.ts (normal)",
  });
  await expect(test).toBeFocused();

  const ignored = dialog(page).getByRole("button", { name: /^Ignored/ });
  await expect(ignored).toHaveAttribute("aria-expanded", "false");
  await ignored.click();
  await expect(
    dialog(page).getByRole("button", { name: "Open pnpm-lock.yaml (ignore)" }),
  ).toBeVisible();
});

test("clicking a file opens it in the diff, closes the tree and focuses the main column", async ({
  page,
}) => {
  await open(page);
  await treeButton(page).click();
  await dialog(page)
    .getByRole("button", { name: "Open src/jobs/sendInviteEmail.ts (important)" })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("#file-title")).toHaveText("src/jobs/sendInviteEmail.ts");
  await expect(page.locator("#main")).toBeFocused();
  // Open again: the file on screen is highlighted.
  await page.keyboard.press("t");
  await expect(
    dialog(page).getByRole("button", { name: "Open src/jobs/sendInviteEmail.ts (important)" }),
  ).toHaveAttribute("aria-current", "true");
});

test("t types in a comment box instead of opening the tree", async ({ page }) => {
  await open(page);
  await page.keyboard.press("k");
  await expect(page.locator("#file-title")).toHaveText("src/auth/invitations.ts");
  await page.getByRole("button", { name: "Comment on line 10", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Your comment on line 10" });
  await expect(box).toBeFocused();
  await page.keyboard.type("tT");
  await expect(box).toHaveValue("tT");
  await expect(dialog(page)).toHaveCount(0);
});

test("the help lists t", async ({ page }) => {
  await open(page);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText(
    "Change tree: what changed where",
  );
});

test("at 375 px it opens from the Files drawer, fits the width and closes back into it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await treeButton(page).click();
  await expect(dialog(page)).toBeVisible();
  const box = await dialog(page).boundingBox();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
  const overflow = await page.evaluate(() => {
    const el = document.getElementById("change-tree-dialog");
    return el === null ? -1 : el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBe(0);
  // Escape closes only the tree; the drawer stays, focus back on its Tree button.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(treeButton(page)).toBeFocused();

  // A file from the tree closes both and opens the file.
  await treeButton(page).click();
  await dialog(page)
    .getByRole("button", { name: "Open src/auth/invitations.ts (critical)" })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(page.locator("#file-title")).toHaveText("src/auth/invitations.ts");
  await expect(page.locator("#main")).toBeFocused();
});

for (const size of WIDTHS) {
  for (const mode of MODES) {
    test(`no serious axe issues with the tree open (${size.width} px, ${mode})`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: mode });
      await open(page);
      await page.keyboard.press("t");
      // Everything shown: every folder expanded, the folded files and the ignored files listed.
      for (;;) {
        const closed = dialog(page).locator('.ct-toggle[aria-expanded="false"]');
        if ((await closed.count()) === 0) break;
        await closed.first().click();
      }
      for (;;) {
        const more = dialog(page).locator(".ct-more-btn");
        if ((await more.count()) === 0) break;
        await more.first().click();
      }
      expect(await seriousViolations(page)).toEqual([]);
    });
  }
}
