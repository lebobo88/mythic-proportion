import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "../SettingsView";

describe("SettingsView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hits GET /api/config + GET /api/models and shows the empty model-list state as a free-text input", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: false,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [], current: "gpt-5", provider: "authhub", error: "no models" }),
    });

    render(<SettingsView />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/models"));

    const modelInput = await screen.findByDisplayValue("gpt-5");
    expect(modelInput.tagName).toBe("INPUT");
    expect(screen.getByText("no models")).toBeInTheDocument();
    expect(
      screen.getByText("No API key is configured for this provider on the server -- synthesis will fail until one is set."),
    ).toBeInTheDocument();
  });

  it("shows the populated model-list state as a select, and hits POST /api/config on save", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5", "gpt-6"], current: "gpt-5", provider: "authhub" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-6",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
      }),
    });

    render(<SettingsView />);

    await waitFor(() => expect(screen.getByLabelText("Model").tagName).toBe("SELECT"));
    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(screen.getByText("An API key is configured for this provider.")).toBeInTheDocument();

    await userEvent.selectOptions(select, "gpt-6");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/config",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const postCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/config" && init?.method === "POST");
    expect(JSON.parse(postCall![1].body)).toEqual({ provider: "authhub", model: "gpt-6" });

    expect(await screen.findByText("Model set to gpt-6 (authhub).")).toBeInTheDocument();
  });

  // --------------------------------------------------------------------
  // Phase 6: local mode / redaction / Ollama toggles
  // --------------------------------------------------------------------

  it("renders local mode and redaction toggles reflecting the fetched config", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
        ollama_base_url: "http://localhost:11434",
        ollama_model: "qwen2.5:7b-instruct",
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    const localToggle = screen.getByLabelText(/Local mode/i) as HTMLInputElement;
    const redactionToggle = screen.getByLabelText(/Redact PII/i) as HTMLInputElement;
    expect(localToggle.checked).toBe(false);
    expect(redactionToggle.checked).toBe(true);
  });

  it("defaults local/redaction toggles safely when the server omits Phase 6 fields (legacy response shape)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        // no `local`/`redaction_enabled`/`ollama_*` keys at all
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    const localToggle = screen.getByLabelText(/Local mode/i) as HTMLInputElement;
    const redactionToggle = screen.getByLabelText(/Redact PII/i) as HTMLInputElement;
    expect(localToggle.checked).toBe(false);
    expect(redactionToggle.checked).toBe(true);
  });

  it("toggling local mode POSTs { local: true } and never mutates the provider/model Save request shape", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: true,
        redaction_enabled: true,
      }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    const localToggle = screen.getByLabelText(/Local mode/i);
    await userEvent.click(localToggle);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "POST" })),
    );
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/config" && init?.method === "POST",
    );
    expect(JSON.parse(postCall![1].body)).toEqual({ local: true });
    expect(await screen.findByText(/Local mode ON/)).toBeInTheDocument();
  });

  it("toggling redaction POSTs only { redaction_enabled: false }", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: false,
      }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    const redactionToggle = screen.getByLabelText(/Redact PII/i);
    await userEvent.click(redactionToggle);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "POST" })),
    );
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/config" && init?.method === "POST",
    );
    expect(JSON.parse(postCall![1].body)).toEqual({ redaction_enabled: false });
  });

  it("selecting the ollama provider reveals model/base-URL fields and includes ollama_model on Save", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
        ollama_base_url: "http://localhost:11434",
        ollama_model: "qwen2.5:7b-instruct",
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "ollama",
        model: "qwen2.5:7b-instruct",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
        ollama_base_url: "http://localhost:11434",
        ollama_model: "qwen2.5:7b-instruct",
      }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    await userEvent.selectOptions(screen.getByLabelText("Provider"), "ollama");
    expect(await screen.findByLabelText("Ollama model")).toBeInTheDocument();
    expect(screen.getByLabelText("Ollama base URL")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "POST" })),
    );
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/config" && init?.method === "POST",
    );
    const body = JSON.parse(postCall![1].body);
    expect(body.provider).toBe("ollama");
    expect(body.ollama_model).toBe(body.model);
  });

  it("shows a persistent warning banner whenever redaction is off (closes a prior review finding, C14/G-6)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: false,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    expect(await screen.findByRole("alert")).toHaveTextContent(/redaction is off/i);
  });

  it("does not show the redaction warning banner when redaction is on", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // ------------------------------------------------------------------
  // GraphRAG extraction pipeline bugfix (DEFECT 1): auto-build toggle
  // ------------------------------------------------------------------

  it("renders the auto-build-graph toggle off by default and toggling POSTs { auto_build_graph: true }", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
        auto_build_graph: false,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: false,
        redaction_enabled: true,
        auto_build_graph: true,
      }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    const toggle = screen.getByLabelText(/Auto-build knowledge graph/i) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await userEvent.click(toggle);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "POST" })),
    );
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/config" && init?.method === "POST",
    );
    expect(JSON.parse(postCall![1].body)).toEqual({ auto_build_graph: true });
    expect(await screen.findByText(/Auto-build knowledge graph ON/)).toBeInTheDocument();
  });

  it("security invariant: never renders an API-key input field", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "gpt-5",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: ["gpt-5"], current: "gpt-5", provider: "authhub" }),
    });

    render(<SettingsView />);
    await screen.findByLabelText("Model");

    expect(screen.queryByLabelText(/api.?key/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/api.?key/i)).not.toBeInTheDocument();
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBe(0);
  });
});
