import { useEffect, useState } from "react";
import { Button, Input } from "../../components/ui";
import { fetchConfig, fetchModels, updateConfig, type ConfigResponse } from "../../lib/api";
import "./settings.css";

const PROVIDERS = ["authhub", "anthropic"] as const;

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
      const updated = await updateConfig({ provider, model });
      setConfig(updated);
      setSaveStatus({ message: `Model set to ${updated.model} (${updated.provider}).`, error: false });
    } catch (err) {
      setSaveStatus({ message: `Save failed: ${String(err)}`, error: true });
    } finally {
      setSaving(false);
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
    </form>
  );
}
