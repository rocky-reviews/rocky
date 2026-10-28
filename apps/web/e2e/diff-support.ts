import type { Page } from "@playwright/test";

/** Opens a file from the sidebar (from the Files drawer below 760 px). P6-3. */
export const openFile = async (
  page: Page,
  path: string,
  options: { noise?: boolean } = {},
): Promise<void> => {
  const width = page.viewportSize()?.width ?? 1440;
  if (width <= 760) await page.getByRole("button", { name: "Files", exact: true }).click();
  if (options.noise === true)
    await page.locator("#sidebar").getByRole("button", { name: "Show" }).click();
  await page.locator(`#sidebar button.nav-file[title="${path}"]`).click();
  await page.locator(".file-head").waitFor();
  if (options.noise !== true) await page.locator(".diff .ln").first().waitFor();
};
