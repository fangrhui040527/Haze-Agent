/** The Haze logo: a dim sun disc behind two bands of haze. Decorative; pair with text. */
export function HazeMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="10" r="5.5" fill="var(--color-accent)" opacity="0.9" />
      <path
        d="M3 15.5h18M5 19h14"
        stroke="var(--color-muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M3 15.5h18"
        stroke="var(--color-bg)"
        strokeWidth="4"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}
