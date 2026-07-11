import { useEffect, useState } from "react";
import { Button } from "../../components/ui";
import { fetchLint, fixLint, type LintReport } from "../../lib/api";
import "./lint.css";

// Lint view: GET /api/lint report + POST /api/lint/fix -- parity target for
// the legacy #view-lint markup (see src/mythic_proportion/web/static/app.js
// `loadLint`).
export function LintView() {
  const [report, setReport] = useState<LintReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLint();
      setReport(data);
    } catch (err) {
      setError(`Failed to load lint report: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFix() {
    setFixing(true);
    setError(null);
    try {
      await fixLint();
      await load();
    } catch (err) {
      setError(`Fix failed: ${String(err)}`);
    } finally {
      setFixing(false);
    }
  }

  return (
    <div className="mp-lint">
      <div className="mp-lint-toolbar">
        <Button type="button" variant="secondary" onClick={load} disabled={loading}>
          Refresh
        </Button>
        <Button type="button" onClick={handleFix} disabled={fixing}>
          Fix issues
        </Button>
      </div>
      <div className="mp-lint-report">
        {loading ? <p className="mp-lint-muted">Loading lint report...</p> : null}
        {error ? <p className="mp-lint-error">{error}</p> : null}
        {!loading && !error && report ? <LintReportView report={report} /> : null}
      </div>
    </div>
  );
}

function LintReportView({ report }: { report: LintReport }) {
  if (report.ok) {
    return <p className="mp-lint-ok">{report.summary}</p>;
  }
  return (
    <>
      {report.orphans.length > 0 ? (
        <section className="mp-lint-section">
          <h3>Orphan pages ({report.orphans.length})</h3>
          <ul>
            {report.orphans.map((o) => (
              <li key={o.path}>
                {o.title} ({o.path})
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.dangling_links.length > 0 ? (
        <section className="mp-lint-section">
          <h3>Broken wikilinks ({report.dangling_links.length})</h3>
          <ul>
            {report.dangling_links.map((d, index) => (
              <li key={`${d.source_path}-${d.target_title}-${index}`}>
                {d.source_title} &rarr; {d.target_title} (missing)
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.stale_index_entries.length > 0 ? (
        <section className="mp-lint-section">
          <h3>Stale index rows ({report.stale_index_entries.length})</h3>
          <ul>
            {report.stale_index_entries.map((s) => (
              <li key={s.page_path}>
                {s.page_path} ({s.reason})
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.thin_pages.length > 0 ? (
        <section className="mp-lint-section">
          <h3>Thin pages ({report.thin_pages.length})</h3>
          <ul>
            {report.thin_pages.map((t) => (
              <li key={t.path}>
                {t.title} ({t.char_count} chars)
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
