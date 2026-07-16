import { useEffect, useState } from "react";
import { Button, Input } from "../../components/ui";
import { fetchConfig, fetchModels, updateConfig, type ConfigResponse } from "../../lib/api";
import "./settings.css";

// Phase 6 adds "ollama" -- a fully-local model via a local Ollama daemon,
// selected either explicitly here or vault-wide via the Local mode toggle
// below (which always wins regardless of this dropdown -- see
// `Settings.local` / `query.engine._default_client`'s docstring).
const PROVIDERS = ["authhub", "anthropic", "ollama"] as const;

// Settings view: GET/POST /api/config + GET /api/models provider/model
// selection -- parity target for the legacy #view-settings markup (see
// src/mythic_proportion/web/static/app.js `loadSettingsView`). Deliberately
// has NO API-key entry field: keys stay env-only
// (AUTHHUB_API_KEY/ANTHROPIC_API_KEY), matching the backend's
// ConfigUpdateRequest, which never accepts or stores a key.
export function SettingsView() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [provider, setProvider] = useState<string>("authhub");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelSelectValue, setModelSelectValue] = useState("");
  const [modelInputValue, setModelInputValue] = useState("");
  const [useModelSelect, setUseModelSelect] = useState(false);
  const [modelsHint, setModelsHint] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ message: string; error: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  // Phase 6: local mode / redaction / Ollama model+base URL. Each toggle
  // saves immediately (its own independent POST /api/config), separate from
  // the provider/model "Save" button below, so toggling either never
  // changes what that button's request body contains.
  const [local, setLocal] = useState(false);
  const [redactionEnabled, setRedactionEnabled] = useState(true);
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("");
  const [toggleStatus, setToggleStatus] = useState<{ message: string; error: boolean } | null>(null);

  // GraphRAG extraction pipeline bugfix (DEFECT 1): off by default (real
  // LLM-cost concern -- see `mythic index-graph`'s own docstring), saves
  // via its own independent POST /api/config, same pattern as the other
  // toggles above.
  const [autoBuildGraph, setAutoBuildGraph] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    let currentConfig: ConfigResponse;
    try {
      currentConfig = await fetchConfig();
      setConfig(currentConfig);
      setProvider(currentConfig.provider);
      setLocal(currentConfig.local ?? false);
      setRedactionEnabled(currentConfig.redaction_enabled ?? true);
      setOllamaModel(currentConfig.ollama_model ?? "");
      setOllamaBaseUrl(currentConfig.ollama_base_url ?? "");
      setAutoBuildGraph(currentConfig.auto_build_graph ?? false);
    } catch (err) {
      setLoadError(`Failed to load current config: ${String(err)}`);
      return;
    }

    try {
      const data = await fetchModels();
      if (data.models && data.models.length) {
        const options = data.models.includes(currentConfig.model)
          ? data.models
          : [currentConfig.model, ...data.models];
        setModelOptions(options);
        setModelSelectValue(currentConfig.model);
        setUseModelSelect(true);
        setModelsHint("");
      } else {
        setModelInputValue(currentConfig.model);
        setUseModelSelect(false);
        setModelsHint(data.error || "No model list available -- enter a model slug manually.");
      }
    } catch (err) {
      setModelInputValue(currentConfig.model);
      setUseModelSelect(false);
      setModelsHint(`Could not load model list: ${String(err)}`);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const model = useModelSelect ? modelSelectValue : modelInputValue.trim();
    if (!model) {
      setSaveStatus({ message: "Model is required.", error: true });
      return;
    }
    setSaving(true);
    setSaveStatus({ message: "Saving...", error: false });
    try {
      // Ollama's base URL/model only apply when it's the selected provider
      // -- keeping them out of the body otherwise preserves the exact
      // {provider, model} request shape for every other provider.
      const body = provider === "ollama" ? { provider, model, ollama_model: model } : { provider, model };
      const updated = await updateConfig(body);
      setConfig(updated);
      setSaveStatus({ message: `Model set to ${updated.model} (${updated.provider}).`, error: false });
    } catch (err) {
      setSaveStatus({ message: `Save failed: ${String(err)}`, error: true });
    } finally {
      setSaving(false);
    }
  }

  async function handleLocalToggle(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.checked;
    setLocal(next);
    setToggleStatus({ message: "Saving...", error: false });
    try {
      const updated = await updateConfig({ local: next });
      setConfig(updated);
      setToggleStatus({
        message: next
          ? "Local mode ON -- every LLM call now stays on this machine (Ollama)."
          : "Local mode OFF.",
        error: false,
      });
    } catch (err) {
      setLocal(!next);
      setToggleStatus({ message: `Save failed: ${String(err)}`, error: true });
    }
  }

  async function handleRedactionToggle(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.checked;
    setRedactionEnabled(next);
    setToggleStatus({ message: "Saving...", error: false });
    try {
      const updated = await updateConfig({ redaction_enabled: next });
      setConfig(updated);
      setToggleStatus({
        message: next ? "PII redaction ON." : "PII redaction OFF -- content is sent to the LLM unredacted.",
        error: false,
      });
    } catch (err) {
      setRedactionEnabled(!next);
      setToggleStatus({ message: `Save failed: ${String(err)}`, error: true });
    }
  }

  async function handleAutoBuildGraphToggle(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.checked;
    setAutoBuildGraph(next);
    setToggleStatus({ message: "Saving...", error: false });
    try {
      const updated = await updateConfig({ auto_build_graph: next });
      setConfig(updated);
      setToggleStatus({
        message: next
          ? "Auto-build knowledge graph ON -- every ingest now also runs GraphRAG extraction (real LLM cost)."
          : "Auto-build knowledge graph OFF.",
        error: false,
      });
    } catch (err) {
      setAutoBuildGraph(!next);
      setToggleStatus({ message: `Save failed: ${String(err)}`, error: true });
    }
  }

  async function handleOllamaSettingsSubmit(event: React.FormEvent) {
    event.preventDefault();
    setToggleStatus({ message: "Saving...", error: false });
    try {
      const updated = await updateConfig({ ollama_model: ollamaModel, ollama_base_url: ollamaBaseUrl });
      setConfig(updated);
      setToggleStatus({ message: "Ollama settings saved.", error: false });
    } catch (err) {
      setToggleStatus({ message: `Save failed: ${String(err)}`, error: true });
    }
  }

  if (loadError) {
    return <p className="mp-settings-error">{loadError}</p>;
  }

  return (
    <form className="mp-settings" onSubmit={handleSubmit}>
      <div className="mp-settings-field">
        <label htmlFor="settings-provider">Provider</label>
        <select
          id="settings-provider"
          className="mp-settings-select"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="mp-settings-field">
        <label htmlFor="settings-model">Model</label>
        {useModelSelect ? (
          <select
            id="settings-model"
            className="mp-settings-select"
            value={modelSelectValue}
            onChange={(event) => setModelSelectValue(event.target.value)}
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <Input
            id="settings-model"
            value={modelInputValue}
            onChange={(event) => setModelInputValue(event.target.value)}
          />
        )}
        {modelsHint ? <p className="mp-settings-hint">{modelsHint}</p> : null}
      </div>

      <p className="mp-settings-hint">
        {config?.has_api_key
          ? "An API key is configured for this provider."
          : "No API key is configured for this provider on the server -- synthesis will fail until one is set."}
      </p>

      <Button type="submit" disabled={saving}>
        Save
      </Button>

      {saveStatus ? (
        <p className={saveStatus.error ? "mp-settings-error" : "mp-settings-ok"}>
          {saveStatus.message}
        </p>
      ) : null}

      <hr className="mp-settings-divider" />

      <div className="mp-settings-field mp-settings-checkbox">
        <label htmlFor="settings-local">
          <input id="settings-local" type="checkbox" checked={local} onChange={handleLocalToggle} />
          Local mode -- route everything through Ollama, never the cloud
        </label>
      </div>

      <div className="mp-settings-field mp-settings-checkbox">
        <label htmlFor="settings-redaction">
          <input
            id="settings-redaction"
            type="checkbox"
            checked={redactionEnabled}
            onChange={handleRedactionToggle}
          />
          Redact PII locally before any LLM call
        </label>
      </div>

      {!redactionEnabled ? (
        <p className="mp-settings-warning" role="alert">
          Warning: PII redaction is OFF -- note content is sent to your configured LLM provider
          unredacted.
        </p>
      ) : null}

      <div className="mp-settings-field mp-settings-checkbox">
        <label htmlFor="settings-auto-build-graph">
          <input
            id="settings-auto-build-graph"
            type="checkbox"
            checked={autoBuildGraph}
            onChange={handleAutoBuildGraphToggle}
          />
          Auto-build knowledge graph after ingest (real LLM cost -- off by default)
        </label>
      </div>

      {(local || provider === "ollama") && (
        <div className="mp-settings-field mp-settings-ollama">
          <label htmlFor="settings-ollama-model">Ollama model</label>
          <Input
            id="settings-ollama-model"
            value={ollamaModel}
            onChange={(event) => setOllamaModel(event.target.value)}
          />
          <label htmlFor="settings-ollama-base-url">Ollama base URL</label>
          <Input
            id="settings-ollama-base-url"
            value={ollamaBaseUrl}
            onChange={(event) => setOllamaBaseUrl(event.target.value)}
          />
          <Button type="button" onClick={handleOllamaSettingsSubmit}>
            Save Ollama settings
          </Button>
        </div>
      )}

      {toggleStatus ? (
        <p className={toggleStatus.error ? "mp-settings-error" : "mp-settings-ok"}>{toggleStatus.message}</p>
      ) : null}
    </form>
  );
}
