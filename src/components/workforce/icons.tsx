// Local icon shim — same glyphs the workforce components need, rendered as
// inline SVG so we don't carry a lucide-react dependency (no icon library is
// used anywhere else in the codebase).
import React from 'react';

export type IconProps = { className?: string };

const make = (paths: React.ReactNode) =>
  function Icon({ className = '' }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };

export const CheckCircle = make(<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>);
export const XCircle = make(<><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>);
export const AlertCircle = make(<><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></>);
export const Loader = make(
  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
);
export const BookOpen = make(
  <><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></>
);
export const TrendingUp = make(<><path d="m22 7-8.5 8.5-5-5L2 17" /><path d="M16 7h6v6" /></>);
export const TrendingDown = make(<><path d="m22 17-8.5-8.5-5 5L2 7" /><path d="M16 17h6v-6" /></>);
export const DollarSign = make(
  <><path d="M12 2v20" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>
);
export const MessageSquare = make(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const Lightbulb = make(
  <><path d="M15 14c.2-1 .7-1.7 1.5-2.5A6 6 0 1 0 6 7c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" /><path d="M9 18h6" /><path d="M10 22h4" /></>
);
