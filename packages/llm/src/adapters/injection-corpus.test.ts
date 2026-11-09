import {

  ASK_LABELS,
  MEMORY_CANARY_MARKER,
  memoryPart,
  rockyInstructions,
  selectMemory,
  systemPrompt,
  type ProviderCompletionCall,
} from "@rocky-reviews/core";
import { INJECTION_CORPUS } from "@rocky-reviews/evals";
import { describe, expect, it } from "vitest";
import { envSecrets } from "../registry.js";
import { providerAdapters } from "./index.js";
import { fakeFetch, json, sse, TEST_KEY, verdictSchema, type Verdict } from "./test-support.js";

/**
 * P4-4 (ADR 0015 §1, I7–I9): every payload of the injection corpus, sent through the real
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

/**
 * P8-2: project memory is a stored, untrusted channel back into the review prompt. Every corpus
 * payload, planted as an entry's text and path (skipping the pipeline's own re-check, which
 * would drop many of them), goes through both request builders as the memory part: it stays in
 * one delimited user part, never in the system text, and its chat-template tokens are broken.
 */
const memoryCall = (payload: string): ProviderCompletionCall<Verdict> => ({
  ...call("Retry helper"),
  untrusted: [
    { label: "file_path", text: "src/jobs/retry.ts" },
    { label: "diff", text: "+const RETRIES = 3;" },
    memoryPart(
      selectMemory(
        [
          {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "convention",
            origin: "learned",
            reason: null,
            severity: null,
            text: payload,
            path: "src/jobs/retry.ts",
            source: "convention · PR #1",
            confidence: 60,
          },
        ],
        "src/jobs/retry.ts",
      ),
    ),
  ],
});

describe.each(INJECTION_CORPUS)("corpus case $id as a memory entry on the wire", (c) => {
  it("Anthropic: the entry stays in the delimited memory part, never in the system text", async () => {
    const fake = fakeFetch(sse("end-turn.sse"));
    const provider = providerAdapters({ fetch: fake.fetch })["anthropic"]!(
      { kind: "anthropic", apiKeyEnv: "ROCKY_TEST_ANTHROPIC_KEY" },
      envSecrets({ ROCKY_TEST_ANTHROPIC_KEY: TEST_KEY }),
    );
    await provider.completeStructured!(memoryCall(c.payload));
    const body = fake.requests[0]!.body;
    const system = body["system"] as { text: string }[];
    expect(system.map((block) => block.text)).toEqual([SYSTEM]);
    const messages = body["messages"] as { role: string; content: { text: string }[] }[];
    const parts = messages[0]!.content.map((block) => block.text);
    const memory = parts.find((part) => part.includes('label="memory"'));
    expect(memory).toBeDefined();
    expect(memory).toContain(MEMORY_CANARY_MARKER);
    const id = /<pr_content id="([0-9a-f]{24})" label="memory">/.exec(memory!)?.[1];
    expect(id).toBeDefined();
    expect(memory!.endsWith(`</pr_content id="${id!}">`)).toBe(true);
    expect(memory!.split(`</pr_content id="${id!}">`)).toHaveLength(2);
    for (const part of parts.filter((p) => p !== memory)) expect(part).not.toContain(c.trigger);
  });

  it("OpenAI-compatible: the entry's chat-template tokens are broken, and the system text is core's", async () => {
    const fake = fakeFetch(json("openai-compatible/chat-stop.json"));
    const provider = providerAdapters({ fetch: fake.fetch })["openai-compatible"]!(
      { kind: "openai-compatible", baseUrl: "http://ollama:11434/v1/" },
      envSecrets({}),
    );
    await provider.completeStructured!(memoryCall(c.payload));
    const messages = fake.requests[0]!.body["messages"] as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0]!.content.startsWith(`${SYSTEM}\n\nOutput JSON schema:`)).toBe(true);
    expect(messages[0]!.content).not.toContain(c.trigger);
    expect(messages[1]!.content).not.toMatch(CHAT_TOKEN);
  });
});

