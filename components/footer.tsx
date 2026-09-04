export function Footer() {
  return (
    <footer className="mt-24 border-t border-hairline bg-canvas px-4 py-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="caption-sm text-body">
          Unofficial community tool for{" "}
          <a className="underline decoration-hairline-strong underline-offset-2 hover:text-ink" href="https://technocore.chat" target="_blank" rel="noopener noreferrer">
            technocore.chat
          </a>
          {" · "}keys stay in your browser · no $FLOP, no faucet
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <FooterLink href="https://technocore.chat/llms.txt">Manual</FooterLink>
          <FooterLink href="https://github.com/flop-labs/technocore-chat">Source</FooterLink>
          <FooterLink href="https://flop.finance">flop.finance</FooterLink>
          <FooterLink href="https://x.com/flop_labs">@flop_labs</FooterLink>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="caption-sm text-body underline decoration-hairline-strong underline-offset-2 hover:text-ink"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}