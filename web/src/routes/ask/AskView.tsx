import { useEffect, useState } from "react";
import { Button, Input } from "../../components/ui";
import { PageDetailPane } from "../../components/detail-pane/PageDetailPane";
import { fetchConfig, runQuery, type QueryMode, type QueryResponse } from "../../lib/api";
import "./ask.css";

// Phase 4 (specs/mythic-proportion-3d-graphrag.html §Phase 4), CORRECTED per
// memory/invariants.md's "POST /api/query contract -- CORRECTION" entry:
// `mode` has NO DEFAULT. The dropdown's own default ("" below) OMITS the
// `mode` key entirely, which takes the exact pre-Phase-4 legacy path
// unconditionally -- every other option sends an explicit `mode` value
// (including explicit "auto", now an opt-in heuristic dispatch rather than
// the default).
const QUERY_MODES: { value: QueryMode | ""; label: string }[] = [
  { value: "", label: "Default (legacy, no mode sent)" },
  { value: "legacy", label: "Legacy (hybrid search, explicit)" },
  { value: "auto", label: "Auto (heuristic dispatch)" },
  { value: "global", label: "Global (community reports)" },
  { value: "local", label: "Local (neighborhood)" },
  { value: "drift", label: "DRIFT (primer + follow-ups)" },
  { value: "activation", label: "Spreading-activation" },
];

// Ask view: POST /api/query with citations + hits + an LLM-synthesis
// toggle + a model hint -- parity target for the legacy #view-ask markup
// (see src/mythic_proportion/web/static/app.js `runAsk`/`refreshAskModelHint`).
//
// Phase 4d (plan Section 6.6 item 1; Section 9.3 journey 7): the answer's
// `hits` (source pages) are now rendered as selectable cards -- previously
// nowhere in the UI besides a bare count -- wired to a first-class
// reading/detail pane (the shared `PageDetailPane`, same loading/empty/
// error/populated contract as Wiki/Graph/Search's own panes).
export function AskView({ onOpenPage }: { onOpenPage: (path: string) => void }) {
  const [question, setQuestion] = useState("");
  const [useLlm, setUseLlm] = useState(true);
  const [mode, setMode] = useState<QueryMode | "">("");
  const [answer, setAnswer] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelHint, setModelHint] = useState("Model: loading...");
  const [selectedHitPath, setSelectedHitPath] = useState<string | null>(null);

  useEffect(() => {
    fetchConfig()
      .then((config) => {
        // Browser-audit item 4 (trust finding): prefer the ACTUALLY-active
        // provider/model (`effective_provider`/`effective_model`) over the
        // raw stored `provider`/`model` fields -- `local: true` overrides
        // routing to Ollama unconditionally without rewriting those raw
        // fields underneath it, so showing them unconditionally could read
        // as "deepseek-chat (authhub)" even while every real call actually
        // went to Ollama. Falls back to the raw fields for an older server
        // build that hasn't sent the new (optional, additive) keys yet.
        const model = config.effective_model ?? config.model;
        const provider = config.effective_provider ?? config.provider;
        setModelHint(`Model: ${model} (${provider})`);
      })
      .catch(() => setModelHint("Model: unavailable"));
  }, []);

  async function submit() {
    const q = question.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setSelectedHitPath(null);
    try {
      const result = await runQuery(q, useLlm, 8, mode === "" ? undefined : mode);
      setAnswer(result);
    } catch (err) {
      setError(`Query failed: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mp-ask">
      <div className="mp-ask-input-row">
        <Input
          className="mp-ask-input"
          placeholder="Ask a question about your vault..."
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          aria-label="Ask a question"
        />
        <Button type="button" onClick={submit} disabled={loading}>
          Ask
        </Button>
      </div>
      <label className="mp-ask-llm-toggle">
        <input
          type="checkbox"
          checked={useLlm}
          onChange={(event) => setUseLlm(event.target.checked)}
        />
        Use LLM synthesis
      </label>
      <label className="mp-ask-mode-select">
        Query mode:{" "}
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as QueryMode | "")}
          aria-label="Query mode"
        >
          {QUERY_MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="mp-ask-model-hint">{modelHint}</div>
      <div className="mp-ask-answer">
        {loading ? <div className="mp-ask-box">Thinking...</div> : null}
        {error ? <div className="mp-ask-box mp-ask-box--error">{error}</div> : null}
        {!loading && answer ? (
          <>
            <div className={answer.error ? "mp-ask-box mp-ask-box--error" : "mp-ask-box"}>
              {answer.text}
            </div>
            {answer.citations.length > 0 ? (
              <div className="mp-ask-tag-list" aria-label="Citations">
                {answer.citations.map((citation) => (
                  <span className="mp-ask-tag" key={citation}>
                    {citation}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mp-ask-meta">
              used_llm={String(answer.used_llm)} &middot; {answer.hits.length} source page(s)
            </div>
            {/* Phase 4d (plan Section 6.6 item 1): the first-class
                reading/detail pane -- source hits were previously not
                rendered at all besides the bare count above. */}
            {answer.hits.length > 0 ? (
              <div className="mp-ask-body">
                <div className="mp-ask-hits">
                  {answer.hits.map((hit) => (
                    <button
                      type="button"
                      key={hit.page_path}
                      className={
                        hit.page_path === selectedHitPath
                          ? "mp-ask-hit-card mp-ask-hit-card--selected"
                          : selectedHitPath
                            ? "mp-ask-hit-card mp-context-dimmed"
                            : "mp-ask-hit-card"
                      }
                      aria-current={hit.page_path === selectedHitPath ? "true" : undefined}
                      onClick={() => setSelectedHitPath(hit.page_path)}
                    >
                      <div className="mp-ask-hit-title">{hit.title ?? hit.page_path}</div>
                      {hit.tier ? (
                        <div className="mp-ask-hit-meta">
                          {hit.tier}
                          {typeof hit.score === "number" ? ` · score ${hit.score.toFixed(3)}` : ""}
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
                <PageDetailPane
                  path={selectedHitPath}
                  onOpenInWiki={onOpenPage}
                  emptyHint="Select a source to see details."
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
