const fs = require("fs")
const path = require("path")
const https = require("https")
const { all, run } = require("./database")
const { getContact } = require("./sessions")
const { downloadMediaMessage, downloadContentFromMessage } = require("@whiskeysockets/baileys")

const MEDIA_DIR = path.join(process.cwd(), "public", "media")
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true })

const clean = v => v == null ? "" : String(v).trim()

function conversationKey(session, sender, receiver) {
    session = clean(session); sender = clean(sender); receiver = clean(receiver)
    if (!session || !sender || !receiver) return null
    return `${session}:${[sender, receiver].sort().join(":")}`
}

function groupConversationKey(session, jid) {
    session = clean(session); jid = clean(jid)
    return session && jid ? `${session}:group:${jid}` : null
}

function channelConversationKey(session, jid) {
    session = clean(session); jid = clean(jid)
    return session && jid ? `${session}:channel:${jid}` : null
}

function statusConversationKey(session, jid = "status@broadcast") {
    session = clean(session); jid = clean(jid) || "status@broadcast"
    return session ? `${session}:status:${jid}` : null
}

let messageEmitter = null

function setMessageEmitter(fn) {
    messageEmitter = typeof fn === "function" ? fn : null
}

function unwrapMessage(m) {
    if (!m) return null
    let c = m
    while (c) {
        if (c.ephemeralMessage?.message) c = c.ephemeralMessage.message
        else if (c.viewOnceMessage?.message) c = c.viewOnceMessage.message
        else if (c.viewOnceMessageV2?.message) c = c.viewOnceMessageV2.message
        else if (c.viewOnceMessageV2Extension?.message) c = c.viewOnceMessageV2Extension.message
        else if (c.documentWithCaptionMessage?.message) c = c.documentWithCaptionMessage.message
        else if (c.templateMessage?.hydratedTemplate) c = c.templateMessage.hydratedTemplate
        else if (c.templateMessage?.fourRowTemplate) c = c.templateMessage.fourRowTemplate
        else break
    }
    return c
}

function getMediaInfo(m) {
    const msg = unwrapMessage(m)
    if (!msg) return null

    if (msg.imageMessage) return { type: "image", data: msg.imageMessage }
    if (msg.videoMessage) return { type: "video", data: msg.videoMessage }
    if (msg.documentMessage) return { type: "document", data: msg.documentMessage }
    if (msg.audioMessage) return { type: "audio", data: msg.audioMessage }
    if (msg.stickerMessage) return { type: "sticker", data: msg.stickerMessage }

    return null
}

function extractText(data) {
    if (data.text) return data.text
    if (data.body) return data.body

    const m = unwrapMessage(data.message)
    if (!m) return ""

    return m.conversation ||
        m.extendedTextMessage?.text ||
        (m.imageMessage ? (m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : "[Image]") :
        m.videoMessage ? (m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : "[Video]") :
        m.documentMessage ? (m.documentMessage.caption ? `📄 ${m.documentMessage.caption}` : `📄 ${m.documentMessage.fileName || "[Document]"}`) :
        m.audioMessage ? "[Audio Note]" :
        m.stickerMessage ? "[Sticker]" : "")
}

function fetchUrlBuffer(url) {
    return new Promise((resolve) => {
        if (!url) return resolve(null)
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrlBuffer(res.headers.location).then(resolve)
            }
            if (res.statusCode !== 200) return resolve(null)
            const chunks = []
            res.on("data", chunk => chunks.push(chunk))
            res.on("end", () => resolve(Buffer.concat(chunks)))
            res.on("error", () => resolve(null))
        }).on("error", () => resolve(null))
    })
}

