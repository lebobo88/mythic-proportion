import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Color as ThreeColor } from "three";
import { CommunityBadge, CommunityGlyphIcon } from "../CommunityBadge";

const testColor = { color: new ThreeColor(0.5, 0.3, 0.2), alpha: 1 };

describe("CommunityGlyphIcon (non-color cue, plan Section 5.1)", () => {
  it("renders an svg marked aria-hidden (decorative -- the text label carries the a11y meaning)", () => {
    const { container } = render(<CommunityGlyphIcon index={0} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("tags the rendered shape via data-glyph/data-pattern so a snapshot/visual test can assert real shape variance", () => {
    const { container: c0 } = render(<CommunityGlyphIcon index={0} />);
    const { container: c1 } = render(<CommunityGlyphIcon index={1} />);
    expect(c0.querySelector("svg")?.getAttribute("data-glyph")).toBe("circle");
    expect(c1.querySelector("svg")?.getAttribute("data-glyph")).toBe("square");
  });
});

describe("CommunityBadge (color swatch + glyph + text, plan Section 6.5 items 5/6)", () => {
  it("renders a visible text label naming the community -- never color alone", () => {
    render(<CommunityBadge index={3} count={8} level={0} color={testColor} />);
    expect(screen.getByText(/Community 3/)).toBeInTheDocument();
  });

  it("includes the glyph description in an accessible form (visible or via title/aria)", () => {
    const { container } = render(
      <CommunityBadge index={0} count={8} level={0} color={testColor} />,
    );
    expect(container.textContent).toMatch(/circle/i);
  });
});
