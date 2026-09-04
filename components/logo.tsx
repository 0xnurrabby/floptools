/**
 * floptools logo: a key mark (identity), on a black rounded tile.
 * Used in the nav and as the shared SVG source of the favicon (app/icon.svg).
 */
export function LogoMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden
      focusable="false"
    >
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <circle cx="32" cy="16" r="9" fill="none" stroke="var(--color-on-primary, #fff)" strokeWidth="5.5" />
      <line x1="32" y1="25" x2="32" y2="50" stroke="var(--color-on-primary, #fff)" strokeWidth="5.5" strokeLinecap="round" />
      <line x1="32" y1="40" x2="41" y2="40" stroke="var(--color-on-primary, #fff)" strokeWidth="5.5" strokeLinecap="round" />
      <line x1="32" y1="50" x2="38" y2="50" stroke="var(--color-on-primary, #fff)" strokeWidth="5.5" strokeLinecap="round" />
    </svg>
  );
}

export function LogoLockup({ mark = 22, textClass = "" }: { mark?: number; textClass?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={mark} className="text-ink" />
      <span className={`text-[15px] font-semibold tracking-tight text-ink ${textClass}`}>floptools</span>
    </span>
  );
}