async function recordMessage(data) {
    const session = clean(data.session_id || data.sessionId || data.session) || "default"
    const key = data.key || {}
    const rawMessage = data.message

    if (!rawMessage || rawMessage.protocolMessage) return null

    const message = unwrapMessage(rawMessage) || rawMessage
    const fromMe = data.from_me !== undefined ? (data.from_me ? 1 : 0) : (key.fromMe ? 1 : 0)

    const jid = clean(
        data.jid ||
        data.chatJid ||
        key.remoteJid ||
        key.remoteJidAlt
    )

    if (!jid) return null

    const pushName = clean(
        data.pushName ||
        data.push_name ||
        data.verifiedBizName ||
        data.verifiedName
    )

    let sender = ""
    let receiver = ""
    let cKey = null
    let channelName = clean(data.channel_name || data.channelName)
    let groupName = clean(data.group_name || data.groupName || channelName)

    if (jid === "status@broadcast") {
        sender = clean(
            data.sender ||
            data.senderJid ||
            key.participant
        ) || "status@broadcast"

        receiver = jid
        cKey = statusConversationKey(session, jid)
    } else if (jid.endsWith("@g.us")) {
        sender = clean(
            data.sender ||
            data.senderJid ||
            key.participant
        ) || (fromMe ? session : jid)

        receiver = jid
        cKey = groupConversationKey(session, jid)

        if (!groupName && data.sock) {
            try {
                const meta = await data.sock.groupMetadata(jid)
                groupName = clean(meta?.subject)
            } catch {}
        }
    } else if (jid.endsWith("@newsletter")) {
        sender = clean(
            data.sender ||
            data.senderJid ||
            key.participant
        ) || jid

        receiver = jid
        cKey = channelConversationKey(session, jid)

        if (!groupName && data.sock && typeof data.sock.newsletterMetadata === "function") {
            try {
                const meta = await data.sock.newsletterMetadata("jid", jid)
                
                const extractName = (val) => typeof val === "string" ? val : (val?.text || "")
                groupName = clean(
                    extractName(meta?.name) ||
                    extractName(meta?.thread_metadata?.name) ||
                    extractName(meta?.subject)
                )
            } catch {}
        }
    } else {
        sender = fromMe
            ? session
            : clean(
                data.sender ||
                data.senderJid ||
                key.participant
            ) || jid

        receiver = fromMe ? jid : session
        cKey = conversationKey(session, sender, receiver)
    }

    if (!cKey) return null

    const savedContact = getContact(session, sender || jid)
    const ownerContact = getContact(session, session + "@s.whatsapp.net")
    const ownerName = clean(
        ownerContact?.name ||
        ownerContact?.verifiedName ||
        data.owner_name ||
        data.ownerName
    )
    const dataSenderName = clean(data.sender_name || data.senderName)
    const groupOrChannelName = clean(groupName || channelName)
    const safeDataSenderName =
        dataSenderName &&
        dataSenderName !== ownerName &&
        dataSenderName !== groupOrChannelName
            ? dataSenderName
            : ""
    const resolvedName = clean(
        savedContact?.name ||
        savedContact?.verifiedName
    )
    const safeResolvedName = resolvedName &&
        resolvedName !== ownerName &&
        resolvedName !== groupOrChannelName
        ? resolvedName
        : ""
    const senderName = fromMe
        ? safeResolvedName || ownerName || safeDataSenderName || pushName
        : safeResolvedName || pushName || safeDataSenderName

    const context =
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        null

    const quoted = context?.quotedMessage || null

    const quotedMsgId = clean(context?.stanzaId)
    const quotedSender = clean(context?.participant)

    const reaction = data.reaction
    const reaction_msg_id = data.reaction_msg_id

    const quotedText = clean(
        quoted?.conversation ||
        quoted?.extendedTextMessage?.text ||
        quoted?.imageMessage?.caption ||
        quoted?.videoMessage?.caption ||
        quoted?.documentMessage?.caption ||
        ""
    )

    const text = extractText(data)

    const createdAt = Number(
        data.created_at ||
        data.timestamp ||
        data.messageTimestamp ||
        Math.floor(Date.now() / 1000)
    )

    const msgId = clean(
        data.msg_id ||
        data.message_id ||
        key.id
    )

    if (msgId) {
        const existing = await all(
            `SELECT * FROM messages WHERE session_id=? AND msg_id=? LIMIT 1`,
            [session, msgId]
        )

        if (existing.length) return existing[0]
    }

    let mediaType = ""
    let mediaPath = ""
    let mimeType = ""
    let fileName = ""

    const media = getMediaInfo(rawMessage)

    if (media && data.sock) {
        try {
            mediaType = media.type
            mimeType = clean(media.data.mimetype)
            fileName = clean(media.data.fileName)

            let ext = "bin"

            if (mediaType === "image") ext = "jpg"
            else if (mediaType === "video") ext = "mp4"
            else if (mediaType === "audio") ext = "ogg"
            else if (mediaType === "sticker") ext = "webp"
            else if (fileName.includes(".")) ext = fileName.split(".").pop()
            else if (mimeType.includes("/")) ext = mimeType.split("/")[1].split(";")[0]

            ext = ext.replace(/[^a-zA-Z0-9]/g, "") || "bin"

            const safeId = (msgId || Date.now().toString()).replace(/[^\w.-]/g, "_")
            const filename = `${session}_${safeId}.${ext}`
            const fullPath = path.join(MEDIA_DIR, filename)

            let buffer = null

            // Tier 1: Unencrypted CDN fetch for Channel / Newsletter messages
            if (jid.endsWith("@newsletter") && media.data?.url) {
                try {
                    buffer = await fetchUrlBuffer(media.data.url)
                } catch {}
            }

            // Tier 2: Standard Baileys downloadMediaMessage (Decrypts Group & Private media)
            if (!buffer || buffer.length === 0) {
                try {
                    buffer = await downloadMediaMessage(
                        { message, key },
                        "buffer",
                        { reuploadRequest: data.sock.updateMediaMessage },
                        {
                            logger: {
                                debug() {},
                                info() {},
                                error() {},
                                warn() {}
                            }
                        }
                    )
                } catch (dlErr) {
                    console.warn("[MEDIA] downloadMediaMessage failed:", dlErr.message)
                }
            }

            // Tier 3: Baileys stream decoder fallback
            if (!buffer || buffer.length === 0) {
                try {
                    const stream = await downloadContentFromMessage(media.data, mediaType)
                    const chunks = []
                    for await (const chunk of stream) {
                        chunks.push(chunk)
                    }
                    buffer = Buffer.concat(chunks)
                } catch (streamErr) {
                    console.warn("[MEDIA] downloadContentFromMessage failed:", streamErr.message)
                }
            }

            if (buffer && buffer.length > 0) {
                fs.writeFileSync(fullPath, buffer)
                mediaPath = `/media/${filename}`
            }
        } catch (e) {
            console.error("[MEDIA] Download error:", e.message)
        }
    }

    const result = await run(`
        INSERT INTO messages
        (
            session_id,
            jid,
            sender,
            receiver,
            conversation_key,
            text,
            created_at,
            msg_id,
            from_me,
            push_name,
            sender_name,
            group_name,
            channel_name,
            media_type,
            media_path,
            mime_type,
            file_name,
            media_size,
            is_status,
            is_view_once,
            avatar,
            sender_avatar,
            chat_avatar,
            quoted_msg_id,
            quoted_sender,
            quoted_text,
            reaction,
            reaction_msg_id
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
        session,
        jid,
        sender,
        receiver,
        cKey,
        text,
        createdAt,
        msgId,
        fromMe,
        pushName,
        senderName,
        groupName,
        channelName,
        mediaType,
        mediaPath,
        mimeType,
        fileName,
        Number(data.media_size || media?.data?.fileLength || 0),
        data.is_status !== undefined
            ? (data.is_status ? 1 : 0)
            : (jid === "status@broadcast" ? 1 : 0),
        data.is_view_once ? 1 : 0,
        clean(data.avatar || data.chat_avatar),
        clean(data.sender_avatar),
        clean(data.chat_avatar || data.avatar),
        quotedMsgId,
        quotedSender,
        quotedText,
        reaction,
        reaction_msg_id
    ])

    const saved = {
        id: result.id,
        session_id: session,
        jid,
        sender,
        sender_name: senderName,
        receiver,
        conversation_key: cKey,
        text,
        created_at: createdAt,
        msg_id: msgId,
        from_me: fromMe,
        push_name: pushName,
        group_name: groupName,
        channel_name: channelName,
        avatar: clean(data.avatar || data.chat_avatar),
        sender_avatar: clean(data.sender_avatar),
        chat_avatar: clean(data.chat_avatar || data.avatar),
        media_type: mediaType,
        media_path: mediaPath,
        mime_type: mimeType,
        file_name: fileName,
        media_size: Number(data.media_size || media?.data?.fileLength || 0),
        is_status: data.is_status !== undefined
            ? (data.is_status ? 1 : 0)
            : (jid === "status@broadcast" ? 1 : 0),
        is_view_once: data.is_view_once ? 1 : 0,
        quoted_msg_id: quotedMsgId,
        quoted_sender: quotedSender,
        quoted_text: quotedText,
        reaction: reaction,
        reaction_msg_id: reaction_msg_id
    }

    if (messageEmitter) {
        try {
            messageEmitter(saved)
        } catch (e) {
            console.error("[EMIT]", e.message)
        }
    }

    return saved
}

module.exports = {
    recordMessage,
    conversationKey,
    groupConversationKey,
    channelConversationKey,
    statusConversationKey,
    extractText,
    setMessageEmitter
}