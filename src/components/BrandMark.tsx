/**
 * Monogramme de l'application : un « boîtier » stylisé dont la façade
 * accueille trois stacks empilés (les clouds réunis).
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect
        x="3.25"
        y="4.25"
        width="17.5"
        height="15.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M3.5 9h17" stroke="currentColor" strokeWidth="1.2" opacity="0.4" />
      <circle cx="6.4" cy="6.6" r="0.85" fill="currentColor" />
      <path
        d="M7.6 17.2h8.8"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.55"
      />
      <path d="M7.6 14.4h8.8" stroke="currentColor" strokeWidth="1.5" opacity="0.8" />
      <path d="M7.6 11.6h5.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
