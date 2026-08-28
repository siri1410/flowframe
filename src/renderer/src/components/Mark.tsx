import type { JSX } from 'react'

/**
 * The FlowFrame mark: a wireframed screen, and the flow leaving it for the
 * next one. Drawn in `currentColor` so it takes the colour of wherever it is
 * placed, and inline so it costs no request and works from `file://`.
 * The same geometry is the app icon — `resources/branding/mark.svg`.
 */
export default function Mark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 10 95 77"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <rect x="9.5" y="19.5" width="53" height="55" rx="8.5" stroke="currentColor" strokeWidth="7" />
      <rect x="19" y="29" width="34" height="13" rx="2.5" fill="currentColor" />
      <rect x="19" y="51" width="36" height="5" rx="2.5" fill="currentColor" />
      <rect x="19" y="63" width="19" height="5" rx="2.5" fill="currentColor" />
      <path d="M66 47h16v27" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="82" cy="74" r="7" fill="currentColor" />
    </svg>
  )
}
