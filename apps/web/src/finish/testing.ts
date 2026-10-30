/**
 * Test helpers for Finish review (P6-6): an in-memory `ReviewPostingSource` with a fixed
 * preview and recorded clicks. Not imported by the app.
 */
import type { Answer, ReviewPostingSource, SubmitInput } from "../data/posting-data.js";

export const memoryPostingSource = (
  options: { preview?: unknown; submit?: (input: SubmitInput) => Answer } = {},
): ReviewPostingSource & { readonly clicks: SubmitInput[] } => {
  const clicks: SubmitInput[] = [];
  return {
    clicks,
    preview: async () => ({
      status: 200,
      body: options.preview ?? {
        pullRequestId: "00000000-0000-4000-8001-000000000847",
        number: 847,
        headSha: "9b4e1d7a3c5f2e8b6d0a4c7e1f3b5d9a2c6e8f4b",
        revisionKnown: true,
        contentSha256: "0".repeat(64),
        items: [],
        inFlight: null,
        latestSubmission: null,
      },
    }),
    submit: async (_pullRequestId, input) => {
      clicks.push(input);
      return (
        options.submit?.(input) ?? {
          status: 200,
          body: {
            status: "posted",
            submissionId: "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c",
            reviewId: 1,
            repeated: false,
          },
        }
      );
    },
  };
};
