import { rockyInstructions, systemPrompt, type ProviderCompletionCall } from "@rocky-reviews/core";
import { INJECTION_CORPUS } from "@rocky-reviews/evals";
import { describe, expect, it } from "vitest";
import { envSecrets } from "../registry.js";
import { providerAdapters } from "./index.js";
import { fakeFetch, json, sse, TEST_KEY, verdictSchema, type Verdict } from "./test-support.js";

/**
 * P4-4 (ADR 0015 §1, T1–T4): every payload of the injection corpus, sent through the real
 * Anthropic and OpenAI-compatible request builders. Whatever the payload, the request carries no
 * tool, Rocky's system text is exactly core's, the payload sits only in the user turn, and each
 * part has exactly one closing marker with the call's id, at its end. On the OpenAI-compatible
 * wire, chat-template tokens are broken.
 */

const INSTRUCTIONS = rockyInstructions`You review pull requests. Report the verdict.`;
const SYSTEM = systemPrompt(INSTRUCTIONS);
const CHAT_TOKEN = /<\|[A-Za-z0-9_.:-]{1,40}\|>|\[\/?INST\]|<start_of_turn>|<<SYS>>/u;

const call = (text: string): ProviderCompletionCall<Verdict> => ({
  role: "review",
  model: "claude-opus-4-8",
  platformModel: undefined,
  effort: undefined,
  instructions: INSTRUCTIONS,
  untrusted: [
    { label: "pr_title", text },
    { label: "diff", text: `+// ${text}` },
  ],
  output: verdictSchema,
  maxOutputTokens: 8000,
});

const checkParts = (user: string, payload: string) => {
  const id = /<pr_content id="([0-9a-f]{24})" label="pr_title">/.exec(user)?.[1];
  expect(id).toBeDefined();
  expect(payload).not.toContain(id!);
  expect(user.split(`</pr_content id="${id!}">`)).toHaveLength(3);
  expect(user.split(`<pr_content id="${id!}"`)).toHaveLength(3);
};

describe.each(INJECTION_CORPUS)("corpus case $id on the wire", (c) => {
  it("Anthropic: no tools, core's system text, payload only in delimited user parts", async () => {
    const fake = fakeFetch(sse("end-turn.sse"));
    const provider = providerAdapters({ fetch: fake.fetch })["anthropic"]!(
      { kind: "anthropic", apiKeyEnv: "ROCKY_TEST_ANTHROPIC_KEY" },
      envSecrets({ ROCKY_TEST_ANTHROPIC_KEY: TEST_KEY }),
    );
    await provider.completeStructured!(call(c.payload));
    const body = fake.requests[0]!.body;
    for (const absent of ["tools", "tool_choice"]) expect(body[absent]).toBeUndefined();
    const system = body["system"] as { text: string }[];
    expect(system.map((block) => block.text)).toEqual([SYSTEM]);
    const messages = body["messages"] as { role: string; content: { text: string }[] }[];
    expect(messages.map((m) => m.role)).toEqual(["user"]);
    const parts = messages[0]!.content.map((block) => block.text);
    expect(parts).toHaveLength(3);
    for (const part of parts.slice(0, 2)) expect(part).toMatch(/<\/pr_content id="[0-9a-f]{24}">$/);
    checkParts(parts.join("\n"), c.payload);
  });

  it("OpenAI-compatible: no tools, core's system text, chat-template tokens broken", async () => {
    const fake = fakeFetch(json("openai-compatible/chat-stop.json"));
    const provider = providerAdapters({ fetch: fake.fetch })["openai-compatible"]!(
      { kind: "openai-compatible", baseUrl: "http://ollama:11434/v1/" },
      envSecrets({}),
    );
    await provider.completeStructured!(call(c.payload));
    const body = fake.requests[0]!.body;
    for (const absent of ["tools", "tool_choice", "functions"])
      expect(body[absent]).toBeUndefined();
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0]!.content.startsWith(`${SYSTEM}\n\nOutput JSON schema:`)).toBe(true);
    expect(messages[0]!.content).not.toContain(c.trigger);
    expect(messages[1]!.content).not.toMatch(CHAT_TOKEN);
    checkParts(messages[1]!.content, c.payload);
  });
});
