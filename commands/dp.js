function normalizeJid(jid) {
    return jid ? String(jid).replace(/:\d+@/, "@") : ""
}

function numberToJid(value) {
    const number = String(value || "").replace(/\D/g, "")
    return number ? `${number}@s.whatsapp.net` : ""
}

function getQuotedContext(message) {
    let content = message?.message

    while (content) {
        if (content.ephemeralMessage?.message) {
            content = content.ephemeralMessage.message
        } else if (content.viewOnceMessage?.message) {
            content = content.viewOnceMessage.message
        } else if (content.viewOnceMessageV2?.message) {
            content = content.viewOnceMessageV2.message
        } else if (content.viewOnceMessageV2Extension?.message) {
            content = content.viewOnceMessageV2Extension.message
        } else {
            break
        }
    }

    return content?.extendedTextMessage?.contextInfo || null
}

function getTargetJid({ message, jid, sender, args }) {
    const rawArg = (args || []).join(" ")
    const explicitNumber = rawArg.replace(/\D/g, "")

    if (explicitNumber.length >= 8)
        return numberToJid(explicitNumber)

    const context = getQuotedContext(message)
    const quotedParticipant =
        context?.participant ||
        context?.participantAlt ||
        ""

    const mentionedJid = context?.mentionedJid?.[0] || ""
    const quotedTarget = quotedParticipant || mentionedJid

    if (quotedTarget)
        return normalizeJid(quotedTarget)

    if (jid?.endsWith("@g.us"))
        return normalizeJid(sender || "")

    return normalizeJid(sender || jid || "")
}

const dpInFlight = new Set()
const dpCompleted = new Map()
const DP_DEDUPE_TTL = 10 * 60 * 1000

function claimDpRequest(requestKey) {
    if (!requestKey)
        return true

    const completedAt = dpCompleted.get(requestKey)

    if (completedAt && Date.now() - completedAt < DP_DEDUPE_TTL)
        return false

    if (completedAt)
        dpCompleted.delete(requestKey)

    if (dpInFlight.has(requestKey))
        return false

    dpInFlight.add(requestKey)
    return true
}

function finishDpRequest(requestKey) {
    if (!requestKey)
        return

    dpInFlight.delete(requestKey)
    dpCompleted.set(requestKey, Date.now())
}

const dpCommand = {
    name: "dp",

    async execute({
        sock,
        message,
        jid,
        sender,
        args,
        getProfilePictureUrl
    }) {
        const requestKey = `${jid || ""}:${message?.key?.id || ""}`

        if (!claimDpRequest(requestKey)) {
            console.warn(`[DP] Duplicate request suppressed: ${requestKey}`)
            return
        }

        try {
            const targetJid = getTargetJid({
                message,
                jid,
                sender,
                args
            })

            if (!targetJid) {
                await sock.sendMessage(
                    jid,
                    {
                        text: "❌ Reply to someone, @mention them, or use .dp <number> to get their DP."
                    },
                    { quoted: message }
                )
                return
            }

            await sock.sendMessage(
                jid,
                { react: { text: "⏳", key: message.key } }
            ).catch(() => {})

                const profilePictureUrl = await sock
                .profilePictureUrl(targetJid, "image")
                .catch(() => "")

            if (!profilePictureUrl) {
                await sock.sendMessage(
                    jid,
                    {
                        text: "❌ No profile picture found or privacy settings prevent downloading."
                    },
                    { quoted: message }
                )
                return
            }

            const savedName =
                typeof getContactName === "function"
                    ? String(getContactName(targetJid) || "").trim()
                    : ""

            const displayName =
                savedName || `@${targetJid.split("@")[0]}`

            console.log(
                `[DP] Sending real image for ${targetJid} as ${displayName}`
            )

            await sock.sendMessage(
                jid,
                {
                    image: { url: profilePictureUrl },
                    caption: `*Profile Picture — to ${displayName}*`,
                    mentions: [targetJid]
                },
                { quoted: message }
            )

            await sock.sendMessage(
                jid,
                { react: { text: "✅", key: message.key } }
            ).catch(() => {})
        } catch (error) {
            console.error("[DP] Command error:", error?.stack || error)

            await sock.sendMessage(
                jid,
                { text: `❌ Error: ${error.message}` },
                { quoted: message }
            ).catch(() => {})
        } finally {
            finishDpRequest(requestKey)
        }
    }
}

module.exports = dpCommand
