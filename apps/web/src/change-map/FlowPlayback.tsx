/**
 * H4-6 (ADR 0035), Flow playback: the document's flows as sequence diagrams, played message by
 * message. One column per participant with its lifeline, one row per message. Messages that
 * have played stay, the playing one is lit (a token travels along it, its two column heads light
 * up), the rest are ghosted. A flow picker, a step timeline, Back, Play and Next move through
 * it. With reduced motion it opens fully played, with no Play and no token.
 *
 * Drawn as HTML (a CSS grid), not by the renderer: every label is a React text child, which
 * React escapes, inside a <bdi>. A column head whose node backs a PR file opens it, like a card.
 */
import type { AnalysisDocument, Flow } from "@rocky-reviews/schema";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import {
  activeColumns,
  clampStep,
  messageState,
  openingStep,
  sequenceOf,
} from "./flow-playback.js";
import { type OpenFile, useMapClicks, useStepTimer } from "./map-parts.js";

/** How long each message plays. */
export const MESSAGE_MS = 1600;

type Props = {
  doc: AnalysisDocument;
  flows: readonly Flow[];
  onOpenFile: OpenFile;
  reducedMotion: boolean;
};

export const FlowPlayback = ({ doc, flows, onOpenFile, reducedMotion }: Props) => {
  const { targets } = useMapClicks(doc, onOpenFile);
  const [flowIndex, setFlowIndex] = useState(0);
  const flow = flows[Math.min(flowIndex, flows.length - 1)];
  const sequence = useMemo(
    () => (flow === undefined || doc.graph === undefined ? undefined : sequenceOf(flow, doc.graph)),
    [flow, doc.graph],
  );
  const count = sequence?.messages.length ?? 0;
  const [step, setStep] = useState(() => openingStep(count, reducedMotion));
  const [playing, setPlaying] = useState(false);
  const current = clampStep(step, count);

  // Reduced motion switched on mid-play: the Play button goes, so playback stops with it.
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);

  useStepTimer(playing && !reducedMotion, current, MESSAGE_MS, () => {
    const next = clampStep(current + 1, count);
    setStep(next);
    if (next >= count) setPlaying(false);
  });

  if (flow === undefined || sequence === undefined) return null;
  const pick = (index: number) => {
    const next = flows[index];
    if (next === undefined || doc.graph === undefined) return;
    setFlowIndex(index);
    setStep(openingStep(sequenceOf(next, doc.graph).messages.length, reducedMotion));
    setPlaying(false);
  };
  const lit = activeColumns(sequence, current);
  const playingMessage = sequence.messages[current];
  const columns = sequence.participants.length;
  const name = (column: number): string => sequence.participants[column]?.label ?? "";

  return (
    <div className="flowplay">
      <div className="map-controls" role="group" aria-label="Flows">
        {flows.map((item, i) => (
          <button
            key={item.id}
            type="button"
            className="map-btn"
            aria-pressed={item.id === flow.id}
            onClick={() => pick(i)}
          >
            <bdi>{item.title}</bdi>
          </button>
        ))}
      </div>
      {flow.summary !== undefined && (
        <p className="flow-summary">
          <bdi>{flow.summary}</bdi>
        </p>
      )}
      <div className="seq-scroll">
        <div className="seq" style={{ "--cols": columns } as CSSProperties}>
          <ol className="seq-heads" aria-label="Participants">
            {sequence.participants.map((participant, column) => {
              const target = targets.node(participant.node);
              return (
                <li
                  key={participant.node}
                  className={lit.has(column) ? "seq-head is-on" : "seq-head"}
                >
                  {target === undefined ? (
                    <span className="seq-head-box">
                      <bdi>{participant.label}</bdi>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="seq-head-box"
                      aria-label={`${participant.label}, opens ${target.path}`}
                      onClick={() =>
                        target.line === undefined
                          ? onOpenFile(target.path)
                          : onOpenFile(target.path, target.line)
                      }
                    >
                      <bdi>{participant.label}</bdi>
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="seq-body">
            <div className="seq-lifelines" aria-hidden="true">
              {sequence.participants.map((participant) => (
                <span key={participant.node} />
              ))}
            </div>
            <ol className="seq-msgs" aria-label="Messages">
              {sequence.messages.map((message, i) => {
                const state = messageState(i, current);
                const left = Math.min(message.from, message.to);
                const right = Math.max(message.from, message.to);
                const shape =
                  message.from === message.to
                    ? " is-self"
                    : message.from > message.to
                      ? " is-rev"
                      : "";
                return (
                  <li
                    key={message.id}
                    className={`seq-msg is-${state} kind-${message.kind}`}
                    aria-current={state === "active" ? "step" : undefined}
                  >
                    <span
                      className={`seq-arrow${shape}`}
                      style={
                        {
                          gridColumn: `${left + 1} / ${right + 2}`,
                          "--span": right - left + 1,
                        } as CSSProperties
                      }
                    >
                      <span className="seq-label">
                        <span className="seq-num">{i + 1}</span>{" "}
                        <span className="sr-only">
                          {message.from === message.to
                            ? `${name(message.from)} to itself: `
                            : `${name(message.from)} to ${name(message.to)}: `}
                        </span>
                        <bdi>{message.label}</bdi>
                      </span>
                      <span className="seq-line" aria-hidden="true">
                        {state === "active" && <span className="seq-token" />}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
      <p className="seq-now" aria-live="polite">
        {playingMessage === undefined ? (
          `All ${count} steps played.`
        ) : (
          <>
            Step {current + 1} of {count}: <bdi>{playingMessage.label}</bdi>
            {playingMessage.note !== undefined && (
              <>
                {" "}
                <span className="seq-note">
                  <bdi>{playingMessage.note}</bdi>
                </span>
              </>
            )}
          </>
        )}
      </p>
      <ol className="seq-timeline" aria-label="Steps">
        {sequence.messages.map((message, i) => (
          <li key={message.id}>
            <button
              type="button"
              className={`seq-tick is-${messageState(i, current)}`}
              aria-label={`Step ${i + 1}: ${message.label}`}
              aria-current={i === current ? "step" : undefined}
              onClick={() => setStep(i)}
            >
              {i + 1}
            </button>
          </li>
        ))}
      </ol>
      {/* aria-disabled, not disabled: the button keeps focus at either end of the flow. */}
      <div className="map-controls">
        <button
          type="button"
          className="map-btn"
          aria-disabled={current === 0}
          onClick={() => setStep(clampStep(current - 1, count))}
        >
          Back
        </button>
        {!reducedMotion && count > 0 && (
          <button
            type="button"
            className="map-btn"
            aria-pressed={playing}
            onClick={() => {
              if (!playing && current >= count) setStep(0);
              setPlaying((on) => !on);
            }}
          >
            Play
          </button>
        )}
        <button
          type="button"
          className="map-btn map-btn-primary"
          aria-disabled={current >= count}
          onClick={() => setStep(clampStep(current + 1, count))}
        >
          Next
        </button>
      </div>
    </div>
  );
};
