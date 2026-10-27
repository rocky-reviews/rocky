import { describe, expect, it } from "vitest";
import { EXTERNAL_TENANT_STORES, nothingStoredYet, type OrgErasers } from "./erasure.js";
import type { OrgId } from "./ports.js";

describe("org erasure extension points (P3-3)", () => {
  it("names exactly the stores P5 (object storage) and P8 (embeddings) must plug into", () => {
    expect(EXTERNAL_TENANT_STORES).toEqual(["object_storage", "embeddings"]);
  });

  it("placeholders erase nothing, succeed, and say they are placeholders", async () => {
    const erasers: OrgErasers = {
      object_storage: nothingStoredYet("object_storage"),
      embeddings: nothingStoredYet("embeddings"),
    };
    for (const store of EXTERNAL_TENANT_STORES) {
      expect(erasers[store].store).toBe(store);
      expect(erasers[store].placeholder).toBe(true);
      await expect(
        erasers[store].eraseOrg("00000000-0000-4000-8000-000000000000" as OrgId),
      ).resolves.toBeUndefined();
    }
  });
});
