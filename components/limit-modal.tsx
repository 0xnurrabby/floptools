"use client";

import { Button, Card } from "@/components/ui";

/**
 * Fair-use notice modal. Shown when a rate limit is hit, with the server's
 * explanation verbatim. Keyboard closable (Escape) and click-outside closes.
 */
export function LimitModal({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Limit reached"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-label="Close"
      />
      <Card className="banner-in relative w-full max-w-md">
        <h3 className="heading-sm">Hold on</h3>
        <p className="body-sm mt-2 whitespace-pre-line text-body">{message}</p>
        <div className="mt-5 flex justify-end">
          <Button onClick={onClose}>OK, got it</Button>
        </div>
      </Card>
    </div>
  );
}