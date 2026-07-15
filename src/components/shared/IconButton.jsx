import { forwardRef } from "react";

export const IconButton = forwardRef(function IconButton({ label, active = false, children, className = "", ...buttonProps }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-button ${active ? "is-active" : ""} ${className}`.trim()}
      aria-label={label}
      title={label}
      {...buttonProps}
    >
      {children}
    </button>
  );
});
