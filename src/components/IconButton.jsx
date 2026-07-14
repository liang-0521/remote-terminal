export function IconButton({ label, active = false, children, className = "", ...buttonProps }) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "is-active" : ""} ${className}`.trim()}
      aria-label={label}
      title={label}
      {...buttonProps}
    >
      {children}
    </button>
  );
}
