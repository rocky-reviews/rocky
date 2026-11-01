import { describe, expect, it } from "vitest";
import {
  activeColumns,
  clampStep,
  messageState,
  openingStep,
  sequenceOf,
} from "./flow-playback.js";
import { pr847Graph } from "./test-graph.js";

const flow = () => {
  const graph = pr847Graph();
  const first = graph.flows[0];
  if (first === undefined) throw new Error("pr-847 has a flow");
  return { graph, flow: first };
};

describe("sequenceOf", () => {
  it("names the columns by participant label, then node label", () => {
    const { graph, flow: f } = flow();
    const sequence = sequenceOf(f, graph);
    expect(sequence.participants.map((p) => p.label)).toEqual([
      "InvitePage",
      "routes",
      "acceptInvitation()",
      "invitations",
      "memberships",
    ]);
    expect(sequence.messages.map((m) => [m.from, m.to])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [2, 4],
    ]);
    expect(sequence.messages[3]?.note).toMatch(/finding F1/);
  });

  it("leaves out a message whose ends are not participants", () => {
    const { graph, flow: f } = flow();
    const broken = {
      ...f,
      messages: [...f.messages, { ...f.messages[0]!, id: "x", to: "nowhere" }],
    };
    expect(sequenceOf(broken, graph).messages).toHaveLength(4);
  });
});

describe("playback steps", () => {
  it("marks messages before the step played, at it playing, after it to come", () => {
    expect([0, 1, 2, 3].map((index) => messageState(index, 1))).toEqual([
      "past",
      "active",
      "future",
      "future",
    ]);
    // Fully played: every message has played.
    expect([0, 1, 2, 3].map((index) => messageState(index, 4))).toEqual([
      "past",
      "past",
      "past",
      "past",
    ]);
  });

  it("opens at the first message, or fully played with reduced motion", () => {
    expect(openingStep(4, false)).toBe(0);
    expect(openingStep(4, true)).toBe(4);
  });

  it("steps inside the flow, up to fully played", () => {
    expect(clampStep(-1, 4)).toBe(0);
    expect(clampStep(5, 4)).toBe(4);
    expect(clampStep(2, 4)).toBe(2);
  });

  it("lights the playing message's two columns, and none once played", () => {
    const { graph, flow: f } = flow();
    const sequence = sequenceOf(f, graph);
    expect([...activeColumns(sequence, 3)]).toEqual([2, 4]);
    expect(activeColumns(sequence, 4).size).toBe(0);
  });
});
