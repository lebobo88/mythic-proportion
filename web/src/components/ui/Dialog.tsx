import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import "./dialog.css";

// shadcn/ui-style ownership: a thin, token-styled wrapper directly over
// Radix's accessible dialog primitive, copied into the repo rather than
// pulled from a component library, per specs/ROADMAP-BRIEF.md §6.6.

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;

export function DialogContent({
  children,
  title,
  description,
  className,
}: {
  children: ReactNode;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="mp-dialog-overlay" />
      <RadixDialog.Content className={`mp-dialog-content ${className ?? ""}`}>
        <RadixDialog.Title className="mp-dialog-title">{title}</RadixDialog.Title>
        {description ? (
          <RadixDialog.Description className="mp-dialog-description">
            {description}
          </RadixDialog.Description>
        ) : null}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
