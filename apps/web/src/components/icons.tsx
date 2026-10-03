// Small line drawings for the side rail. 20 by 20, drawn with the text colour.

import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const icons = {
  today: (
    <Icon>
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 2.5v3M13 2.5v3" />
    </Icon>
  ),
  customers: (
    <Icon>
      <circle cx="7.5" cy="7" r="3" />
      <path d="M2 16.5c.6-3 2.7-4.5 5.5-4.5s4.9 1.5 5.5 4.5M13.5 4.2a3 3 0 010 5.6M15.5 12.4c1.4.7 2.2 2 2.5 4.1" />
    </Icon>
  ),
  files: (
    <Icon>
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
    </Icon>
  ),
  rounds: (
    <Icon>
      <path d="M1.5 5h10v8.5h-10zM11.5 8h3.8l3.2 3v2.5h-7z" />
      <circle cx="5.5" cy="14.5" r="1.7" />
      <circle cx="14.5" cy="14.5" r="1.7" />
    </Icon>
  ),
  money: (
    <Icon>
      <rect x="2" y="5" width="16" height="10" rx="1.5" />
      <circle cx="10" cy="10" r="2.3" />
      <path d="M5 8v4M15 8v4" />
    </Icon>
  ),
  vault: (
    <Icon>
      <rect x="3" y="3" width="14" height="13" rx="2" />
      <circle cx="10" cy="9.5" r="3" />
      <path d="M10 6.5v1M10 11.5v1M7 9.5h1M12 9.5h1M6 16v1.5M14 16v1.5" />
    </Icon>
  ),
  china: (
    <Icon>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2.2 2.3 3.2 4.8 3.2 7.5s-1 5.2-3.2 7.5c-2.2-2.3-3.2-4.8-3.2-7.5s1-5.2 3.2-7.5z" />
    </Icon>
  ),
  alerts: (
    <Icon>
      <path d="M10 2.8l7.7 13.4H2.3z" />
      <path d="M10 8v3.8M10 14v.1" />
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2v2.2M10 15.8V18M2 10h2.2M15.8 10H18M4.3 4.3l1.6 1.6M14.1 14.1l1.6 1.6M4.3 15.7l1.6-1.6M14.1 5.9l1.6-1.6" />
    </Icon>
  ),
  out: (
    <Icon>
      <path d="M8 3H4v14h4M12.5 6.5L16 10l-3.5 3.5M16 10H7.5" />
    </Icon>
  ),
};

/** The mark: a five-pointed star. */
export function Star({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 1.8l2.9 6.6 7.2.7-5.4 4.8 1.6 7-6.3-3.7-6.3 3.7 1.6-7L1.9 9.1l7.2-.7z" fill="#3fae72" />
    </svg>
  );
}
