import { BaseAnthropic } from "@anthropic-ai/sdk/client";
import { describe, expect, it } from "vitest";

/**
 * The four Anthropic packages must move together (ADR 0013, amendment "1.x SDKs"). A platform SDK
 * bumped on its own resolves its own copy of `@anthropic-ai/sdk`, whose `APIError` is a different
 * class: `toCallError` then maps every provider failure, a 400 or 401 included, to the retryable
 * `server_error`. The status errors come from the base client (`makeStatusError`), so one base
 * class across the four packages means one `APIError` class.
 */
describe("the platform SDKs share one @anthropic-ai/sdk instance", () => {
  it("builds every platform client on the base client this package imports", async () => {
    const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
    const { AnthropicVertex, BaseAnthropic: VertexBase } = await import("@anthropic-ai/vertex-sdk");
    const { AnthropicFoundry, BaseAnthropic: FoundryBase } =
      await import("@anthropic-ai/foundry-sdk");
    expect(VertexBase).toBe(BaseAnthropic);
    expect(FoundryBase).toBe(BaseAnthropic);
    for (const client of [AnthropicBedrockMantle, AnthropicVertex, AnthropicFoundry]) {
      expect(client.prototype instanceof BaseAnthropic, client.name).toBe(true);
    }
  });
});
