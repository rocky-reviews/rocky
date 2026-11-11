/**
 * The setup wizard (P10-2, ADR 0044): four steps from a fresh server to the first analysed pull
 * request (database, GitHub App, LLM provider, first repository), each with its state and the
 * one thing to do next. Not in the POC: built from the inbox's page frame, the shell's top bar,
 * cards, pills and buttons. The person's actions are indigo (`btn-primary`); the LLM step carries
 * the AI mark. Every string from the server is a React text child (escaped).
 */
import type { SetupStatusResponse } from "@rocky-reviews/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark } from "../shell/BrandMark.js";
import type { Mode } from "../theme.js";
import {
  allDone,
  DATABASE_DETAILS_LABEL,
  DATABASE_TEXT,
  databaseTone,
  githubAppError,
  githubAppTone,
  llmTone,
  outcomeOk,
  outcomeText,
  plural,
  pullPath,
  repositoriesTone,
  rolesLabel,
  TONE_LABEL,
  type Tone,
} from "./setup-model.js";
import type { LlmTestResult, SetupSource } from "./setup-source.js";

type Status = SetupStatusResponse;

type Props = {
  status: Status;
  mode: Mode;
  onToggleMode: () => void;
  source: SetupSource;
  /** Loads the status again; resolves once the new one is shown (`false`: the check failed). */
  onReload: () => Promise<boolean>;
  /** Setup was closed: the page shows what to do last. */
  onFinished: () => void;
  /** The last check failed: the steps show the status before it (fix round, item 6). */
  loadProblem?: boolean;
};

const COMPOSE_RESTART = [
  "sudo cat deploy/setup/github-app.env >> deploy/rocky.env",
  "sudo rm deploy/setup/github-app.env",
  "docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.setup.yml up -d",
  "docker compose -f deploy/docker-compose.yml logs server | grep /setup/start | tail -1",
  "",
].join("\n");

const DOCS = "https://github.com/rocky-reviews/rocky/blob/main/docs/self-host/setup.md";

const Step = ({
  n,
  id,
  title,
  tone,
  ai,
  children,
}: {
  n: number;
  id: string;
  title: string;
  tone: Tone;
  ai?: boolean;
  children: ReactNode;
}) => (
  <li className={`card setup-step tone-${tone}`} aria-labelledby={`${id}-title`}>
    <div className="setup-step-head">
      <span className="setup-num" aria-hidden="true">
        {tone === "ok" ? "✓" : n}
      </span>
      <h2 id={`${id}-title`} className="setup-step-title">
        <span className="sr-only">Step {n}: </span>
        {title}
        {ai === true && (
          <span className="setup-ai" aria-hidden="true">
            {" "}
            ✦
          </span>
        )}
      </h2>
      <span className={`status-pill setup-pill tone-${tone}`}>{TONE_LABEL[tone]}</span>
    </div>
    <div className="setup-step-body">{children}</div>
  </li>
);

const LLM_PROBLEM: Readonly<Record<Exclude<LlmTestResult["kind"], "done">, string>> = {
  busy: "A test call is already running.",
  too_soon: "Wait a few seconds before testing again.",
  invalid_config: "The LLM configuration is invalid; fix it and restart Rocky.",
  error: "The test call could not be started. Try again.",
};

/** How long an announcement stays in the live region before it is cleared. */
export const ANNOUNCE_MS = 5_000;

/** `aria-disabled` rather than `disabled`: a disabled button drops focus to the page. */
const unavailable = (busy: boolean) => (busy ? { "aria-disabled": true as const } : {});

