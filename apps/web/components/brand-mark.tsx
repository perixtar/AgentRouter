/** The AgentRouter glyph from the mockup, on its accent tile. */
export function BrandMark({ size = 27 }: { size?: number }) {
  const inner = Math.round(size * 0.59);
  return (
    <div className="brand-logo" style={{ width: size, height: size }}>
      <svg
        width={inner}
        height={inner}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--acc-ink)"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 6h6m8 0h-3M5 18h3m11 0h-6M5 12h14" />
        <circle cx="14" cy="6" r="2.3" fill="var(--acc-ink)" stroke="none" />
        <circle cx="10" cy="18" r="2.3" fill="var(--acc-ink)" stroke="none" />
        <circle cx="6" cy="12" r="2.3" fill="var(--acc-ink)" stroke="none" />
      </svg>
    </div>
  );
}
