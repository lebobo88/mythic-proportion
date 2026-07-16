import { forwardRef, type InputHTMLAttributes } from "react";
import clsx from "clsx";
import "./input.css";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input ref={ref} className={clsx("mp-input", className)} {...rest} />
  ),
);
Input.displayName = "Input";
