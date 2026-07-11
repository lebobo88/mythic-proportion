import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import "./tooltip.css";

export const TooltipProvider = RadixTooltip.Provider;

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RadixTooltip.Root delayDuration={300}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="mp-tooltip-content" sideOffset={6}>
          {content}
          <RadixTooltip.Arrow className="mp-tooltip-arrow" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