export const Setup = ({
  status,
  mode,
  onToggleMode,
  source,
  onReload,
  onFinished,
  loadProblem = false,
}: Props) => {
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState<{ step: "llm" | "finish"; text: string } | null>(null);
  const clearTimer = useRef<number | undefined>(undefined);
  const nextMode = mode === "dark" ? "light" : "dark";
  const { database, githubApp, llm, repositories } = status;

  useEffect(() => () => window.clearTimeout(clearTimer.current), []);

  /** Says `text` to screen readers, then clears it (the region is not shown, fix round item 5). */
  const announce = (text: string) => {
    window.clearTimeout(clearTimer.current);
    setMessage(text);
    if (text !== "") clearTimer.current = window.setTimeout(() => setMessage(""), ANNOUNCE_MS);
  };

  const runTest = async () => {
    if (testing || finishing) return;
    setTesting(true);
    setProblem(null);
    announce("Testing the LLM provider…");
    const result = await source.testLlm(status.csrfToken);
    await onReload();
    setTesting(false);
    if (result.kind === "done") {
      const ok = result.results.every((r) => outcomeOk(r.outcome));
      announce(ok ? "The LLM provider answered." : "The LLM provider test failed.");
    } else {
      announce("");
      setProblem({ step: "llm", text: LLM_PROBLEM[result.kind] });
    }
  };

  const refresh = async () => {
    if (refreshing || testing || finishing) return;
    setRefreshing(true);
    const loaded = await onReload();
    setRefreshing(false);
    // A failed check shows its own alert (`loadProblem`).
    if (loaded) announce("Status updated.");
  };

  const finish = async () => {
    if (finishing || testing) return;
    setFinishing(true);
    setProblem(null);
    const ok = await source.finish(status.csrfToken);
    setFinishing(false);
    if (ok) onFinished();
    else setProblem({ step: "finish", text: "Setup could not be closed. Reload and try again." });
  };

  return (
    <div className="inbox-app setup-app">
      <div className="topbar-wrap">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="topbar">
          <span className="brand">
            <BrandMark />
            <span className="hide-sm">Rocky Reviews</span>
          </span>
          <div className="inbox-head">
            <h1 className="inbox-title">Set up Rocky</h1>
            <span className="inbox-sub">
              {status.mode === "setup" ? "Setup mode: only this page is served" : "Setup is open"}
            </span>
          </div>
          <button
            type="button"
            className="mode-btn"
            aria-label={`Switch to ${nextMode} mode`}
            title={`Switch to ${nextMode} mode`}
            onClick={onToggleMode}
          >
            <span aria-hidden="true">{mode === "dark" ? "☀" : "☾"}</span>
          </button>
        </header>
      </div>
      <main id="main" className="inbox-main setup-main" tabIndex={-1}>
        <section className="card setup-intro" aria-labelledby="setup-intro-title">
          <h2 id="setup-intro-title" className="setup-intro-title">
            From a fresh server to your first analysed pull request
          </h2>
          <p className="setup-note">
            Four checks, in order. Each says what is missing and what to do next. This page needs
            the one-time link from the server&rsquo;s log and closes when you finish. The full
            guide: <a href={DOCS}>docs/self-host/setup.md</a>.
          </p>
          <div className="setup-controls">
            <button
              type="button"
              className="btn"
              onClick={() => void refresh()}
              {...unavailable(refreshing || testing || finishing)}
            >
              <span aria-hidden="true">↻</span> {refreshing ? "Checking…" : "Check again"}
            </button>
          </div>
          {loadProblem && (
            <p className="setup-problem" role="alert">
              Rocky did not answer the last check; the steps show its last answer. The page keeps
              checking on its own.
            </p>
          )}
          <p role="status" className="sr-only">
            {message}
          </p>
        </section>

        <ol className="setup-steps">
          <Step n={1} id="setup-db" title="Database" tone={databaseTone(database)}>
            <p>{DATABASE_TEXT[database.state]}</p>
            {database.state === "migrations_pending" && (
              <p>
                Apply them with <code>pnpm db:migrate</code> or, with Docker Compose,{" "}
                <code>docker compose -f deploy/docker-compose.yml run --rm migrate</code>, then
                check again.
              </p>
            )}
            {database.details.length > 0 && (
              <>
                <p className="setup-details-label" id="setup-db-missing">
                  {DATABASE_DETAILS_LABEL[database.state]}
                </p>
                <ul className="setup-details" aria-labelledby="setup-db-missing">
                  {database.details.map((d) => (
                    <li key={d}>
                      <code>{d}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Step>

          <Step n={2} id="setup-app" title="GitHub App" tone={githubAppTone(githubApp)}>
            {githubApp.state === "not_created" && githubApp.createBlocked !== null && (
              <p>
                GitHub must reach Rocky&rsquo;s webhook receiver over https. Set an https{" "}
                <code>ROCKY_PUBLIC_URL</code> (or <code>GITHUB_APP_WEBHOOK_URL</code>) and restart
                Rocky.
              </p>
            )}
            {githubApp.state === "not_created" && githubApp.createPath !== null && (
              <>
                <p>
                  Rocky creates a private GitHub App from its manifest: read access to code and
                  checks, write access to pull requests (to post the reviews you submit). GitHub
                  shows every permission before you confirm. Its credentials are written once to{" "}
                  <code>{githubApp.credentialsFile}</code>.
                </p>
                <div className="setup-actions">
                  <a className="btn btn-primary" href={githubApp.createPath}>
                    Create the GitHub App
                  </a>
                  <span className="setup-hint">
                    For an organization, add <code>?org=&lt;organization&gt;</code> to the link.
                  </span>
                </div>
              </>
            )}
            {githubApp.state === "created" && (
              <>
                <p>
                  The app exists and its credentials are in <code>{githubApp.credentialsFile}</code>{" "}
                  (with Docker Compose, that is <code>deploy/setup/github-app.env</code> on the
                  host). Add them to Rocky&rsquo;s configuration, delete the file and restart Rocky,
                  then open the new setup link from the server&rsquo;s log. With Docker Compose:
                </p>
                <pre className="setup-commands">
                  <code>{COMPOSE_RESTART}</code>
                </pre>
                <p className="setup-hint">Do not install the app before the restart.</p>
              </>
            )}
            {githubApp.state === "configured" && (
              <p>GitHub accepts the app&rsquo;s key. Install it on a repository in step 4.</p>
            )}
            {githubApp.state === "check_failed" && <p>{githubAppError(githubApp.error)}</p>}
          </Step>

          <Step n={3} id="setup-llm" title="LLM provider" tone={llmTone(llm)} ai>
            {llm.state === "invalid_config" ? (
              <>
                <p>
                  The <code>ROCKY_LLM_*</code> settings are invalid. Fix them and restart Rocky:
                </p>
                <pre className="setup-config-error">{llm.configError}</pre>
              </>
            ) : (
              <>
                <p>
                  One short test call per model, with a fixed prompt and a small output limit (about
                  a cent or two with the default models). No code is sent.
                </p>
                <ul className="setup-targets">
                  {llm.targets.map((t) => {
                    const result = llm.results?.find(
                      (r) => r.provider === t.provider && r.model === t.model,
                    );
                    return (
                      <li
                        key={`${t.provider}/${t.model}/${t.roles.join()}`}
                        className="setup-target"
                      >
                        <span className="setup-target-name">
                          <bdi>{t.model}</bdi>
                          <span className="setup-target-meta">
                            {" "}
                            · {t.provider} · {rolesLabel(t.roles)}
                          </span>
                        </span>
                        {result !== undefined && (
                          <span
                            className={`setup-outcome ${outcomeOk(result.outcome) ? "is-ok" : "is-failed"}`}
                          >
                            <span className="setup-mark" aria-hidden="true">
                              {outcomeOk(result.outcome) ? "✓" : "✕"}
                            </span>{" "}
                            {outcomeText(result.outcome)} ({(result.durationMs / 1000).toFixed(1)}{" "}
                            s)
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="setup-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void runTest()}
                    {...unavailable(testing || finishing)}
                  >
                    {testing
                      ? "Testing…"
                      : llm.results === null
                        ? "Run the test call"
                        : "Test again"}
                  </button>
                </div>
              </>
            )}
            {problem?.step === "llm" && (
              <p className="setup-problem" role="alert">
                {problem.text}
              </p>
            )}
          </Step>

          <Step
            n={4}
            id="setup-repo"
            title="First repository"
            tone={repositoriesTone(repositories)}
          >
            <Repositories status={status} />
          </Step>
        </ol>

        <section className="card setup-finish" aria-labelledby="setup-finish-title">
          <h2 id="setup-finish-title" className="setup-intro-title">
            Finish
          </h2>
          <p className="setup-note">
            {allDone(status) ? (
              "Everything works. Close setup: this page and its API stop answering until a restart."
            ) : (
              <>
                You can close setup at any time; open it again later with{" "}
                <code>ROCKY_SETUP=true</code> and a restart.
              </>
            )}
          </p>
          <div className="setup-actions">
            <button
              type="button"
              className={`btn${allDone(status) ? " btn-primary" : ""}`}
              onClick={() => void finish()}
              {...unavailable(finishing || testing)}
            >
              {finishing ? "Finishing…" : "Finish setup"}
            </button>
          </div>
          {problem?.step === "finish" && (
            <p className="setup-problem" role="alert">
              {problem.text}
            </p>
          )}
        </section>
      </main>
    </div>
  );
};

const Repositories = ({ status }: { status: Status }) => {
  const { repositories, githubApp } = status;
  if (repositories.state === "waiting_for_app")
    return <p>Available once the GitHub App is configured (step 2) and Rocky has restarted.</p>;
  if (repositories.state === "check_failed") return <p>{githubAppError(repositories.error)}</p>;
  const install =
    githubApp.installUrl === null ? null : (
      <a
        className={`btn${repositories.state === "analysed" ? "" : " btn-primary"}`}
        href={githubApp.installUrl}
      >
        Install on a repository <span aria-hidden="true">↗</span>
      </a>
    );
  if (repositories.state === "not_installed")
    return (
      <>
        <p>
          Install the app on one repository to start with. GitHub then tells Rocky, and Rocky
          mirrors its open pull requests.
        </p>
        <div className="setup-actions">{install}</div>
      </>
    );
  const first = repositories.installations.find((i) => i.latestDone !== null)?.latestDone ?? null;
  const path = first === null ? null : pullPath(first.fullName, first.number);
  return (
    <>
      {first !== null ? (
        <p>
          Rocky analysed{" "}
          <b>
            <bdi>{first.fullName}</bdi> #{first.number}
          </b>
          . {path !== null && <a href={path}>Open it in Rocky (sign in with GitHub)</a>}
        </p>
      ) : (
        <p>
          Open a pull request (or push to one) in an installed repository. With{" "}
          <code>ROCKY_ANALYSIS_AUTO=on</code> Rocky analyses it within a minute or two; otherwise
          sign in, open it in Rocky and choose Analyze.
        </p>
      )}
      <ul className="setup-installations">
        {repositories.installations.map((i) => (
          <li key={`${i.kind}/${i.account}`} className="setup-installation">
            <span className="setup-target-name">
              <bdi>{i.account}</bdi>
              <span className="setup-target-meta"> · {i.kind}</span>
            </span>
            <span className="setup-installation-counts">
              {i.suspended
                ? "Suspended on GitHub"
                : !i.ready
                  ? "Waiting for GitHub's installation event"
                  : `${plural(i.repositories, "repository", "repositories")} · ${plural(i.pullRequests, "pull request", "pull requests")} · ${plural(i.analyses.done, "analysis", "analyses")} done${i.analyses.running + i.analyses.queued > 0 ? ` · ${i.analyses.running + i.analyses.queued}\u00a0in progress` : ""}${i.analyses.failed > 0 ? ` · ${i.analyses.failed}\u00a0failed` : ""}`}
            </span>
          </li>
        ))}
      </ul>
      {install !== null && <div className="setup-actions">{install}</div>}
    </>
  );
};
