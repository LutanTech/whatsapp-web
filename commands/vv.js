const {
    downloadMediaMessage
} = require("@whiskeysockets/baileys")

function getQuotedMedia(msg) {
    const content = msg?.message

    if (!content)
        return null

    const context =
        content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.audioMessage?.contextInfo ||
        content.documentMessage?.contextInfo

    const quoted = context?.quotedMessage

    if (!quoted)
        return null

    if (quoted.imageMessage)
        return { type: "image", message: quoted.imageMessage }

    if (quoted.videoMessage)
        return { type: "video", message: quoted.videoMessage }

    if (quoted.audioMessage)
        return { type: "audio", message: quoted.audioMessage }

    if (quoted.documentMessage)
        return { type: "document", message: quoted.documentMessage }

    return null
}

function getOwnerJid(sock) {
    const id = sock?.user?.id

    if (!id)
        throw new Error("Unable to determine bot number")

    return id.split(":")[0] + "@s.whatsapp.net"
}

const automaticSendInFlight = new Set()
const automaticSendCompleted = new Map()
const AUTOMATIC_SEND_TTL = 10 * 60 * 1000

function isInternalViewOnceMessage(message) {
    return String(message?.key?.id || "").startsWith("INTERNAL-VV-")
}

function claimAutomaticSend(message) {
    const key = String(message?.key?.id || "")

    if (!key)
        return true

    const completedAt = automaticSendCompleted.get(key)

    if (completedAt && Date.now() - completedAt < AUTOMATIC_SEND_TTL)
        return false

    if (completedAt)
        automaticSendCompleted.delete(key)

    if (automaticSendInFlight.has(key))
        return false

    automaticSendInFlight.add(key)
    return true
}

function releaseAutomaticSend(message, completed) {
    const key = String(message?.key?.id || "")

    if (!key)
        return

    automaticSendInFlight.delete(key)

    if (completed)
        automaticSendCompleted.set(key, Date.now())
}

async function executeMedia({
    sock,
    jid,
    media,
    replyMessage
}) {
    if (!sock)
        throw new Error("Baileys socket is unavailable")

    if (!media?.type || !media?.message) {
        if (jid) {
            await sock.sendMessage(
                jid,
                {
                    text: "❌ Reply to an ordinary photo, video, audio, or document with *.vv*"
                },
                replyMessage ? { quoted: replyMessage } : undefined
            )
        }

        return false
    }

    const isAutomatic = isInternalViewOnceMessage(replyMessage)

    if (isAutomatic && !claimAutomaticSend(replyMessage)) {
        console.warn(
            `[VV] Duplicate internal send suppressed: ${replyMessage.key.id}`
        )
        return true
    }

    let sentSuccessfully = false

    try {
        const ownerJid = getOwnerJid(sock)

        console.log(`[VV] Downloading ${media.type}`)

        const buffer = await downloadMediaMessage(
            {
                key: replyMessage?.key,
                message: {
                    [`${media.type}Message`]: media.message
                }
            },
            "buffer",
            {},
            {
                logger: console,
                reuploadRequest: sock.updateMediaMessage
            }
        )

        if (!buffer)
            throw new Error("Media download returned empty data")

        if (media.type === "image") {
            await sock.sendMessage(ownerJid, {
                image: buffer,
                caption: media.message.caption || "✅ Image"
            })
        } else if (media.type === "video") {
            await sock.sendMessage(ownerJid, {
                video: buffer,
                caption: media.message.caption || "✅ Video"
            })
        } else if (media.type === "audio") {
            await sock.sendMessage(ownerJid, {
                audio: buffer,
                mimetype: media.message.mimetype || "audio/mp4",
                ptt: media.message.ptt || false
            })
        } else if (media.type === "document") {
            await sock.sendMessage(ownerJid, {
                document: buffer,
                mimetype: media.message.mimetype || "application/octet-stream",
                fileName: media.message.fileName || "file"
            })
        } else {
            throw new Error(`Unsupported media type: ${media.type}`)
        }

        sentSuccessfully = true
        console.log(`[VV] ${media.type} sent to owner`)
        return true
    } catch (error) {
        console.error("[VV] Error:", error)

        if (jid) {
            await sock.sendMessage(
                jid,
                { text: `❌ Failed: ${error.message}` },
                replyMessage ? { quoted: replyMessage } : undefined
            ).catch(() => {})
        }

        return false
    } finally {
        if (isAutomatic)
            releaseAutomaticSend(replyMessage, sentSuccessfully)
    }
}

async function execute({
    sock,
    message,
    jid
}) {
    const media = getQuotedMedia(message)

    return executeMedia({
        sock,
        jid,
        media,
        replyMessage: message
    })
}

module.exports = {
    name: "vv",
    execute,
    executeMedia
}
