// Shared Anthropic client + model constants.
// Model choice is per-job, not per-price. These are separate knobs that happen
// to hold the same value today; see AGENTS.md for why scoring left Haiku.

import Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  /**
   * Fit scoring — a calibrated 0-100 judgement, not a classification. Haiku 4.5
   * emitted a band label wearing a 0-100 costume (8 values covered 82% of 578
   * stored scores), which left the queue with no ordering resolution.
   */
  scoring: "claude-sonnet-5",
  /** Resume tailoring — quality generation, best cost/quality on text. */
  tailoring: "claude-sonnet-5",
} as const;

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — copy .env.local.example to .env.local and fill it in.",
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

/** Pull the concatenated text out of a Messages response. */
export function textOf(msg: { content: Array<{ type: string }> }): string {
  return (msg.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}
