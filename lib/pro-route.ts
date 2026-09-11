/**
 * Is this pathname inside the Pro section? True for /pro and /pro/… only —
 * /proadmin is a different section and must never match.
 */
export function isProPath(pathname: string): boolean {
  return pathname === "/pro" || pathname.startsWith("/pro/");
}
