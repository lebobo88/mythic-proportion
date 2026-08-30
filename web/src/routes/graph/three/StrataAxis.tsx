// Deep-Field Observatory Phase 5 (plan Section 3.1 item 5 / Section 5.1
// J-STRATA: "an etched level axis with text labels ... axis labels remain
// the legibility anchor if translucency is culled at the safe tier"). Uses
// the SAME imperative troika `Text` pattern `NodeLabels.tsx` already
// established for its community-title chips (`new Text()` + `group.add()`,
// disposed on teardown) -- a small, bounded (== `levelCount`) label set, so
// there is no per-node-cap concern here the way `NodeLabels.tsx` has. The
// axis line itself is built imperatively via `THREE.Line` + `<primitive>`,
// mirroring `InstancedEdges.tsx`'s established convention for the same
// reason: JSX's bare `<line>` intrinsic collides with React's own SVG `line`
// element typings.
import { useEffect, useMemo, useRef } from "react";
import { BufferGeometry, Float32BufferAttribute, Line, LineBasicMaterial, type Group } from "three";
import { Text } from "troika-three-text";
import type { GraphColors } from "../../../lib/graph-colors";
import { strataFloorLevelY } from "./perModeChromeGeometry";

export interface StrataAxisProps {
  colors: GraphColors;
  levelCount: number;
  opacity?: number;
  /**
   * T3-advised escalation remediation: the axis' X position, supplied by
   * `StrataChrome` as just-outside the derived floor-disc radius (which is
   * no longer a fixed constant). Defaults to the pre-remediation -180 so
   * every other caller is byte-identical.
   */
  xOffset?: number;
}

const AXIS_X_OFFSET = -180;
const AXIS_FONT_SIZE = 1.6;

export function StrataAxis({ colors, levelCount, opacity = 1, xOffset = AXIS_X_OFFSET }: StrataAxisProps) {
  const groupRef = useRef<Group>(null);
  const textsRef = useRef<Map<number, InstanceType<typeof Text>>>(new Map());

  const levelYs = useMemo(
    () => Array.from({ length: Math.max(0, levelCount) }, (_, level) => strataFloorLevelY(level, levelCount)),
    [levelCount],
  );

  const line = useMemo(() => {
    const geo = new BufferGeometry();
    const ys = levelYs.length > 0 ? levelYs : [0];
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    geo.setAttribute("position", new Float32BufferAttribute([xOffset, minY, 0, xOffset, maxY, 0], 3));
    const material = new LineBasicMaterial({ transparent: true });
    return new Line(geo, material);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelYs.join(","), xOffset]);

  useEffect(() => {
    return () => {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    };
  }, [line]);

  useEffect(() => {
    const material = line.material as LineBasicMaterial;
    material.color.copy(colors.strataChrome.axisColor.color);
    material.opacity = colors.strataChrome.axisColor.alpha * opacity;
  }, [line, colors.strataChrome.axisColor, opacity]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const existing = textsRef.current;
    const keep = new Set(levelYs.map((_, level) => level));

    for (const [level, text] of existing) {
      if (keep.has(level)) continue;
      group.remove(text);
      text.dispose();
      existing.delete(level);
    }

    const colorHex = colors.strataChrome.axisColor.color.getHex();
    levelYs.forEach((y, level) => {
      let text = existing.get(level);
      if (!text) {
        text = new Text();
        text.anchorX = "right";
        text.anchorY = "middle";
        text.fontSize = AXIS_FONT_SIZE;
        text.outlineWidth = "6%";
        text.outlineColor = 0x000000;
        group.add(text);
        existing.set(level, text);
      }
      text.text = `Level ${level}`;
      text.color = colorHex;
      text.fillOpacity = colors.strataChrome.axisColor.alpha * opacity;
      text.position.set(xOffset - 2, y, 0);
      text.sync();
    });
  }, [levelYs, colors.strataChrome.axisColor, opacity, xOffset]);

  useEffect(() => {
    const texts = textsRef.current;
    return () => {
      for (const text of texts.values()) text.dispose();
      texts.clear();
    };
  }, []);

  return (
    <group ref={groupRef}>
      <primitive object={line} />
    </group>
  );
}
