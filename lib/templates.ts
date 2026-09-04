/**
 * Generated check-in templates, cached in this browser so a user rarely calls
 * the AI twice. Snapshot store with stable identity (hydration-safe), the same
 * pattern as receipts.
 */

import type { GeneratedTemplates } from "./personalize";

const KEY = "floptools.templates.v1";
const EVENT = "floptools:templates";

let parsed: { raw: string; value: GeneratedTemplates | null } | null = null;

function read(): GeneratedTemplates | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY) ?? "";
    if (!parsed || parsed.raw !== raw) {
      let value: GeneratedTemplates | null = null;
      if (raw) {
        try {
          value = JSON.parse(raw) as GeneratedTemplates;
        } catch {
          value = null;
        }
      }
      parsed = { raw, value };
    }
    return parsed.value;
  } catch {
    return null;
  }
}

export function getTemplatesSnapshot(): GeneratedTemplates | null {
  return read();
}

export function subscribeTemplates(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function saveTemplates(value: GeneratedTemplates): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function clearTemplates(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}