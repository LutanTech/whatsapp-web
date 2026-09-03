const CACHE = "bot-admin-v2"

const ASSETS = [
    "/admin",
    "/manifest.json",
    "/logo/logo.jpeg"
]

self.addEventListener("install", event => {
    self.skipWaiting()
    event.waitUntil(
        caches.open(CACHE).then(cache => cache.addAll(ASSETS))
    )
})

self.addEventListener("activate", event => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(keys =>
                Promise.all(
                    keys
                        .filter(key => key !== CACHE)
                        .map(key => caches.delete(key))
                )
            )
        ])
    )
})

self.addEventListener("fetch", event => {
    const request = event.request
    const url = new URL(request.url)

    if (request.method !== "GET" || url.origin !== self.location.origin)
        return

    event.respondWith(
        fetch(request).then(response => {
            if (response.ok) {
                const copy = response.clone()
                caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {})
            }
            return response
        }).catch(() =>
            caches.match(request).then(cached =>
                cached || (request.mode === "navigate" ? caches.match("/admin") : Response.error())
            )
        )
    )
})
