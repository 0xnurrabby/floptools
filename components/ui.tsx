"use client";

import { useState, type ReactNode, type ButtonHTMLAttributes } from "react";

/* ---------- Buttons (pill geometry, per DESIGN.md) ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "on-dark";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full px-5 h-11 sm:h-9 text-sm font-medium select-none transition-all disabled:cursor-not-allowed disabled:bg-surface-soft disabled:text-mute disabled:border-transparent disabled:shadow-none";
  const styles: Record<ButtonVariant, string> = {
    primary:
      "grad-brand text-white shadow-soft hover:shadow-md hover:brightness-110 active:brightness-95 disabled:bg-surface-soft",
    secondary:
      "bg-canvas text-ink border border-hairline-strong hover:bg-surface-soft hover:border-ink disabled:border-transparent",
    ghost: "bg-transparent text-ink hover:bg-surface-soft disabled:bg-transparent",
    "on-dark": "bg-canvas text-ink hover:bg-surface-soft disabled:bg-surface-soft",
  };
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "secondary",
  className = "",
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full px-5 h-11 sm:h-9 text-sm font-medium no-underline transition-all";
  const styles: Record<ButtonVariant, string> = {
    primary: "grad-brand text-white shadow-soft hover:shadow-md hover:brightness-110",
    secondary:
      "bg-canvas text-ink border border-hairline-strong hover:bg-surface-soft hover:border-ink",
    ghost: "bg-transparent text-ink hover:bg-surface-soft",
    "on-dark": "bg-canvas text-ink hover:bg-surface-soft",
  };
  return (
    <a href={href} className={`${base} ${styles[variant]} ${className}`}>
      {children}
    </a>
  );
}

/* ---------- Inputs (pill geometry, per DESIGN.md) ---------- */

export function TextInput({
  className = "",
  mono = false,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return (
    <input
      className={`h-11 w-full rounded-full border border-hairline bg-canvas px-4 text-base text-ink placeholder:text-mute focus:border-ink focus:outline-none sm:h-10 sm:text-[15px] ${mono ? "font-mono" : ""} ${className}`}
      {...rest}
    />
  );
}

export function TextArea({
  className = "",
  mono = false,
  rows = 4,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  mono?: boolean;
  rows?: number;
}) {
  return (
    <textarea
      rows={rows}
      className={`min-h-28 w-full rounded-[12px] border border-hairline bg-canvas px-4 py-3 text-base text-ink placeholder:text-mute focus:border-ink focus:outline-none resize-y sm:text-[15px] ${mono ? "font-mono" : ""} ${className}`}
      {...rest}
    />
  );
}

export function Select({
  className = "",
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-11 w-full cursor-pointer rounded-full border border-hairline bg-canvas px-4 text-base text-ink focus:border-ink focus:outline-none sm:h-10 sm:text-[15px] ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="body-sm-strong block text-ink">{label}</span>
      <span className="mt-1.5 block">{children}</span>
      {hint ? <span className="caption-sm mt-1.5 block text-body">{hint}</span> : null}
    </label>
  );
}

/* ---------- Layout primitives ---------- */

export function Card({
  children,
  className = "",
  dark = false,
}: {
  children: ReactNode;
  className?: string;
  dark?: boolean;
}) {
  return (
    <div
      className={`rounded-[12px] border p-5 sm:p-6 ${
        dark
          ? "border-transparent bg-surface-dark text-on-dark"
          : "border-hairline bg-surface-card"
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Section({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`space-y-6 ${className}`}>{children}</div>;
}

/* ---------- Terminal card (the design's one "product preview") ---------- */

export function TerminalCard({
  title = "floptools",
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-[12px] border border-hairline bg-canvas ${className}`}
    >
      <div className="flex items-center gap-2 border-b border-hairline bg-surface-soft px-4 py-2.5">
        <span className="traffic-light traffic-red" aria-hidden />
        <span className="traffic-light traffic-yellow" aria-hidden />
        <span className="traffic-light traffic-green" aria-hidden />
        <span className="caption-sm ml-1 font-mono text-mute">{title}</span>
      </div>
      <div className="code-sm overflow-x-auto whitespace-pre-wrap break-all p-4 text-ink">
        {children}
      </div>
    </div>
  );
}

/* ---------- Copy button with inline feedback ---------- */

export function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`inline-flex h-11 items-center justify-center gap-1.5 rounded-full border border-hairline-strong bg-canvas px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-soft sm:h-9 ${className}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      {copied ? "Copied" : label}
      <CopyIcon />
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/* ---------- Status chips ---------- */

export type StatusTone = "ok" | "warn" | "empty" | "error";

export function StatusChip({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  const styles: Record<StatusTone, string> = {
    ok: "border-leaf-600/25 bg-tint-leaf text-leaf-600",
    warn: "border-amber-600/25 bg-tint-amber text-amber-600",
    empty: "border-hairline bg-surface-soft text-body",
    error: "border-rose-600/25 bg-tint-rose text-rose-600",
  };
  const dot: Record<StatusTone, string> = {
    ok: "bg-leaf-600",
    warn: "bg-amber-600",
    empty: "bg-mute",
    error: "bg-rose-600",
  };
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-medium ${styles[tone]}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot[tone]}`} aria-hidden />
      {children}
    </span>
  );
}

