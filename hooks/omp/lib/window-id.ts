// Shared kitty-window helper — mirrors the kitty-window beacon lines in hooks/claude/mailbox-inject.mjs.
// The omp beacon carries the window so agent-send can route to an omp tab's
// mailbox key and an omp-hosted lookup can exclude
// its own beacon.
export const kittyWindowId = (): number | null => {
  const raw = process.env.KITTY_WINDOW_ID;
  const win = raw != null && raw !== "" ? Number(raw) : null;
  return win !== null && Number.isFinite(win) ? win : null;
};
