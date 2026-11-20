// Service worker de EL COMPENDIO DEL BALUARTE (V6).
// Solo guarda en caché los archivos de la APLICACIÓN para que abra sin conexión.
// Nunca toca los datos del usuario (están en IndexedDB, que el service worker no lee ni borra).
const CACHE = "compendio-baluarte-v6-1";
const SHELL = ["./", "index.html", "app.js", "styles.css", "icon.svg", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("compendio-baluarte-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Caché primero (funciona sin conexión) y actualización en segundo plano.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(cached => {
    const network = fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => cached || (req.mode === "navigate" ? caches.match("index.html") : undefined));
    return cached || network;
  }));
});
