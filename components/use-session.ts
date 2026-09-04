"use client";

import { useSyncExternalStore } from "react";
import { getUnlocked, subscribeKeyring } from "@/lib/keyring";

export interface Session {
  did: string | null;
  createdAt: string | null;
}

/** Reactive view of the in-memory keyring. Re-renders on create/unlock/lock. */
export function useSession(): Session {
  const did = useSyncExternalStore(
    subscribeKeyring,
    () => getUnlocked()?.did ?? null,
    () => null, // server snapshot — keyring only exists in the browser
  );
  const unlocked = getUnlocked();
  return {
    did,
    createdAt: unlocked?.createdAt ?? null,
  };
}

export { getUnlocked } from "@/lib/keyring";