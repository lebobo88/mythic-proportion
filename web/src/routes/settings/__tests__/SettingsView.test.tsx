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
