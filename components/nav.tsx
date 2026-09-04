"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LogoLockup } from "@/components/logo";

const LINKS = [
  { href: "/create", label: "Create" },
  { href: "/sign", label: "Sign" },
  { href: "/activity", label: "Activity" },
  { href: "/check", label: "Check" },
  { href: "/trustcore", label: "Trustcore" },
  { href: "/docs", label: "Docs" },
];

/** "Testnet · SOON" pill — the one dark accent in the nav, linking to the official teaser. */
export function TestnetSoon({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="https://flop.finance/teaser/"
      target="_blank"
      rel="noopener noreferrer"
      title="Flop Network testnet — planned Q4 2026 (per the official roadmap)"
      className={`inline-flex items-center gap-2 rounded-full bg-surface-dark px-3 text-on-dark transition-colors hover:bg-ink-deep ${
        compact ? "py-2.5" : "py-2"
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M9 3h6M10 3v6.5L4.5 19a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 9.5V3" />
      </svg>
      <span className="text-[13px] font-semibold tracking-tight">Testnet</span>
      <span className="rounded-full bg-white/15 px-2 py-0.5 font-mono text-[10px] tracking-wider text-on-dark-mute">
        SOON
      </span>
    </a>
  );
}

export function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-canvas/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-4 px-4">
        <Link
          href="/"
          className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink"
          onClick={() => setOpen(false)}
        >
          <LogoLockup mark={22} />
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`body-sm-strong rounded-full px-3 py-2 transition-colors ${
                  active ? "bg-ink text-on-primary" : "text-ink hover:bg-surface-soft"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
          <TestnetSoon />
        </nav>

        <button
          className="flex h-10 w-10 items-center justify-center rounded-full text-ink hover:bg-surface-soft active:bg-surface-soft md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Toggle menu"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      {open ? (
        <nav className="border-t border-hairline bg-canvas px-4 py-3 md:hidden" aria-label="Mobile">
          <div className="flex flex-col gap-1.5">
            {LINKS.map((l) => {
              const active = pathname === l.href;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className={`rounded-full px-5 py-3 text-[16px] ${
                    active ? "bg-ink text-on-primary" : "text-ink hover:bg-surface-soft active:bg-surface-soft"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
            <div className="px-5 pt-2">
              <TestnetSoon compact />
            </div>
          </div>
        </nav>
      ) : null}
    </header>
  );
}