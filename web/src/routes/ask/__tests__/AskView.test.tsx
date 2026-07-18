import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

    render(<AskView onOpenPage={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config"));
    expect(await screen.findByText("Model: gpt-5 (authhub)")).toBeInTheDocument();
    expect(screen.queryByText(/used_llm=/)).not.toBeInTheDocument();
  });

  // Browser-audit item 4 (trust finding): local mode overrides the raw
  // `provider`/`model` fields at call time without rewriting them -- the
  // model hint must show the ACTUALLY-active provider (`effective_provider`/
  // `effective_model`), not the raw stored fields, or it reads as "local
  // mode isn't enforced" even when routing was always correct.
  it("shows the effective (actually-active) provider/model, not the raw stored fields, when local mode overrides them", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        provider: "authhub",
        model: "deepseek-chat",
        authhub_base_url: "",
        route_alias: null,
        has_api_key: true,
        local: true,
        ollama_model: "qwen2.5:7b-instruct",
        effective_provider: "ollama",
        effective_model: "qwen2.5:7b-instruct",
      }),
    });

    render(<AskView onOpenPage={vi.fn()} />);

    expect(await screen.findByText("Model: qwen2.5:7b-instruct (ollama)")).toBeInTheDocument();
    expect(screen.queryByText(/deepseek-chat \(authhub\)/)).not.toBeInTheDocument();
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

    render(<AskView onOpenPage={vi.fn()} />);
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
    const citationsList = screen.getByLabelText("Citations");
    expect(within(citationsList).getByText("notes/alpha.md")).toBeInTheDocument();
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

    render(<AskView onOpenPage={vi.fn()} />);
    await screen.findByText("Model: gpt-5 (authhub)");

    await userEvent.selectOptions(screen.getByLabelText("Query mode"), "global");
    await userEvent.type(screen.getByLabelText("Ask a question"), "give me an overview");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, requestInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(requestInit.body).mode).toBe("global");
  });

  // Phase 4d (plan Section 6.6 item 1; Section 9.3 journey 7): a first-class
  // reading/detail pane, wired to the answer's `hits` (source pages) --
  // previously rendered nowhere at all, only a bare count ("N source
  // page(s)"). Selecting a source hit shows its detail in place.
  it("renders the answer's source hits as selectable cards, with an in-place detail pane", async () => {
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
        hits: [
          {
            page_path: "notes/alpha.md",
            title: "Alpha",
            score: 0.87,
            snippet: "alpha snippet",
            snippet_html: "alpha snippet",
            tier: "exact",
          },
        ],
        used_llm: true,
        error: false,
      }),
    });

    render(<AskView onOpenPage={vi.fn()} />);
    await screen.findByText("Model: gpt-5 (authhub)");
    await userEvent.type(screen.getByLabelText("Ask a question"), "What is the answer?");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));

    const hitCard = await screen.findByRole("button", { name: /Alpha/ });
    expect(screen.getByText(/select a source/i)).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        path: "notes/alpha.md",
        title: "Alpha",
        type: "source",
        tags: [],
        frontmatter: {},
        raw_markdown: "",
        html: "<p>Alpha body</p>",
        outbound: [],
        backlinks: [],
      }),
    });
    await userEvent.click(hitCard);
    expect(await screen.findByText("Alpha body")).toBeInTheDocument();
  });

  it("the detail pane's 'Open in Wiki' action calls onOpenPage with the selected hit's path", async () => {
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
        hits: [
          {
            page_path: "notes/alpha.md",
            title: "Alpha",
            score: 0.87,
            snippet: "alpha snippet",
            snippet_html: "alpha snippet",
            tier: "exact",
          },
        ],
        used_llm: true,
        error: false,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        path: "notes/alpha.md",
        title: "Alpha",
        type: "source",
        tags: [],
        frontmatter: {},
        raw_markdown: "",
        html: "<p>Alpha body</p>",
        outbound: [],
        backlinks: [],
      }),
    });

    const onOpenPage = vi.fn();
    render(<AskView onOpenPage={onOpenPage} />);
    await screen.findByText("Model: gpt-5 (authhub)");
    await userEvent.type(screen.getByLabelText("Ask a question"), "What is the answer?");
    await userEvent.click(screen.getByRole("button", { name: "Ask" }));

    const hitCard = await screen.findByRole("button", { name: /Alpha/ });
    await userEvent.click(hitCard);

    await userEvent.click(await screen.findByRole("button", { name: /open in wiki/i }));
    expect(onOpenPage).toHaveBeenCalledWith("notes/alpha.md");
  });
});
