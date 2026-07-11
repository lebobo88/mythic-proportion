import { useState } from "react";
import { Button, Input, Dialog, DialogTrigger, DialogContent, Tooltip } from "../components/ui";
import { GraphTokenCube } from "./GraphTokenCube";
import "./design-preview.css";

const COLOR_TOKENS = [
  "--color-bg",
  "--color-bg-elevated",
  "--color-bg-inset",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-disabled",
  "--color-border",
  "--color-accent",
  "--color-danger",
  "--color-warning",
  "--color-success",
];

const GRAPH_TOKENS = [
  "--graph-node-source",
  "--graph-node-entity",
  "--graph-node-concept",
  "--graph-node-session",
  "--graph-edge",
  "--graph-edge-active",
  "--graph-community-1",
  "--graph-community-2",
  "--graph-community-3",
  "--graph-community-4",
  "--graph-community-5",
  "--graph-community-6",
  "--graph-community-7",
  "--graph-community-8",
  "--graph-hull-fill",
  "--graph-glow",
];

const TYPE_STEPS = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"] as const;
const SPACE_STEPS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

/**
 * Living tokens + components preview route, mounted at `#/design`
 * (see specs/mythic-proportion-3d-graphrag.html Phase 1 task list). Renders
 * every token family plus each core primitive so visual + a11y review can
 * happen against real, resolved CSS custom properties rather than a static
 * mockup.
 */
export function DesignPreview() {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="mp-design-preview">
      <h1>Design system preview</h1>
      <p>
        Every swatch, scale step, and component below reads live token values — flip the theme
        toggle in the header to review both light and dark.
      </p>

      <section>
        <h2>Semantic colors</h2>
        <div className="mp-swatch-grid">
          {COLOR_TOKENS.map((token) => (
            <div className="mp-swatch" key={token}>
              <div className="mp-swatch-chip" style={{ backgroundColor: `var(${token})` }} />
              <code>{token}</code>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Graph tokens</h2>
        <p>The single palette shared with the future 3D scene (read via src/lib/graph-colors.ts).</p>
        <div className="mp-swatch-grid">
          {GRAPH_TOKENS.map((token) => (
            <div className="mp-swatch" key={token}>
              <div className="mp-swatch-chip" style={{ backgroundColor: `var(${token})` }} />
              <code>{token}</code>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Type scale</h2>
        {TYPE_STEPS.map((step) => (
          <p key={step} style={{ fontSize: `var(--font-size-${step})` }}>
            {step} — The quick brown fox jumps over the lazy dog.
          </p>
        ))}
      </section>

      <section>
        <h2>Spacing scale</h2>
        <div className="mp-space-rows">
          {SPACE_STEPS.map((step) => (
            <div className="mp-space-row" key={step}>
              <code>--space-{step}</code>
              <div className="mp-space-bar" style={{ width: `var(--space-${step})` }} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Graph token → THREE.Color proof</h2>
        <p>
          Cube color is <code>--graph-node-entity</code>, read at runtime into a THREE.Color and
          re-read on every theme change — see src/lib/graph-colors.ts.
        </p>
        <GraphTokenCube />
      </section>

      <section>
        <h2>Components</h2>
        <div className="mp-component-row">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Tooltip content="A token-styled tooltip">
            <Button variant="secondary">Hover me</Button>
          </Tooltip>
        </div>
        <div className="mp-component-row">
          <Input placeholder="A token-styled input" style={{ maxWidth: 280 }} />
        </div>
        <div className="mp-component-row">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="secondary">Open dialog</Button>
            </DialogTrigger>
            <DialogContent title="Preview dialog" description="Confirms Dialog + focus trapping.">
              <Button variant="primary" onClick={() => setDialogOpen(false)}>
                Close
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </section>
    </div>
  );
}
