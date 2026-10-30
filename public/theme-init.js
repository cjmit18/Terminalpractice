// Apply the saved theme before first paint to avoid a flash. Values: "light" | "dark"; absent = follow OS.
// Loaded by index.html as a classic (blocking) script, from a file so the Content-Security-Policy needs no inline scripts.
try {
  var t = localStorage.getItem('certsim:theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
