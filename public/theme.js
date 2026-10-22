// Applies the saved theme before first paint, so the page never flashes the other theme.
// Loaded as a plain, synchronous script in <head> (not inline, so the Content-Security-Policy needs
// no hash for it). Values: "light" | "dark"; absent = follow the OS. src/lib/theme.ts keeps it in sync.
try {
  var t = localStorage.getItem('certsim:theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
