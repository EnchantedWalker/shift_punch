// Shift Punch service worker: lets the app open with no signal.
// App files: try the network first (so updates show up), fall back to the saved copy.
// Firebase SDK and fonts: versioned files, so the saved copy is used first.
// Firebase sign-in and database calls are never touched here; Firestore keeps its own offline copy.
const CACHE = "shiftpunch-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "firebase-config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const SDK = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) => "https://www.gstatic.com/firebasejs/10.12.2/" + f);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    await Promise.all(SDK.map((u) => c.add(new Request(u, { mode: "cors" })).catch(() => {})));
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(req) {
  return new Promise((resolve) => {
    let done = false;
    const fallback = () => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html"));
    const timer = setTimeout(() => { if (!done) fallback().then((r) => { if (r && !done) { done = true; resolve(r); } }); }, 3500);
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(() => { if (!done) fallback().then((r) => { done = true; clearTimeout(timer); resolve(r || Response.error()); }); });
  });
}
function cacheFirst(req) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) e.respondWith(cacheFirst(req));
  else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(cacheFirst(req));
});
