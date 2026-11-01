/**
 * H4-6 (ADR 0035): Flow playback's logic, apart from React. A flow becomes a sequence diagram:
 * one column per participant, one row per message. Playback steps through the messages: those
 * before the step have played, the one at it is playing, the rest are still to come. Step
 * `count` (one past the last message) is "fully played": every message shown, none playing.
 */
import type { Flow, Graph, MessageKind } from "@rocky-reviews/schema";

export type SequenceMessage = {
  id: string;
  label: string;
  kind: MessageKind;
  /** Column indexes; equal for a self message. */
  from: number;
  to: number;
  note: string | undefined;
};

export type Sequence = {
  participants: { node: string; label: string }[];
  messages: SequenceMessage[];
};

/**
 * The participants in the flow's order, named by their own label, else the node's, else the
 * id. A message whose ends are not both participants (integrity refuses it) is left out.
 */
export const sequenceOf = (flow: Flow, graph: Graph): Sequence => {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const participants = flow.participants.map((participant) => ({
    node: participant.node,
    label: participant.label ?? nodes.get(participant.node)?.label ?? participant.node,
  }));
  const column = new Map(participants.map((participant, index) => [participant.node, index]));
  const messages = flow.messages.flatMap((message): SequenceMessage[] => {
    const from = column.get(message.from);
    const to = column.get(message.to);
    if (from === undefined || to === undefined) return [];
    return [
      { id: message.id, label: message.label, kind: message.kind, from, to, note: message.note },
    ];
  });
  return { participants, messages };
};

export type MessageState = "past" | "active" | "future";

export const messageState = (index: number, step: number): MessageState =>
  index < step ? "past" : index === step ? "active" : "future";

/** Where playback opens: at the first message, or fully played when motion is reduced. */
export const openingStep = (count: number, reducedMotion: boolean): number =>
  reducedMotion ? count : 0;

export const clampStep = (step: number, count: number): number =>
  Math.max(0, Math.min(count, step));

/** The columns lit while a step plays: its message's two ends. */
export const activeColumns = (sequence: Sequence, step: number): ReadonlySet<number> => {
  const message = sequence.messages[step];
  return new Set(message === undefined ? [] : [message.from, message.to]);
};
