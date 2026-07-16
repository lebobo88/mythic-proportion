import { forwardRef, type ButtonHTMLAttributes } from "react";
import clsx from "clsx";
import "./button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", className, ...rest }, ref) => (
    <button ref={ref} className={clsx("mp-button", `mp-button--${variant}`, className)} {...rest} />
  ),
);
Button.displayName = "Button";
