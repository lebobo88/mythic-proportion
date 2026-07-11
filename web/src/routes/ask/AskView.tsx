import { useEffect, useState } from "react";
import { Button, Input } from "../../components/ui";
import { fetchConfig, runQuery, type QueryMode, type QueryResponse } from "../../lib/api";
import "./ask.css";

// Phase 4 (specs/mythic-proportion-3d-graphrag.html §Phase 4): the four
// GraphRAG query modes plus "auto" (default -- preserves the pre-Phase-4
// answer behavior unchanged until the graph layer has data) and an explicit
// "legacy" escape hatch.
const QUERY_MODES: { value: QueryMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "legacy", label: "Legacy (hybrid search)" },
  { value: "global", label: "Global (community reports)" },
  { value: "local", label: "Local (neighborhood)" },
  { value: "drift", label: "DRIFT (primer + follow-ups)" },
  { value: "activation", label: "Spreading-activation" },
];

// Ask view: POST /api/query with citations + hits + an LLM-synthesis
// toggle + a model hint -- parity target for the legacy #view-ask markup
// (see src/mythic_proportion/web/static/app.js `runAsk`/`refreshAskModelHint`).
export function AskView() {
  const [question, setQuestion] = useState("");
  const [useLlm, setUseLlm] = useState(true);
  const [mode, setMode] = useState<QueryMode>("auto");
  const [answer, setAnswer] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelHint, setModelHint] = useState("Model: loading...");

  useEffect(() => {
    fetchConfig()
      .then((config) => setModelHint(`Model: ${config.model} (${config.provider})`))
      .catch(() => setModelHint("Model: unavailable"));
  }, []);

  async function submit() {
    const q = question.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runQuery(q, useLlm, 8, mode);
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
          onChange={(event) => setMode(event.target.value as QueryMode)}
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
              <div className="mp-ask-tag-list">
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
          </>
        ) : null}
      </div>
    </div>
  );
}
