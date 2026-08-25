const avatarCache = new Map()
const AVATAR_CACHE_TTL = 15 * 60 * 1000

function normalizeJid(jid) {
    return jid ? String(jid).replace(/:\d+@/, "@") : ""
}

function withTimeout(promise, milliseconds = 3500) {
    let timer

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error("Profile-picture lookup timed out")),
            milliseconds
        )
    })

    return Promise.race([promise, timeout]).finally(() => {
        clearTimeout(timer)
    })
}

async function getProfilePictureUrl(sock, jid) {
    if (!sock || !jid) return ""

    const original = String(jid)
    const normalized = normalizeJid(original)
    const cached = avatarCache.get(original) || avatarCache.get(normalized)

    if (
        cached &&
        Date.now() - cached.timestamp < AVATAR_CACHE_TTL
    ) {
        return cached.url
    }

    const targets = [
        ...new Set([original, normalized].filter(Boolean))
    ]

    // Preview is intentionally tried first. It is smaller and is the value
    // used by the admin UI for chat/contact avatars.
    for (const target of targets) {
        for (const type of ["preview", "image"]) {
            try {
                const url = await withTimeout(
                    sock.profilePictureUrl(target, type)
                )

                if (url) {
                    const value = {
                        url,
                        type,
                        timestamp: Date.now()
                    }

                    avatarCache.set(original, value)
                    avatarCache.set(normalized, value)
                    return url
                }
            } catch {}
        }
    }

    const empty = {
        url: "",
        type: "preview",
        timestamp: Date.now()
    }

    avatarCache.set(original, empty)
    avatarCache.set(normalized, empty)
    return ""
}

const fullAvatarCache = new Map()

async function getFullProfilePictureUrl(sock, jid) {
    if (!sock || !jid) return ""

    const original = String(jid)
    const normalized = normalizeJid(original)
    const cached = fullAvatarCache.get(original) || fullAvatarCache.get(normalized)

    if (cached && Date.now() - cached.timestamp < AVATAR_CACHE_TTL)
        return cached.url

    for (const target of [...new Set([original, normalized].filter(Boolean))]) {
        try {
            const url = await withTimeout(
                sock.profilePictureUrl(target, "image")
            )

            if (url) {
                const value = { url, timestamp: Date.now() }
                fullAvatarCache.set(original, value)
                fullAvatarCache.set(normalized, value)
                return url
            }
        } catch {}
    }

    const empty = { url: "", timestamp: Date.now() }
    fullAvatarCache.set(original, empty)
    fullAvatarCache.set(normalized, empty)
    return ""
}

function clearAvatarCache(jid) {
    if (!jid) return
    avatarCache.delete(String(jid))
    avatarCache.delete(normalizeJid(jid))
    fullAvatarCache.delete(String(jid))
    fullAvatarCache.delete(normalizeJid(jid))
}

module.exports = {
    getProfilePictureUrl,
    getFullProfilePictureUrl,
    clearAvatarCache,
    normalizeJid
}
