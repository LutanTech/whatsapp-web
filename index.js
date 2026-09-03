require("dotenv").config()

const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const path = require("path")

const { pair, logout, restoreSessions, getSessions, getSession, getPresence, isOnlinePresence, requestPresence, setSessionEventEmitter } = require("./lib/sessions")
const { refreshConversationAvatar } = require("./lib/avatar-refresh")
const { all, run } = require("./lib/database")
const { recordMessage, conversationKey, setMessageEmitter } = require("./lib/messages")
const { getContactName } = require("./lib/bot")
const { getFullProfilePictureUrl } = require("./lib/avatars")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.json({ limit: "25mb" }))
app.use(express.static("public"))

async function migrateContacts() {
    await run(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(name, phone)
        )
    `)
}


app.post("/api/contacts", async (req, res) => {
    try {
        const contacts = Array.isArray(req.body.contacts)
            ? req.body.contacts
            : []

        let saved = 0

        for (const contact of contacts) {
            const name = Array.isArray(contact.name)
                ? String(contact.name[0] || "").trim()
                : String(contact.name || "").trim()

            if (!name) continue

            const phones = Array.isArray(contact.tel)
                ? contact.tel.map(v => String(v || "").trim()).filter(Boolean)
                : []

            const emails = Array.isArray(contact.email)
                ? contact.email.map(v => String(v || "").trim()).filter(Boolean)
                : []

            const max = Math.max(phones.length, emails.length, 1)

            for (let i = 0; i < max; i++) {
                const phone = phones[i] || ""
                const email = emails[i] || ""

                await run(`
                    INSERT OR IGNORE INTO contacts (name, phone, email)
                    VALUES (?, ?, ?)
                `, [name, phone, email])

                saved++
            }
        }

        res.json({
            success: true,
            imported: contacts.length,
            saved
        })
    } catch (err) {
        console.error("[CONTACTS]", err.message)
        res.status(500).json({ error: err.message })
    }
})

async function migrateDatabaseSchema() {
    const columnsToMigrate = [
        `ALTER TABLE messages ADD COLUMN channel_name TEXT`,
        `ALTER TABLE messages ADD COLUMN avatar TEXT`,
        `ALTER TABLE messages ADD COLUMN sender_avatar TEXT`,
        `ALTER TABLE messages ADD COLUMN chat_avatar TEXT`,
        `ALTER TABLE messages ADD COLUMN media_size INTEGER DEFAULT 0`,
        `ALTER TABLE messages ADD COLUMN is_status INTEGER DEFAULT 0`,
        `ALTER TABLE messages ADD COLUMN is_view_once INTEGER DEFAULT 0`,
        `ALTER TABLE messages ADD COLUMN read_at INTEGER DEFAULT 0`
    ]

    for (const sql of columnsToMigrate) {
        try {
            await run(sql)
        } catch {}
    }

    try {
        const rows = await all(`
            SELECT id, session_id, sender, receiver, jid, from_me
            FROM messages
            WHERE conversation_key IS NULL OR conversation_key = ''
        `)

        let updated = 0

        for (const row of rows) {
            const session = String(row.session_id || "").trim()
            const jid = String(row.jid || "").trim()

            if (!session || !jid) continue

            let sender = String(row.sender || "").trim()
            let receiver = String(row.receiver || "").trim()

            if (!sender) sender = row.from_me ? session : jid
            if (!receiver) receiver = row.from_me ? jid : session

            let key

            if (jid === "status@broadcast") {
                key = `${session}:status:${jid}`
            } else if (jid.endsWith("@g.us")) {
                key = `${session}:group:${jid}`
            } else if (jid.endsWith("@newsletter")) {
                key = `${session}:channel:${jid}`
            } else {
                key = `${session}:${[sender, receiver].sort().join(":")}`
            }

            await run(`
                UPDATE messages
                SET sender = ?, receiver = ?, conversation_key = ?
                WHERE id = ?
            `, [sender, receiver, key, row.id])

            updated++
        }

        console.log(`[DB] Rebuilt ${updated} conversation keys`)
    } catch (err) {
        console.error("[DB] Migration error:", err.message)
    }
}

setMessageEmitter(message => io.emit("message", message))
setSessionEventEmitter(event => {
    if (event?.type === "presence") io.emit("presence", event)
})

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        sessions: getSessions()
    })
})

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"))
})
app.get("/contacts", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "contacts.html"))
})

app.get("/api/sessions", (req, res) => {
    res.json(getSessions())
})

app.get("/api/profile-picture", async (req, res) => {
    try {
        const sessionId = String(req.query.session || "").trim()
        const jid = String(req.query.jid || "").trim()
        const session = getSession(sessionId)

        if (!session?.sock || !jid)
            return res.status(404).json({ error: "Profile picture is unavailable" })

        const url = await getFullProfilePictureUrl(session.sock, jid)
        res.json({ url })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get("/api/messages", async (req, res) => {
    try {
        const rows = await all(`
            SELECT *
            FROM messages
            ORDER BY id DESC
            LIMIT 100
        `)

        res.json({ messages: rows })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get("/api/conversations", async (req, res) => {
    try {
        const rows = await all(`
            SELECT
                m.conversation_key,
                m.session_id,
                m.jid,
                m.sender_name,
                m.receiver,
                m.push_name,
                m.group_name,
                m.channel_name,
                (
                    SELECT COUNT(*)
                    FROM messages u
                    WHERE u.conversation_key=m.conversation_key
                      AND u.from_me=0
                      AND u.jid!='status@broadcast'
                      AND COALESCE(u.read_at, 0)=0
                ) AS unread_count,
                (
                    SELECT COALESCE(
                        NULLIF(i.push_name, ''),
                        NULLIF(i.sender_name, ''),
                        ''
                    )
                    FROM messages i
                    WHERE i.conversation_key=m.conversation_key
                      AND i.from_me=0
                    ORDER BY i.id DESC
                    LIMIT 1
                ) AS incoming_user_name,
                COALESCE(
                    NULLIF((
                        SELECT COALESCE(NULLIF(i.sender_name, ''), NULLIF(i.push_name, ''), '')
                        FROM messages i
                        WHERE i.conversation_key=m.conversation_key
                          AND i.from_me=0
                        ORDER BY i.id DESC
                        LIMIT 1
                    ), ''),
                    NULLIF(m.group_name, ''),
                    NULLIF(m.channel_name, ''),
                    CASE
                        WHEN m.jid='status@broadcast' THEN 'WhatsApp Status Broadcasts'
                        WHEN m.jid LIKE '%@g.us' THEN m.jid
                        WHEN m.jid=(m.session_id || '@s.whatsapp.net') THEN NULLIF(m.sender_name, '')
                        ELSE m.jid
                    END
                ) AS chat_name,
                m.avatar,
                m.sender_avatar,
                m.chat_avatar,
                m.created_at AS last_time,
                m.from_me AS last_from_me,
                m.text,
                m.reaction,
                COALESCE(NULLIF(m.text, ''), 'reacted ' || m.reaction, '') AS last_message
            FROM messages m
            INNER JOIN (
                SELECT conversation_key, MAX(id) AS last_id
                FROM messages
                WHERE conversation_key IS NOT NULL
                AND conversation_key != ''
                GROUP BY conversation_key
            ) x ON m.id = x.last_id
            ORDER BY m.created_at DESC
        `)

        const namedRows = rows.map(row => {
            const session = getSession(row.session_id)
            const target = row.jid === "status@broadcast"
                ? row.sender
                : row.jid
            const liveName = session
                ? getContactName(session, target)
                : ""

            const outgoing =
                row.last_from_me === 1 ||
                row.last_from_me === true ||
                String(row.last_from_me).toLowerCase() === "true"

            const isStatus = row.jid === "status@broadcast"
            const isGroup = String(row.jid || "").endsWith("@g.us")
            const isChannel = String(row.jid || "").endsWith("@newsletter")
            const isSelfInbox = row.jid === `${row.session_id}@s.whatsapp.net`
            const presenceState = !session || isStatus || isGroup || isChannel || isSelfInbox
                ? "unavailable"
                : getPresence(row.session_id, row.jid)
            if (session && !isStatus && !isGroup && !isChannel && !isSelfInbox)
                requestPresence(row.session_id, row.jid)
            const ownerName = String(session?.sock?.user?.name || "").trim()
            const incomingName = String(row.incoming_user_name || "").trim()
            const safeLiveName = liveName && liveName !== ownerName
                ? String(liveName).trim()
                : ""
            const liveSenderName = session
                ? getContactName(session, row.sender)
                : ""
            const safeLiveSenderName = liveSenderName &&
                liveSenderName !== ownerName &&
                liveSenderName !== row.group_name &&
                liveSenderName !== row.channel_name
                ? String(liveSenderName).trim()
                : ""
            const pushSenderName = row.push_name &&
                row.push_name !== ownerName &&
                row.push_name !== row.group_name &&
                row.push_name !== row.channel_name
                ? String(row.push_name).trim()
                : ""
            const storedSenderName = row.sender_name &&
                row.sender_name !== ownerName &&
                row.sender_name !== row.group_name &&
                row.sender_name !== row.channel_name
                ? String(row.sender_name).trim()
                : ""
            const lastSenderName = isGroup
                ? safeLiveSenderName || pushSenderName || storedSenderName || row.sender || ""
                : safeLiveSenderName || storedSenderName || pushSenderName || ""
            const privateName = incomingName || safeLiveName || (
                row.chat_name && row.chat_name !== ownerName
                    ? String(row.chat_name).trim()
                    : ""
            )
            const otherUserName = isStatus
                ? incomingName || safeLiveName || row.sender_name || row.push_name || ""
                : isGroup
                ? row.group_name || row.chat_name || ""
                : isSelfInbox
                ? ownerName || row.sender_name || row.push_name || ""
                : privateName

            return {
                ...row,
                last_from_me: outgoing,
                last_sender_name: lastSenderName,
                is_online: isOnlinePresence(presenceState),
                presence: presenceState,
                other_user_name: otherUserName,
                ...(isStatus
                    ? { chat_name: "WhatsApp Status Broadcasts" }
                    : isGroup
                    ? { chat_name: row.group_name || row.chat_name || "" }
                    : privateName
                    ? { chat_name: privateName }
                    : {})
            }
        })

        res.json({ conversations: namedRows })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/conversations/:key/read", async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key)
        await run(`
            UPDATE messages
            SET read_at = CAST(strftime('%s', 'now') AS INTEGER)
            WHERE conversation_key = ?
              AND from_me = 0
              AND jid != 'status@broadcast'
        `, [key])
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get("/api/conversations/:key", async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key)

        let rows = await all(`
            SELECT *
            FROM messages
            WHERE conversation_key = ?
            ORDER BY created_at ASC, id ASC
        `, [key])

        let avatar = rows[0] || null
        const session = rows[0] ? getSession(rows[0].session_id) : null

        if (session) {
            try {
                avatar = await refreshConversationAvatar(session, key)
                rows = await all(`
                    SELECT *
                    FROM messages
                    WHERE conversation_key = ?
                    ORDER BY created_at ASC, id ASC
                `, [key])
            } catch (error) {
                console.warn(`[AVATAR] Chat-open refresh failed for ${key}:`, error.message)
            }
        }

        res.json({
            conversation_key: key,
            chat_name: avatar?.chat_name || avatar?.sender_name || "",
            avatar: avatar?.avatar || "",
            sender_avatar: avatar?.sender_avatar || "",
            chat_avatar: avatar?.chat_avatar || "",
            messages: rows
        })
    } catch (err) {
        console.error("[API] Conversation error:", err.message)
        res.status(500).json({ error: err.message })
    }
})

async function resolveConversationTarget(conversationKey) {
    const rows = await all(`
        SELECT session_id, jid, sender
        FROM messages
        WHERE conversation_key=?
        ORDER BY id DESC
        LIMIT 1
    `, [conversationKey])

    const row = rows[0]
    const session = row ? getSession(row.session_id) : null

    if (!row || !session?.sock)
        return null

    return {
        row,
        session,
        jid: row.jid
    }
}

async function getReplyMessage(conversationKey, replyTo, sessionId) {
    if (!replyTo)
        return undefined

    const rows = await all(`
        SELECT *
        FROM messages
        WHERE conversation_key=?
          AND msg_id=?
          AND session_id=?
        ORDER BY id DESC
        LIMIT 1
    `, [conversationKey, replyTo, sessionId])

    const row = rows[0]
    if (!row?.msg_id)
        return undefined

    return {
        key: {
            remoteJid: row.jid || conversationKey,
            fromMe: Boolean(row.from_me),
            id: row.msg_id,
            participant: row.sender || undefined
        },
        message: {
            conversation: row.text || " "
        }
    }
}

app.post("/api/messages/react", async (req, res) => {
    try {
        const conversationKey = String(req.body?.conversation_key || "").trim()
        const msgId = String(req.body?.msg_id || "").trim()
        const emoji = String(req.body?.emoji || "").trim()
        const target = await resolveConversationTarget(conversationKey)

        if (!target?.session?.sock || !target.jid || !msgId || !emoji)
            return res.status(400).json({ error: "Conversation, message, and emoji are required" })

        if (target.jid === "status@broadcast")
            return res.status(400).json({ error: "Status broadcasts are read-only" })

        const rows = await all(`
            SELECT *
            FROM messages
            WHERE conversation_key=? AND msg_id=? AND session_id=?
            ORDER BY id DESC
            LIMIT 1
        `, [conversationKey, msgId, target.row.session_id])
        const row = rows[0]

        if (!row)
            return res.status(404).json({ error: "Message was not found" })

        await target.session.sock.sendMessage(
            target.jid,
            { react: { text: emoji, key: {
                remoteJid: row.jid || target.jid,
                fromMe: Boolean(row.from_me),
                id: row.msg_id,
                participant: row.sender || undefined
            } } }
        )

        res.json({ success: true, emoji })
    } catch (err) {
        console.error("[MESSAGE REACT] Error:", err.message)
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/messages/pin", async (req, res) => {
    try {
        const conversationKey = String(req.body?.conversation_key || "").trim()
        const msgId = String(req.body?.msg_id || "").trim()
        const target = await resolveConversationTarget(conversationKey)

        if (!target?.session?.sock || !target.jid || !msgId)
            return res.status(400).json({ error: "Conversation and message are required" })

        if (target.jid === "status@broadcast")
            return res.status(400).json({ error: "Status broadcasts are read-only" })

        const rows = await all(`
            SELECT *
            FROM messages
            WHERE conversation_key=? AND msg_id=? AND session_id=?
            ORDER BY id DESC
            LIMIT 1
        `, [conversationKey, msgId, target.row.session_id])
        const row = rows[0]

        if (!row)
            return res.status(404).json({ error: "Message was not found" })

        await target.session.sock.sendMessage(
            target.jid,
            { pin: {
                type: 1,
                time: 86400,
                key: {
                    remoteJid: row.jid || target.jid,
                    fromMe: Boolean(row.from_me),
                    id: row.msg_id,
                    participant: row.sender || undefined
                }
            } }
        )

        res.json({ success: true })
    } catch (err) {
        console.error("[MESSAGE PIN] Error:", err.message)
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/status/reply", async (req, res) => {
    try {
        const sessionId = String(req.body?.session_id || "").trim()
        const sender = String(req.body?.sender || "").trim()
        const text = typeof req.body?.text === "string" ? req.body.text.trim() : ""
        const session = getSession(sessionId)

        if (!session?.sock || !sender || !text)
            return res.status(400).json({ error: "Status sender and reply text are required" })

        if (sender === "status@broadcast")
            return res.status(400).json({ error: "Invalid status sender" })

        const sent = await session.sock.sendMessage(sender, { text })
        console.log(`[STATUS REPLY] -> ${sender}`, sent?.key?.id || "")
        res.json({ success: true, key: sent?.key || null })
    } catch (err) {
        console.error("[STATUS REPLY] Error:", err.message)
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/messages/send", async (req, res) => {
    try {
        const body = req.body || {}
        const conversationKey = String(body.conversation_key || "").trim()
        const text = typeof body.text === "string" ? body.text.trim() : ""
        const media = body.media && typeof body.media === "object" ? body.media : null

        if (!conversationKey)
            return res.status(400).json({ error: "conversation_key is required" })

        const target = await resolveConversationTarget(conversationKey)

        if (!target)
            return res.status(404).json({ error: "Conversation session is not available" })

        if (target.jid === "status@broadcast")
            return res.status(400).json({ error: "Status broadcasts are read-only" })

        if (!text && !media)
            return res.status(400).json({ error: "Message text or media is required" })

        const replyMessage = await getReplyMessage(
            conversationKey,
            body.reply_to,
            target.row.session_id
        )

        let outgoing

        if (media) {
            const mediaType = String(media.type || "").toLowerCase()
            const allowed = new Set(["image", "video", "audio", "document"])

            if (!allowed.has(mediaType))
                return res.status(400).json({ error: "Unsupported media type" })

            if (typeof media.base64 !== "string" || !media.base64)
                return res.status(400).json({ error: "Media data is missing" })

            const base64 = media.base64.replace(/^data:[^;]+;base64,/, "")
            const buffer = Buffer.from(base64, "base64")

            if (!buffer.length)
                return res.status(400).json({ error: "Media data is empty" })

            const caption = text || undefined

            if (mediaType === "image") {
                outgoing = { image: buffer, caption, mimetype: media.mimetype || undefined }
            } else if (mediaType === "video") {
                outgoing = { video: buffer, caption, mimetype: media.mimetype || undefined }
            } else if (mediaType === "audio") {
                outgoing = {
                    audio: buffer,
                    mimetype: media.mimetype || "audio/webm; codecs=opus",
                    ptt: Boolean(media.ptt)
                }
            } else {
                outgoing = {
                    document: buffer,
                    mimetype: media.mimetype || "application/octet-stream",
                    fileName: media.fileName || "attachment"
                }

                if (caption)
                    outgoing.caption = caption
            }
        } else {
            outgoing = { text }
        }

        const sendOptions = replyMessage ? { quoted: replyMessage } : undefined
        const sent = await target.session.sock.sendMessage(
            target.jid,
            outgoing,
            sendOptions
        )

        const sentType = media?.type || "text"

        console.log(
            `[ADMIN SEND] ${sentType} -> ${target.jid}`,
            sent?.key?.id || ""
        )

        res.json({
            success: true,
            type: sentType,
            key: sent?.key || null,
            conversation_key: conversationKey,
            reply_to: body.reply_to || null
        })
    } catch (err) {
        console.error("[ADMIN SEND] Error:", err.message)
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/pair", async (req, res) => {
    try {
        const phone = String(req.body.phone || "").replace(/\D/g, "")

        if (!phone)
            return res.status(400).json({ error: "Phone number required" })

        if (phone.length < 8)
            return res.status(400).json({ error: "Invalid phone number" })

        res.json(await pair(phone, phone))
    } catch (err) {
        console.error("[PAIR]", err.message)
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/logout/:id", async (req, res) => {
    try {
        res.json({ success: await logout(req.params.id) })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/admin/login", (req, res) => {
    const { email, password } = req.body || {}

    if (
        email === process.env.ADMIN_EMAIL &&
        password === process.env.ADMIN_PASS
    ) {
        return res.json({ success: true })
    }

    res.status(401).json({ error: "Invalid email or password" })
})

io.on("connection", async socket => {
    socket.emit("sessions", getSessions())

    try {
        const rows = await all(`
            SELECT *
            FROM messages
            ORDER BY id DESC
            LIMIT 100
        `)

        socket.emit("messages", rows)
    } catch {}
})

setInterval(() => {
    io.emit("sessions", getSessions())
}, 3000)

const PORT = process.env.PORT || 3000

server.listen(PORT, async () => {
    await migrateDatabaseSchema()
    await restoreSessions()
    migrateContacts()
    console.log(`Server running on port ${PORT}`)
})

module.exports = { app, server }