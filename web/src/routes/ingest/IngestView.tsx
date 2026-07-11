import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui";
import {
  enqueueIngest,
  fetchIngestStatus,
  uploadFiles,
  type IngestJobStatus,
} from "../../lib/api";
import "./ingest.css";

// Ingest view: drop-zone upload to POST /api/upload + POST /api/ingest with
// status polling GET /api/ingest/status -- parity target for the legacy
// #view-ingest markup (see src/mythic_proportion/web/static/app.js
// `uploadFiles`/`startIngestPolling`/`pollIngestStatus`/`renderIngestProgress`).
export function IngestView({ onIngestComplete }: { onIngestComplete: () => void }) {
  const [dragOver, setDragOver] = useState(false);
  const [job, setJob] = useState<IngestJobStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollJobIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollHandleRef.current !== null) {
      clearInterval(pollHandleRef.current);
      pollHandleRef.current = null;
    }
    pollJobIdRef.current = null;
  }, []);

  const pollOnce = useCallback(
    async (jobId: string) => {
      try {
        const status = await fetchIngestStatus(jobId);
        if (jobId !== pollJobIdRef.current) return;
        setJob(status);
        if (status.done) {
          stopPolling();
          onIngestComplete();
        }
      } catch {
        // Transient poll failure: keep whatever was last rendered, try again
        // on the next tick (matches legacy `pollIngestStatus` behavior).
      }
    },
    [onIngestComplete, stopPolling],
  );

  const startPolling = useCallback(
    (jobId: string) => {
      stopPolling();
      pollJobIdRef.current = jobId;
      pollOnce(jobId);
      pollHandleRef.current = setInterval(() => pollOnce(jobId), 1000);
    },
    [pollOnce, stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  async function handleFiles(files: FileList | File[]) {
    setUploading(true);
    setError(null);
    try {
      const result = await uploadFiles(files);
      startPolling(result.job_id);
    } catch (err) {
      setError(`Upload failed: ${String(err)}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleIngestOnly() {
    setError(null);
    try {
      const result = await enqueueIngest();
      startPolling(result.job_id);
    } catch (err) {
      setError(`Ingest failed: ${String(err)}`);
    }
  }

  const files = job?.files ?? [];
  const settledCount = files.filter((f) => f.status === "done" || f.status === "error").length;
  const pct = files.length ? Math.round((settledCount / files.length) * 100) : job?.done ? 100 : 0;
  const statusLabel =
    job?.status === "queued" ? "Queued..." : job?.status === "running" ? "Ingesting..." : "Done";

  return (
    <div className="mp-ingest">
      <div
        className={dragOver ? "mp-ingest-dropzone mp-ingest-dropzone--over" : "mp-ingest-dropzone"}
        onClick={() => fileInputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          if (event.dataTransfer.files?.length) handleFiles(event.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
      >
        <p>Drop files here, or click to choose files.</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="mp-ingest-file-input"
          onChange={(event) => {
            if (event.target.files?.length) handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <Button type="button" variant="secondary" onClick={handleIngestOnly}>
        Ingest drop/ folder
      </Button>
      <div className="mp-ingest-result">
        {uploading ? <div className="mp-ingest-panel">Uploading...</div> : null}
        {error ? <div className="mp-ingest-panel mp-ingest-panel--error">{error}</div> : null}
        {job ? (
          <div className="mp-ingest-panel">
            <div className="mp-ingest-status-line">
              {!job.done ? "Working: " : null}
              {statusLabel}
              {files.length ? ` (${settledCount} / ${files.length} compiled)` : ""}
            </div>
            {files.length ? (
              <div className="mp-ingest-progress-bar">
                <div className="mp-ingest-progress-fill" style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            {files.length ? (
              <ul className="mp-ingest-file-list">
                {files.map((f) => (
                  <li key={f.name} className={`mp-ingest-file mp-ingest-file--${f.status}`}>
                    <span className="mp-ingest-file-name">{f.name}</span>
                    <span className={`mp-ingest-file-badge mp-ingest-file-badge--${f.status}`}>
                      {f.status}
                    </span>
                    {f.message ? <div className="mp-ingest-file-message">{f.message}</div> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {job.done ? (
              <div className="mp-ingest-panel">
                Ingested: {job.ingested}
                <br />
                Compiled: {job.compiled}
                <br />
                Skipped (duplicates): {job.skipped}
                <br />
                Errors: {job.errors.length}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