/* ---------- Colored label pill ---------- */

export type ChipTone = "brand" | "leaf" | "sky" | "amber" | "violet" | "rose" | "neutral";

const CHIP_STYLES: Record<ChipTone, string> = {
  brand: "bg-tint-brand text-brand-600 border-brand-500/25",
  leaf: "bg-tint-leaf text-leaf-600 border-leaf-600/25",
  sky: "bg-tint-sky text-sky-600 border-sky-600/25",
  amber: "bg-tint-amber text-amber-600 border-amber-600/25",
  violet: "bg-tint-violet text-violet-600 border-violet-600/25",
  rose: "bg-tint-rose text-rose-600 border-rose-600/25",
  neutral: "bg-surface-soft text-body border-hairline",
};

export function Chip({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: ChipTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium ${CHIP_STYLES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* ---------- Icon tile: the visual anchor of every card ---------- */

export type IconTone = "brand" | "leaf" | "sky" | "amber" | "violet" | "rose";

const ICON_TILES: Record<IconTone, string> = {
  brand: "bg-tint-brand text-brand-600",
  leaf: "bg-tint-leaf text-leaf-600",
  sky: "bg-tint-sky text-sky-600",
  amber: "bg-tint-amber text-amber-600",
  violet: "bg-tint-violet text-violet-600",
  rose: "bg-tint-rose text-rose-600",
};

export function IconTile({
  tone = "brand",
  size = "md",
  children,
  className = "",
}: {
  tone?: IconTone;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  className?: string;
}) {
  const dims = size === "sm" ? "h-9 w-9" : size === "lg" ? "h-14 w-14" : "h-11 w-11";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[14px] ${dims} ${ICON_TILES[tone]} ${className}`}
      aria-hidden
    >
      {children}
    </span>
  );
}

/* ---------- DID display (monospace, truncated, full copy) ---------- */

export function DidText({
  did,
  prefixChars = 14,
  suffixChars = 6,
}: {
  did: string;
  prefixChars?: number;
  suffixChars?: number;
}) {
  if (!did) return <span className="text-mute">n/a</span>;
  const head = did.slice(0, prefixChars);
  const tail = did.slice(-suffixChars);
  return (
    <span className="font-mono text-[13px]">
      {head}
      <span className="text-mute">…</span>
      {tail}
    </span>
  );
}

/* ---------- Spinner ---------- */

export function Spinner({ label = "Working…" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-body">
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
        />
      </svg>
      {label}
    </span>
  );
}

/* ---------- Error / info notes ---------- */

export function Note({
  tone = "warn",
  className = "",
  children,
}: {
  tone?: "warn" | "ok" | "error" | "info";
  className?: string;
  children: ReactNode;
}) {
  const styles: Record<string, string> = {
    warn: "border-amber-600/25 bg-tint-amber text-amber-600",
    ok: "border-leaf-600/25 bg-tint-leaf text-leaf-600",
    error: "border-rose-600/25 bg-tint-rose text-rose-600",
    info: "border-brand-500/25 bg-tint-brand text-brand-700",
  };
  return (
    <div
      className={`rounded-[12px] border px-4 py-3 text-[14px] leading-relaxed ${styles[tone]} ${className}`}
    >
      {children}
    </div>
  );
}