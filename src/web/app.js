// Keeps the masthead usage gauge current. The only client script; same-origin only.
const REFRESH_MS = 60_000;

async function refreshUsage() {
  const el = document.getElementById('usage');
  if (!el || document.hidden) return;
  try {
    const res = await fetch('/api/usage', { cache: 'no-store' });
    if (!res.ok) return;
    const { html } = await res.json();
    el.outerHTML = html;
  } catch {
    /* offline or server stopped: keep what we have */
  }
}

setInterval(refreshUsage, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUsage(); });
