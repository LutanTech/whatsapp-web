const { getCommand } = require("./commands")
const { recordMessage } = require("./messages")
const { getProfilePictureUrl } = require("./avatars")
const { inspect } = require("util")

const { downloadMediaMessage } = require("@whiskeysockets/baileys")
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const sharp = require("sharp")

// -------------------------------------------------------------
// DEBUG LOG FILE SETUP
// -------------------------------------------------------------
const LOG_FILE = path.join(__dirname, "bot_debug.log")
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" })

function writeLogToFile(level, args) {
    const timestamp = new Date().toISOString()
    const formattedArgs = args.map(arg => {
        if (typeof arg === "string") return arg
        if (arg instanceof Error) return arg.stack || arg.message
        try {
            return JSON.stringify(arg)
        } catch {
            return inspect(arg, { depth: 4 })
        }
    }).join(" ")

    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${formattedArgs}\n`
    logStream.write(logLine)
}

const originalLog = console.log
const originalError = console.error
const originalWarn = console.warn
const originalInfo = console.info

console.log = (...args) => {
    writeLogToFile("info", args)
    originalLog.apply(console, args)
}

console.error = (...args) => {
    writeLogToFile("error", args)
    originalError.apply(console, args)
}

console.warn = (...args) => {
    writeLogToFile("warn", args)
    originalWarn.apply(console, args)
}

console.info = (...args) => {
    writeLogToFile("info", args)
    originalInfo.apply(console, args)
}

console.log("[LOGGER] Debug log file initialized at:", LOG_FILE)

// -------------------------------------------------------------
// CONFIG & DIRECTORIES
// -------------------------------------------------------------
const PREFIX = process.env.PREFIX || "."
const groupCache = new Map()
const channelCache = new Map()
const commandInFlight = new Set()
const commandCompleted = new Map()
const COMMAND_DEDUPE_TTL = 10 * 60 * 1000

const MEDIA_DIR = path.join(__dirname, "uploads")
const IMAGE_DIR = path.join(MEDIA_DIR, "images")
const VIDEO_DIR = path.join(MEDIA_DIR, "videos")
const AUDIO_DIR = path.join(MEDIA_DIR, "audio")
const DOC_DIR = path.join(MEDIA_DIR, "documents")
const STICKER_DIR = path.join(MEDIA_DIR, "stickers")
const STATUS_DIR = path.join(MEDIA_DIR, "statuses")
const VIEW_ONCE_DIR = path.join(MEDIA_DIR, "viewonce")

for (const d of [
    IMAGE_DIR,
    VIDEO_DIR,
    AUDIO_DIR,
    DOC_DIR,
    STICKER_DIR,
    STATUS_DIR,
    VIEW_ONCE_DIR
]) fs.mkdirSync(d, { recursive: true })

// -------------------------------------------------------------
// UTILITY & CONTACT FUNCTIONS
// -------------------------------------------------------------
function normalizeJid(jid) {
    return jid ? jid.replace(/:\d+@/, "@") : ""
}

function getOwnerJid(sock) {
    const id = sock?.user?.id
    if (!id) return ""
    return id.split(":")[0] + "@s.whatsapp.net"
}

function unwrapMessage(message) {
    let c = message?.message
    let depth = 0

    while (c && depth < 10) {
        depth++
        if (c.ephemeralMessage?.message)
            c = c.ephemeralMessage.message
        else if (c.viewOnceMessage?.message)
            c = c.viewOnceMessage.message
        else if (c.viewOnceMessageV2?.message)
            c = c.viewOnceMessageV2.message
        else if (c.viewOnceMessageV2Extension?.message)
            c = c.viewOnceMessageV2Extension.message
        else break
    }

    return c || null
}

function isViewOnceMessage(message) {
    if (message?.key?.isViewOnce) return true

    let c = message?.message
    let depth = 0

    while (c && depth < 10) {
        depth++
        if (
            c.viewOnceMessage?.message ||
            c.viewOnceMessageV2?.message ||
            c.viewOnceMessageV2Extension?.message
        ) return true

        if (c.ephemeralMessage?.message)
            c = c.ephemeralMessage.message
        else break
    }

    return false
}

function isStatusMessage(message) {
    const key = message?.key || {}

    return key.remoteJid === "status@broadcast" ||
        key.remoteJidAlt === "status@broadcast" ||
        key.participant === "status@broadcast" ||
        key.participantAlt === "status@broadcast"
}

function getMediaInfo(c) {
    const list = [
        ["image", c?.imageMessage],
        ["video", c?.videoMessage],
        ["audio", c?.audioMessage],
        ["document", c?.documentMessage],
        ["sticker", c?.stickerMessage]
    ]

    for (const [type, data] of list) {
        if (data)
            return {
                type,
                mimetype: data.mimetype || "",
                fileName: data.fileName || "",
                size: Number(data.fileLength || 0)
            }
    }

    return {
        type: "",
        mimetype: "",
        fileName: "",
        size: 0
    }
}

function getMessageContent(message) {
    return unwrapMessage(message)
}

function getText(message) {
    const c = unwrapMessage(message)
    if (!c) return ""

    return (
        c.conversation ||
        c.extendedTextMessage?.text ||
        c.imageMessage?.caption ||
        c.videoMessage?.caption ||
        c.documentMessage?.caption ||
        c.audioMessage?.caption ||
        c.buttonsResponseMessage?.selectedButtonId ||
        c.buttonsResponseMessage?.selectedDisplayText ||
        c.templateButtonReplyMessage?.selectedId ||
        c.templateButtonReplyMessage?.selectedDisplayText ||
        c.listResponseMessage?.singleSelectReply?.selectedRowId ||
        c.listResponseMessage?.title ||
        ""
    )
}

function getMessageText(message) {
    if (!message) return ""

    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.audioMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        message.templateButtonReplyMessage?.selectedDisplayText ||
        ""
    )
}

function getContact(session, jid) {
    if (!jid) return null

    const sock = session?.sock
    const normalized = normalizeJid(jid)
    const phone = normalized.split("@")[0]

    const contacts =
        session?.contacts ||
        session?.store?.contacts ||
        sock?.store?.contacts ||
        sock?.contacts ||
        {}

    if (contacts instanceof Map) {
        const direct =
            contacts.get(jid) ||
            contacts.get(normalized) ||
            contacts.get(`${phone}@s.whatsapp.net`)

        if (direct)
            return direct

        return Array.from(contacts.values()).find(contact =>
            contact?.id === jid ||
            contact?.id === normalized ||
            contact?.lid === jid ||
            contact?.lid === normalized ||
            contact?.pn === jid ||
            contact?.pn === normalized ||
            String(contact?.phoneNumber || "") === phone
        ) || null
    }

    return (
        contacts[jid] ||
        contacts[normalized] ||
        contacts[`${phone}@s.whatsapp.net`] ||
        Object.values(contacts).find(c =>
            c?.id === jid ||
            c?.id === normalized ||
            c?.lid === jid ||
            c?.pn === jid ||
            c?.phoneNumber === phone
        ) ||
        null
    )
}

function getContactName(session, jid) {
    if (!jid) return ""

    const c = getContact(session, jid)

    return c?.name || c?.verifiedName || ""
}

function findContact(session, query) {
    if (!query) return null

    const rawContacts =
        session?.contacts ||
        session?.store?.contacts ||
        session?.sock?.store?.contacts ||
        session?.sock?.contacts ||
        {}

    const contactsList = rawContacts instanceof Map
        ? Array.from(rawContacts.values())
        : Object.values(rawContacts)

    const q = String(query).trim().toLowerCase()
    const cleanPhone = q.replace(/[^0-9]/g, "")

    return contactsList.find(c => {
        if (!c || (!c.name && !c.verifiedName)) return false

        const cId = c.id ? String(c.id).toLowerCase() : ""
        const cPhone = c.phoneNumber ? String(c.phoneNumber) : ""
        const cName = c.name ? String(c.name).toLowerCase() : ""
        const cVerified = c.verifiedName ? String(c.verifiedName).toLowerCase() : ""

        return (
            cId === q ||
            (cleanPhone && cPhone && cPhone.includes(cleanPhone)) ||
            cName.includes(q) ||
            cVerified.includes(q)
        )
    }) || null
}

function searchContacts(session, query = "") {
    const rawContacts =
        session?.contacts ||
        session?.store?.contacts ||
        session?.sock?.store?.contacts ||
        session?.sock?.contacts ||
        {}

    const contactsList = rawContacts instanceof Map
        ? Array.from(rawContacts.values())
        : Object.values(rawContacts)

    const savedContacts = contactsList.filter(c => Boolean(c?.name || c?.verifiedName))
    if (!query) return savedContacts

    const q = String(query).trim().toLowerCase()
    const cleanPhone = q.replace(/[^0-9]/g, "")

    return savedContacts.filter(c => {
        const cId = c.id ? String(c.id).toLowerCase() : ""
        const cPhone = c.phoneNumber ? String(c.phoneNumber) : ""
        const cName = c.name ? String(c.name).toLowerCase() : ""
        const cVerified = c.verifiedName ? String(c.verifiedName).toLowerCase() : ""

        return (
            cId.includes(q) ||
            (cleanPhone && cPhone.includes(cleanPhone)) ||
            cName.includes(q) ||
            cVerified.includes(q)
        )
    })
}

function validSenderName(name) {
    if (!name) return false
    name = String(name).trim()
    if (name.length < 1 || name.length > 80) return false
    return true
}

function cleanSenderName(name, fallback = "") {
    if (validSenderName(name))
        return String(name).trim()

    if (validSenderName(fallback))
        return String(fallback).trim()

    return ""
}

// -------------------------------------------------------------
// METADATA & AVATAR FETCHERS
// -------------------------------------------------------------


async function getGroupMetadata(sock, jid) {
    if (!sock || !jid?.endsWith("@g.us"))
        return ""

    const cached = groupCache.get(jid)

    if (
        cached &&
        Date.now() - cached.timestamp < 30 * 60 * 1000
    ) return cached.name

    try {
        const metadata = await sock.groupMetadata(jid)
        const name = metadata?.subject || ""

        groupCache.set(jid, {
            name,
            timestamp: Date.now()
        })

        return name
    } catch {
        return ""
    }
}

function parseNewsletterMeta(meta) {
    if (!meta || typeof meta !== "object") return { name: "", icon: "" }

    const text = v => {
        if (!v) return ""
        if (typeof v === "string") return v.trim()
        if (typeof v?.text === "string") return v.text.trim()
        return ""
    }

    const name =
        text(meta.name) ||
        text(meta.thread_metadata?.name) ||
        text(meta.subject)

    let icon = ""

    if (typeof meta.picture === "string")
        icon = meta.picture
    else if (typeof meta.picture?.url === "string")
        icon = meta.picture.url
    else if (typeof meta.thread_metadata?.picture?.url === "string")
        icon = meta.thread_metadata.picture.url
    else if (typeof meta.preview === "string")
        icon = meta.preview

    return { name, icon }
}

async function getChannelMetadata(sock, jid) {
    if (!sock || !jid?.endsWith("@newsletter"))
        return { name: "", icon: "" }

    const cached = channelCache.get(jid)

    if (
        cached &&
        Date.now() - cached.timestamp < 30 * 60 * 1000
    ) return cached

    try {
        if (typeof sock.newsletterMetadata !== "function")
            return { name: "", icon: "" }

        const meta = await sock.newsletterMetadata(
            "jid",
            jid
        )

        const result = parseNewsletterMeta(meta)

        if (result.name)
            channelCache.set(jid, {
                ...result,
                timestamp: Date.now()
            })

        return result
    } catch {
        return { name: "", icon: "" }
    }
}

// -------------------------------------------------------------
// COMMAND & MEDIA PROCESSING
// -------------------------------------------------------------
async function deleteCommand(sock, message) {
    if (!sock?.sendMessage || !message?.key) return

    // try {
    //     await sock.sendMessage(
    //         message.key.remoteJid,
    //         { delete: message.key }
    //     )
    // } catch (e) {
    //     console.error("[CMD]", e.message)
    // }
}

async function executeCommand(
    session,
    message,
    jid,
    sender,
    text
) {
    const body = text.slice(PREFIX.length).trim()
    if (!body) return false

    const parts = body.split(/\s+/)
    const name = parts.shift()?.toLowerCase()
    const command = getCommand?.(name)

    if (!command) return false

    const messageId = message?.key?.id
    const requestKey = `${session?.id || "default"}:${jid}:${messageId || "no-id"}:${name}`
    const completedAt = commandCompleted.get(requestKey)

    if (
        commandInFlight.has(requestKey) ||
        (completedAt && Date.now() - completedAt < COMMAND_DEDUPE_TTL)
    ) {
        console.warn(`[CMD] Duplicate command suppressed: ${requestKey}`)
        return false
    }

    if (completedAt)
        commandCompleted.delete(requestKey)

    commandInFlight.add(requestKey)

    try {
        await command.execute({
            sock: session.sock,
            session,
            message,
            jid,
            sender,
            text,
            args: parts,
            isGroup: jid.endsWith("@g.us"),
            command: name,
            getProfilePictureUrl,
            getContactName: targetJid => getContactName(session, targetJid)
        })

        return true
    } finally {
        commandInFlight.delete(requestKey)
        commandCompleted.set(requestKey, Date.now())
    }
}

async function downloadMedia(message) {
    try {
        const content = unwrapMessage(message)
        if (!content) return null

        const media =
            content.imageMessage ||
            content.videoMessage ||
            content.audioMessage ||
            content.documentMessage ||
            content.stickerMessage

        if (!media) return null

        const buffer = await downloadMediaMessage(
            {
                key: message.key,
                message: content
            },
            "buffer",
            {},
            {
                logger: console,
                reuploadRequest: async () => message.key
            }
        )

        if (!buffer?.length) return null

        return {
            buffer,
            media,
            content
        }
    } catch (e) {
        console.error("[MEDIA]", e.message)
        return null
    }
}

async function compressImage(buffer, file) {
    await sharp(buffer)
        .rotate()
        .resize({
            width: 1280,
            height: 1280,
            fit: "inside",
            withoutEnlargement: true
        })
        .jpeg({
            quality: 78,
            progressive: true,
            mozjpeg: true
        })
        .toFile(file)
}

function compressVideo(buffer, file) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            "-i", "pipe:0",
            "-vf",
            "scale=w=1280:h=1280:force_original_aspect_ratio=decrease",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "27",
            "-c:a", "aac",
            "-b:a", "96k",
            "-movflags", "+faststart",
            "-y",
            file
        ])

        let error = ""

        ffmpeg.stderr.on("data", d => error += d.toString())
        ffmpeg.on("error", reject)

        ffmpeg.on("close", code => {
            if (code === 0) resolve(file)
            else reject(new Error(error || `FFmpeg exited with ${code}`))
        })

        ffmpeg.stdin.on("error", () => {})
        ffmpeg.stdin.write(buffer, () => {
            ffmpeg.stdin.end()
        })
    })
}

async function compressAudio(buffer, file) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            "-i", "pipe:0",
            "-c:a", "aac",
            "-b:a", "96k",
            "-ar", "44100",
            "-ac", "2",
            "-y",
            file
        ])

        let error = ""

        ffmpeg.stderr.on("data", d => error += d.toString())
        ffmpeg.on("error", reject)

        ffmpeg.on("close", code => {
            if (code === 0) resolve(file)
            else reject(new Error(error || `FFmpeg exited with ${code}`))
        })

        ffmpeg.stdin.on("error", () => {})
        ffmpeg.stdin.write(buffer, () => {
            ffmpeg.stdin.end()
        })
    })
}

async function saveMedia(
    message,
    type,
    directory,
    prefix
) {
    try {
        const result = await downloadMedia(message)
        if (!result) return ""

        const { buffer, media } = result

        fs.mkdirSync(directory, { recursive: true })

        const id =
            message.key?.id ||
            `${Date.now()}_${Math.random().toString(36).slice(2)}`

        let file = ""

        if (type === "image") {
            file = path.join(directory, `${prefix}_${id}.jpg`)
            await compressImage(buffer, file)
        } else if (type === "video") {
            file = path.join(directory, `${prefix}_${id}.mp4`)
            await compressVideo(buffer, file)
        } else if (type === "audio") {
            file = path.join(directory, `${prefix}_${id}.m4a`)
            await compressAudio(buffer, file)
        } else if (type === "sticker") {
            file = path.join(directory, `${prefix}_${id}.webp`)
            await sharp(buffer)
                .resize({
                    width: 512,
                    height: 512,
                    fit: "inside",
                    withoutEnlargement: true
                })
                .webp({ quality: 75 })
                .toFile(file)
        } else if (type === "document") {
            const ext = path.extname(media.fileName || "").replace(".", "") || "bin"
            file = path.join(directory, `${prefix}_${id}.${ext}`)
            fs.writeFileSync(file, buffer)
        } else return ""

        return `/uploads/${path.relative(MEDIA_DIR, file).replace(/\\/g, "/")}`
    } catch (e) {
        console.error("[SAVE MEDIA]", e.message)
        return ""
    }
}


// -------------------------------------------------------------
// MAIN MESSAGE HANDLER
// -------------------------------------------------------------
async function handleMessage(session, message) {
    try {
        if (!message) return

        const key = message.key || {}


        const isStatus = isStatusMessage(message)
        const jid = isStatus
            ? "status@broadcast"
            : key.remoteJidAlt || key.remoteJid

        if (!jid) return

        const content = unwrapMessage(message)
        if (!content) return

        const reaction = content.reactionMessage
        if (message.message?.protocolMessage && !reaction) return

        const sender =
            key.participant ||
            key.participantAlt ||
            key.remoteJidAlt ||
            key.remoteJid ||
            jid

        const text = (getText(message) || "").trim()

        if (text.startsWith(PREFIX)) {
            if (key.fromMe) {
                await deleteCommand(session.sock, message)

                try {
                    await executeCommand(session, message, jid, sender, text)
                } catch (e) {
                    console.error("[CMD]", e.message)
                }
            }
            return
        }

        let groupName = ""
        let channelName = ""
        let chatAvatar = ""
        let senderAvatar = ""

        if (isStatus) {
            chatAvatar = await getProfilePictureUrl(session.sock, sender)
        } else if (jid.endsWith("@g.us")) {
            groupName = await getGroupMetadata(session.sock, jid)
            chatAvatar = await getProfilePictureUrl(session.sock, jid)
        } else if (jid.endsWith("@newsletter")) {
            const meta = await getChannelMetadata(session.sock, jid)
            channelName = meta.name
            groupName = meta.name
            chatAvatar = meta.icon || await getProfilePictureUrl(session.sock, jid)
        } else {
            chatAvatar = await getProfilePictureUrl(session.sock, jid)
        }

        senderAvatar =
            sender && sender !== jid
            ? await getProfilePictureUrl(session.sock, sender)
            : chatAvatar

        const ownerName = cleanSenderName(
            session.sock?.user?.name,
            ""
        )
        const resolvedSenderName = cleanSenderName(
            getContactName(session, sender),
            ""
        )
        const safeResolvedSenderName =
            resolvedSenderName &&
            resolvedSenderName !== ownerName &&
            resolvedSenderName !== groupName &&
            resolvedSenderName !== channelName
                ? resolvedSenderName
                : ""
        const senderName = key.fromMe
            ? cleanSenderName(safeResolvedSenderName, channelName)
            : cleanSenderName(
                safeResolvedSenderName,
                message.pushName || channelName
            )

        const context =
            content.extendedTextMessage?.contextInfo ||
            content.imageMessage?.contextInfo ||
            content.videoMessage?.contextInfo ||
            content.audioMessage?.contextInfo ||
            content.documentMessage?.contextInfo ||
            content.stickerMessage?.contextInfo ||
            content.buttonsResponseMessage?.contextInfo ||
            content.listResponseMessage?.contextInfo ||
            null

        const quoted = context?.quotedMessage || null
        const quotedSender = context?.participant || ""
        const quotedText = getMessageText(quoted)

        const quotedSenderName =
            quotedSender
            ? cleanSenderName(
                getContactName(session, quotedSender),
                ""
            )
            : ""

        const reactionText = reaction?.text || ""
        const reactionMsgId = reaction?.key?.id || ""

        const media = getMediaInfo(content)
        let mediaPath = ""

        if (media.type) {
            const dir =
                isStatus
                ? STATUS_DIR
                : media.type === "image"
                ? IMAGE_DIR
                : media.type === "video"
                ? VIDEO_DIR
                : media.type === "audio"
                ? AUDIO_DIR
                : media.type === "document"
                ? DOC_DIR
                : STICKER_DIR

            mediaPath = await saveMedia(
                message,
                media.type,
                dir,
                isStatus ? "status" : media.type
            )
        }

        await recordMessage({
            session_id: session.id || "default",
            jid,
            sender,
            senderJid: sender,
            sender_name: senderName,
            key,
            message: message.message,
            sock: session.sock,
            from_me: key.fromMe ? 1 : 0,
            pushName: message.pushName || "",
            receiver: key.fromMe ? jid : "",
            conversation_key: key.id || "",
            group_name: groupName,
            channel_name: channelName,
            is_status: isStatus ? 1 : 0,
            is_view_once: isViewOnceMessage(message) ? 1 : 0,
            avatar: chatAvatar,
            sender_avatar: senderAvatar,
            chat_avatar: chatAvatar,
            media_type: media.type || "",
            mime_type: media.mimetype || "",
            file_name: media.fileName || "",
            media_size: media.size || 0,
            media_path: mediaPath,
            quoted_msg_id: context?.stanzaId || reactionMsgId || "",
            quoted_sender: quotedSenderName || quotedSender || "",
            quoted_text: quotedText || (reaction ? "Reaction" : ""),
            reaction: reactionText,
            reaction_msg_id: reactionMsgId,
            timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
            msg_id: key.id || ""
        })

    } catch (e) {
        console.error("[BOT] Message error:", e?.stack || e)
    }
}

module.exports = {
    handleMessage,
    getText,
    getMessageContent,
    getContact,
    getContactName,
    findContact,
    searchContacts,
    getProfilePictureUrl,
    getChannelMetadata,
    isViewOnceMessage
}