const CACHE = "bot-admin-v1"

const ASSETS = [
    "/admin",
    "/manifest.json",
    "/logo/logo.jpeg"
]

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE).then(cache => cache.addAll(ASSETS))
    )
})

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE)
                    .map(key => caches.delete(key))
            )
        )
    )
})

self.addEventListener("fetch", event => {
    event.respondWith(
        fetch(event.request).catch(() =>
            caches.match(event.request)
        )
    )
})