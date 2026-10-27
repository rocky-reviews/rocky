import { randomBytes } from "node:crypto";
import {
  FINAL_INSTRUCTION,
  isRockyInstructions,
  LlmCallError,
  systemPrompt,
  UNTRUSTED_PREAMBLE,
  type StructuredCompletionRequest,
} from "@rocky-reviews/core";

/**
 * Prompt layout shared by every adapter (P4-2, ADR 0013 §2; threat T6). Rocky's instructions go
 * in the system slot, behind a fixed preamble; PR content goes only in the user turn, each part
 * wrapped in a marker whose id is drawn per call, so a forged closing marker in a diff cannot end
 * the block. The preamble and final line are core's (`prompt.ts`, P4-4), so the leak guard checks
 * answers against exactly what was sent (ADR 0015).
 */

export { FINAL_INSTRUCTION, UNTRUSTED_PREAMBLE };

/**
 * Chat-template control tokens of open-weight model families (ChatML, Llama 3, gpt-oss harmony,
 * Phi, DeepSeek's fullwidth bars, Gemma turns, Mistral and Llama 2 markers, `</s>`). An
 * OpenAI-compatible server renders its chat template to text and tokenizes it with special tokens
 * parsed, so one of these in a diff would become a real turn boundary (ADR 0015 I7). The list is
 * best effort; the Claude APIs take structured turns and need none of this.
 */
const CHAT_TOKEN =
  /<\|[A-Za-z0-9_.:-]{1,40}\|>|<\uFF5C[^\uFF5C<>\s]{1,40}\uFF5C>|<(?:start_of_turn|end_of_turn)>|<\/s>|\[\/?(?:INST|SYSTEM_PROMPT|TOOL_CALLS|AVAILABLE_TOOLS|TOOL_RESULTS)\]|<<\/?SYS>>/gu;
/** Zero width space: splits a token for the tokenizer and stays visible to nobody. */
export const CHAT_TOKEN_BREAK = "\u200B";

/** Inserts `CHAT_TOKEN_BREAK` after the first character of every chat-template token. */
export const neutraliseChatTokens = (text: string): string =>
  text.replace(CHAT_TOKEN, (token) => `${token.slice(0, 1)}${CHAT_TOKEN_BREAK}${token.slice(1)}`);

/** Rocky-authored labels only (ADR 0012 N7): never a path, branch name or other PR text. */
const LABEL = /^[a-z][a-z0-9_.:-]{0,63}$/;
const MAX_DRAWS = 4;

/** 96 random bits, hex: unguessable by PR content. */
export const newNonce = (): string => randomBytes(12).toString("hex");

export interface Prompt {
  /** Preamble + instructions: the only cached block. */
  readonly system: string;
  /** One delimited block per untrusted part, in order. */
  readonly parts: readonly string[];
  readonly final: string;
}

export interface PromptOptions {
  /** Break chat-template tokens in PR content (OpenAI-compatible servers). */
  readonly neutraliseChatTokens?: boolean;
}

export const buildPrompt = (
  request: Pick<StructuredCompletionRequest<unknown>, "instructions" | "untrusted">,
  nonce: () => string,
  options: PromptOptions = {},
): Prompt => {
  // Only text a Rocky prompt module issued reaches the system slot (ADR 0012 §1, N4).
  if (!isRockyInstructions(request.instructions)) throw new LlmCallError("invalid_request");
  if (!request.untrusted.every((part) => LABEL.test(part.label))) {
    throw new LlmCallError("invalid_request");
  }
  // Content as it will be sent: the nonce must be absent from exactly this text.
  const parts = request.untrusted.map((part) =>
    options.neutraliseChatTokens === true
      ? { label: part.label, text: neutraliseChatTokens(part.text) }
      : part,
  );
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const id = nonce();
    if (parts.some((part) => part.text.includes(id))) continue;
    return {
      system: systemPrompt(request.instructions),
      parts: parts.map(
        (part) =>
          `<pr_content id="${id}" label="${part.label}">\n${part.text}\n</pr_content id="${id}">`,
      ),
      final: FINAL_INSTRUCTION,
    };
  }
  // Only reachable with a broken nonce source: fail closed rather than reuse a known id.
  throw new LlmCallError("invalid_request");
};

/** A positive whole number of tokens, checked before anything is sent. */
export const checkOutputCap = (maxOutputTokens: number): void => {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new LlmCallError("invalid_request");
  }
};
