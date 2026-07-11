import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskView } from "../AskView";

describe("AskView", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /api/config on mount and shows the empty (no-answer) state", async () => {
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

    render(<AskView />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config"));
    expect(await screen.findByText("Model: gpt-5 (authhub)")).toBeInTheDocument();
    expect(screen.queryByText(/used_llm=/)).not.toBeInTheDocument();
  });

  it("hits POST /api/query with the expected body (mode omitted, legacy default) and renders a populated answer", async () => {
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
      json: async () => ({
        text: "The answer is 42.",
        citations: ["notes/alpha.md"],
        hits: [{ page_path: "notes/alpha.md" }],
        used_llm: true,
        error: false,
      }),
    });

    render(<AskView />);
    await screen.findByText("Model: gpt-5 (authhub)");

    await userEvent.type(screen.getByLabelText("Ask a question"), "What is the answer?");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, requestInit] = fetchMock.mock.calls[1];
    expect(fetchMock.mock.calls[1][0]).toBe("/api/query");
    expect(requestInit.method).toBe("POST");
    // Phase 4 CORRECTION: `mode` has no default -- the dropdown's default
    // selection omits the key entirely (legacy path), it is not sent as
    // "auto".
    expect(JSON.parse(requestInit.body)).toEqual({
      question: "What is the answer?",
      use_llm: true,
      k: 8,
    });

    expect(await screen.findByText("The answer is 42.")).toBeInTheDocument();
    expect(screen.getByText("notes/alpha.md")).toBeInTheDocument();
    expect(screen.getByText(/used_llm=true/)).toBeInTheDocument();
  });

  it("Phase 4: the mode dropdown selection is sent as `mode` in the request body", async () => {
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
      json: async () => ({ text: "Global answer.", citations: [], hits: [], used_llm: true, error: false }),
    });

    render(<AskView />);
    await screen.findByText("Model: gpt-5 (authhub)");

    await userEvent.selectOptions(screen.getByLabelText("Query mode"), "global");
    await userEvent.type(screen.getByLabelText("Ask a question"), "give me an overview");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, requestInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(requestInit.body).mode).toBe("global");
  });
});
