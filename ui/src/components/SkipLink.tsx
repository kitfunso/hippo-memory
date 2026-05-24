/**
 * E5 S3 — SkipLink. Standard a11y pattern: visually hidden until focused,
 * then parchment-styled rust-border button that jumps the user to the
 * memory list (opens drawer + focuses first row).
 */

interface SkipLinkProps {
  /** Called when the link is activated. Should open drawer + focus row 0. */
  onActivate: () => void;
}

export function SkipLink({ onActivate }: SkipLinkProps) {
  return (
    <a
      href="#memory-drawer"
      onClick={(e) => {
        e.preventDefault();
        onActivate();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      style={{
        position: "absolute",
        left: -9999,
        top: 8,
        zIndex: 1000,
        background: "var(--bg)",
        border: "1px solid var(--accent)",
        color: "var(--accent)",
        padding: "8px 16px",
        borderRadius: 3,
        fontFamily: "var(--font-serif)",
        fontSize: 13,
        textDecoration: "none",
      }}
      onFocus={(e) => {
        e.currentTarget.style.left = "8px";
      }}
      onBlur={(e) => {
        e.currentTarget.style.left = "-9999px";
      }}
    >
      Skip to memory list
    </a>
  );
}