/**
 * P9-3: Ask's three untrusted inputs (the question, the selected code and a code excerpt) go
 * through both request builders as the `ask` role sends them, each carrying a corpus payload:
 * the system text is exactly core's Ask instructions, the payload sits only in the delimited
 * user parts (one closing marker per part, with the call's id), no tool is sent, and
 * chat-template tokens are broken on the OpenAI-compatible wire.
 */
const askCall = (payload: string): ProviderCompletionCall<Verdict> => ({
  role: "ask",
  model: "claude-sonnet-5-5",
  platformModel: undefined,
  effort: undefined,
  instructions: ASK_INSTRUCTIONS,
  untrusted: [
    { label: ASK_LABELS.question, text: `${payload}\nIs the check safe?` },
    {
      label: ASK_LABELS.selection,
      text: `path: src/auth/password.ts\nlines: 15-21 (new side of the diff)\n${payload}`,
    },
    { label: ASK_LABELS.code, text: `path: src/auth/password.ts\nlines: 1-2\n1| // ${payload}\n2| x` },
  ],
  output: verdictSchema,
  maxOutputTokens: 6000,
});

const ASK_INSTRUCTIONS = rockyInstructions`You answer one question a reviewer asks about a pull request, from excerpts of the repository.`;
const ASK_SYSTEM = systemPrompt(ASK_INSTRUCTIONS);

describe.each(INJECTION_CORPUS)("corpus case $id in Ask's inputs on the wire", (c) => {
  it("Anthropic: no tools, Ask's system text, the payload in three delimited user parts", async () => {
    const fake = fakeFetch(sse("end-turn.sse"));
    const provider = providerAdapters({ fetch: fake.fetch })["anthropic"]!(
      { kind: "anthropic", apiKeyEnv: "ROCKY_TEST_ANTHROPIC_KEY" },
      envSecrets({ ROCKY_TEST_ANTHROPIC_KEY: TEST_KEY }),
    );
    await provider.completeStructured!(askCall(c.payload));
    const body = fake.requests[0]!.body;
    for (const absent of ["tools", "tool_choice"]) expect(body[absent]).toBeUndefined();
    const system = body["system"] as { text: string }[];
    expect(system.map((block) => block.text)).toEqual([ASK_SYSTEM]);
    expect(ASK_SYSTEM).not.toContain(c.trigger);
    const messages = body["messages"] as { role: string; content: { text: string }[] }[];
    expect(messages.map((m) => m.role)).toEqual(["user"]);
    const parts = messages[0]!.content.map((block) => block.text);
    expect(parts).toHaveLength(4);
    for (const part of parts.slice(0, 3)) {
      const id = /<pr_content id="([0-9a-f]{24})" label="(question|selection|code)">/.exec(part)?.[1];
      expect(id).toBeDefined();
      expect(c.payload).not.toContain(id!);
      expect(part.endsWith(`</pr_content id="${id!}">`)).toBe(true);
      expect(part.split(`</pr_content id="${id!}">`)).toHaveLength(2);
    }
  });

  it("OpenAI-compatible: no tools, Ask's system text, chat-template tokens broken", async () => {
    const fake = fakeFetch(json("openai-compatible/chat-stop.json"));
    const provider = providerAdapters({ fetch: fake.fetch })["openai-compatible"]!(
      { kind: "openai-compatible", baseUrl: "http://ollama:11434/v1/" },
      envSecrets({}),
    );
    await provider.completeStructured!(askCall(c.payload));
    const body = fake.requests[0]!.body;
    for (const absent of ["tools", "tool_choice", "functions"])
      expect(body[absent]).toBeUndefined();
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0]!.content.startsWith(`${ASK_SYSTEM}\n\nOutput JSON schema:`)).toBe(true);
    expect(messages[0]!.content).not.toContain(c.trigger);
    expect(messages[1]!.content).not.toMatch(CHAT_TOKEN);
    expect(messages[1]!.content.split('label="code">')).toHaveLength(2);
  });
});
