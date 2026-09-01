/** The مدى dial mark — verbatim from the prototype. */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="20" cy="20" r="19" fill="#DCEAE6" />
      <path
        d="M7 27 A13 13 0 0 1 33 27"
        stroke="#1B5E56"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M20 27 L28.5 15.5"
        stroke="#B4893D"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="20" cy="27" r="2.6" fill="#1B5E56" />
    </svg>
  );
}
