// Salva l'app sul telefono così si apre anche senza connessione
const CACHE = "cambiavoce-v8";
const FILES = ["./", "index.html", "voce-worklet.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  // Prima la rete, chiedendo sempre la versione aggiornata; senza connessione, la copia salvata
  e.respondWith(
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return r;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((m) => m || caches.match("./")))
  );
});
