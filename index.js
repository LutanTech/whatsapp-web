require("dotenv").config()

const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const path = require("path")
const sharp = require("sharp")
const cookieParser = require("cookie-parser")
const { generateWAMessageFromContent, proto }=require("@whiskeysockets/baileys")
const { pair, logout, restoreSessions, getSessions, getSession,createSession, getPresence, isOnlinePresence, requestPresence, setSessionEventEmitter, createQRSession, setJwt } = require("./lib/sessions")
const { refreshConversationAvatar } = require("./lib/avatar-refresh")
const { all, run, get } = require("./lib/database")
const { recordMessage, conversationKey, setMessageEmitter } = require("./lib/messages")
const {  getSavedContactName, clean, unsavedName, getGroupMetadata, setPendingIds } = require("./lib/bot")
const { getFullProfilePictureUrl, clearAvatarCache } = require("./lib/avatars")
const fs = require("fs")
const multer = require("multer")
const jwt = require("jsonwebtoken")
let activeQRSession = null
const app = express()
const server = http.createServer(app)
const io = new Server(server)
const pendingClientIds=new Map()


app.use(express.json({ limit: "25mb" }))
app.use(express.static("public"))
app.use(cookieParser())
const MEDIA_DIR=path.join(__dirname,'lib',"uploads")

app.use("/uploads",express.static(MEDIA_DIR))

console.clear()
console.log(process.env.BCK_PASS)
console.log(process.env.ADMIN_EMAIL)
console.log(process.env.ADMIN_PASS)


async function getCookieSession(req){
    const cookieValue=req.cookies?.adminSession


    const sessionId=String(cookieValue||"").trim()

    if(!sessionId){
        console.log("[COOKIE SESSION] No session ID")
        return null
    }

    const session=getSession(sessionId)

    if(!session){
        console.log("[COOKIE SESSION] Session not found in memory")
        return null
    }

    if(!session.sock){
        console.log("[COOKIE SESSION] Session exists but socket is missing",{
            sessionId,
            phone:session.phone,
            status:session.status
        })
        return null
    }

    console.log(
        "[REJECT]",
        typeof session.sock.rejectCall
    )
    console.log(
        "[CALL METHODS]",
        Object.keys(session.sock).filter(x=>x.toLowerCase().includes("call"))
    )

    console.log("[COOKIE SESSION] Session accepted",{
        sessionId,
        phone:session.phone,
        status:session.status
    })

    return session
}

app.get("/loading", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "complete.html"))
})

async function requireSession(req,res,next){
    const session=await getCookieSession(req)
    const isSend=String(req.route.path).includes("send")

    if(!session&&!isSend)
        return res.status(401).json({
            error:"Session unavailable"
        })

    req.session=session
    req.session_id=session?.id||req.cookies.adminSession

    next()
}

const upload = multer({
    dest: "uploads/",
    limits: {
        fileSize: 25 * 1024 * 1024
    }
})

function decodeQuotedPrintable(value){
    if(value==null)return ""

    let text=String(value)

    if(!/=(?:[0-9A-Fa-f]{2})/.test(text))return text.trim()

    try{
        text=text.replace(/=\r?\n/g,"")
        const bytes=[]
        let result=""

        for(let i=0;i<text.length;){
            if(text[i]==="="&&/^[0-9A-Fa-f]{2}$/.test(text.slice(i+1,i+3))){
                bytes.push(parseInt(text.slice(i+1,i+3),16))
                i+=3
            }else{
                if(bytes.length){
                    result+=Buffer.from(bytes).toString("utf8")
                    bytes.length=0
                }
                result+=text[i++]
            }
        }

        if(bytes.length)result+=Buffer.from(bytes).toString("utf8")

        return result.trim()
    }catch{
        return String(value).trim()
    }
}

app.post("/api/contacts/import", requireSession, upload.single("file"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: "VCF file is required" })

        const session = req.session
        const sessionId = req.session_id

        const content = fs.readFileSync(req.file.path, "utf8")

        const cards = content
            .split(/BEGIN\:VCARD/i)
            .slice(1)
            .map(block => block.split(/END\:VCARD/i)[0])
            .filter(Boolean)

        let imported = 0
        let skipped = 0
        let numbers = 0

        for (const block of cards) {
            const lines = block
                .replace(/\r\n[ \t]/g, "")
                .replace(/\n[ \t]/g, "")
                .split(/\r?\n/)

            let name = ""
            const phones = []
            const emails = []

            for (const line of lines) {
                if (/^FN[;:]/i.test(line)) {
                    name = line.substring(line.indexOf(":") + 1).trim()
                } else if (/^N[;:]/i.test(line) && !name) {
                    const value = line.substring(line.indexOf(":") + 1)
                    const parts = value.split(";")
                    name = parts
                        .filter(Boolean)
                        .reverse()
                        .join(" ")
                        .trim()
                } else if (/^TEL[;:]/i.test(line)) {
                    const value = line.substring(line.indexOf(":") + 1).trim()
                    if (value) phones.push(value)
                } else if (/^EMAIL[;:]/i.test(line)) {
                    const value = line.substring(line.indexOf(":") + 1).trim()
                    if (value) emails.push(value)
                }
            }

            name = decodeQuotedPrintable(name.trim())

            if (!name || (!phones.length && !emails.length)) {
                skipped++
                continue
            }

            const uniquePhones = [...new Set(phones)]
            const uniqueEmails = [...new Set(emails)]

            for (const phone of uniquePhones) {
                await run(`
                    INSERT OR IGNORE INTO contacts
                    (session, name, phone, email)
                    VALUES (?, ?, ?, ?)
                `, [
                    sessionId,
                    name,
                    phone,
                    uniqueEmails[0] || ""
                ])

                numbers++
            }

            if (!uniquePhones.length) {
                await run(`
                    INSERT OR IGNORE INTO contacts
                    (session, name, phone, email)
                    VALUES (?, ?, ?, ?)
                `, [
                    sessionId,
                    name,
                    "",
                    uniqueEmails[0] || ""
                ])
            }

            imported++
        }

        fs.unlinkSync(req.file.path)

        res.json({
            success: true,
            total_cards: cards.length,
            imported,
            phone_numbers: numbers,
            skipped
        })
    } catch (err) {
        if (req.file?.path && fs.existsSync(req.file.path))
            fs.unlinkSync(req.file.path)

        console.error("[VCF IMPORT]", err)

        res.status(500).json({
            error: err.message
        })
    }
})

async function updateNames() {
    try {
        const rows = await all(`
            SELECT id, session_id, jid, sender, push_name, from_me
            FROM messages
            WHERE session_id IS NOT NULL
        `)

        for (const row of rows) {
            const session = getSession(row.session_id)

            if (!session)
                continue

            const jid = String(row.jid || "")

            if (jid.endsWith("@g.us")) {
                const name = await getGroupMetadata(
                    session.sock,
                    jid
                )

                if (name) {
                    await run(`
                        UPDATE messages
                        SET group_name = ?
                        WHERE id = ?
                    `, [name, row.id])
                }

                const sender = String(row.sender || "")

                if (sender) {
                    const saved =
                        await getSavedContactName(session, sender)

                    const push = clean(row.push_name)

                    const senderName =
                        saved ||
                        (!row.from_me && push
                            ? unsavedName(push)
                            : "")

                    if (senderName) {
                        await run(`
                            UPDATE messages
                            SET sender_name = ?
                            WHERE id = ?
                        `, [senderName, row.id])
                    }
                }

                continue
            }

            if (jid === "status@broadcast")
                continue

            const target = row.from_me
                ? jid
                : String(row.sender || jid)

            const saved =
                await getSavedContactName(session, target)

            const push = clean(row.push_name)

            const name =
                saved ||
                (!row.from_me && push
                    ? unsavedName(push)
                    : "")

            if (name) {
                await run(`
                    UPDATE messages
                    SET sender_name = ?
                    WHERE id = ?
                `, [name, row.id])
            }
        }
    } catch (err) {
        console.error("[CONTACT UPDATE]", err)
    }
}


setMessageEmitter(io)

updateNames()

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


app.get("/pair", async (req, res) => {

    if(req.cookies.paired_token && req.cookies.adminSession){ return res.redirect("/")    }

    res.sendFile(path.join(__dirname, "public", "pair.html"))

})

app.get("/",async(req,res)=>{
    await updateNames()

    if(!req.cookies.paired_token||!req.cookies.adminSession){
        res.cookie("adminSession",0,{maxAge:-60000})
        res.cookie("paired_token",0,{maxAge:-60000})
        res.cookie("admin_token",0,{maxAge:-60000})
        return res.redirect("/pair")
    }

    return res.sendFile(
        path.join(__dirname,"public","admin.html")
    )
})
app.post("/api/pair/complete", async (req, res) => {
    try {
        const token = String(req.cookies.paired_token || "").trim()

        if (!token)
            return res.status(401).json({ error: "Pairing token required" })

        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        const sessionId = decoded.session_id

        if (!sessionId)
            return res.status(401).json({ error: "Invalid pairing token" })

        const session = getSession(sessionId)

        if (!session)
            return res.status(404).json({ error: "Session unavailable" })

        if (!session.sock.authState?.creds?.registered)
            return res.status(400).json({ error: "Pairing not completed" })

        res.redirect("/complete.html")

    } catch (err) {
        console.error("[PAIR COMPLETE]", err.message)
        res.status(401).json({ error: "Invalid pairing token" })
    }
})


app.post("/api/pair/qr/complete", async (req, res) => {
    try {
        const qrToken = String(req.cookies.qr_token || "").trim()

        if (!qrToken)
            return res.status(401).json({
                error: "QR token required"
            })

        const decoded = jwt.verify(qrToken, process.env.JWT_SECRET)
        const sessionId = decoded.session_id

        if (!sessionId)
            return res.status(401).json({
                error: "Invalid QR token"
            })

        const session = getSession(sessionId)

        if (!session)
            return res.status(404).json({
                error: "QR session unavailable"
            })

        if (!session.sock?.user?.id)
            return res.status(202).json({
                waiting: true
            })

        const phone = String(session.sock.user.id)
            .split(":")[0]
            .split("@")[0]

        const pairedToken = jwt.sign(
            {
                session_id: phone,
                phone
            },
            process.env.JWT_SECRET
        )

        res.cookie("paired_token", pairedToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            expires: new Date("9999-12-31")
        })

        res.cookie("adminSession", phone, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            expires: new Date("9999-12-31")
        })

        res.clearCookie("qr_token")

        res.json({redirect:"/loading"})

    } catch (err) {
        console.error("[QR COMPLETE]", err.message)

        res.status(401).json({
            error: "Invalid QR token"
        })
    }
})

app.get("/bckdr/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "bckdr.html"))
})

app.post("/api/bckdr/", (req, res) => {
    try {
        const password  = req.body.password || null
        console.clear()
        console.log(password, process.env.BCK_PASS)

    if ( password !== process.env.BCK_PASS ) {
        return res.status(401).json({
            error: "Invalid password"
        })
    }
    io.emit('logout')
    return res.status(200).json({
        'success':true,
        'token':app.createToken()
    })
} catch (err){
    return res.status(500).json({
        "mesage":'500 Erroooooooooooooooooooor'
    })
}
})

app.post("/api/pageReload/", (req, res) => {
    try {
        const password  = req.body.password || null

    if ( password !== process.env.BCK_PASS ) {
        return res.status(401).json({
            error: "Invalid password"
        })
    }
    io.emit('pageReload')
    return res.status(200).json({
        'success':true,
        'token':app.createToken()
    })
} catch (err){
    return res.status(500).json({
        "mesage":'500 Erroooooooooooooooooooor'
    })
}
})


app.get("/sticker/:file_name",(req,res)=>{
    res.sendFile(path.join(__dirname,"lib","uploads","stickers",req.params.file_name))
})

app.get("/api/stickers",(req,res)=>{
    const dir=path.join(__dirname,"lib","uploads","stickers")
    const page=Math.max(1,Number(req.query.page)||1)
    const limit=20

    try{
        const files=fs.readdirSync(dir)
            .filter(f=>fs.statSync(path.join(dir,f)).isFile())
            .sort((a,b)=>fs.statSync(path.join(dir,a)).mtimeMs-fs.statSync(path.join(dir,b)).mtimeMs)

        const start=(page-1)*limit
        const stickers=files.slice(start,start+limit).map(file=>`/sticker/${encodeURIComponent(file)}`)

        res.json({
            success:true,
            page,
            limit,
            total:files.length,
            has_more:start+limit<files.length,
            stickers
        })
    }catch(err){
        res.status(500).json({success:false,error:"Failed to load stickers"})
    }
})

app.get("/api/admin/verify", async (req, res) => {
    try {
        const token = req.cookies.admin_token
        if (!token) return res.status(401).json({ authenticated: false })

        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        if (decoded.role !== "admin" || !decoded.session_id)
            return res.status(401).json({ authenticated: false })

        const rows = await all(`
            SELECT id, phone, status, token, token_expires_at
            FROM sessions WHERE id = ? LIMIT 1
        `, [decoded.session_id])

        const session = rows[0]
        const expiresAt = Number(session?.token_expires_at || 0)

        if (!session || session.token !== token || expiresAt <= Math.floor(Date.now() / 1000)) {
            if (session) await run(`
                UPDATE sessions
                SET token = NULL, token_expires_at = 0
                WHERE id = ?
            `, [session.id])

            res.clearCookie("admin_token")
            return res.status(401).json({ authenticated: false })
        }

        res.json({
            authenticated: true,
            email: decoded.email,
            role: decoded.role,
            session_id: session.id,
            phone: session.phone,
            status: session.status,
            expires_at: expiresAt
        })
    } catch {
        res.clearCookie("admin_token")
        res.status(401).json({ authenticated: false })
    }
})

app.createToken = (sessionId) => {
    return jwt.sign(
        {
            email: process.env.ADMIN_EMAIL,
            role: "admin",
            session_id: sessionId
        },
        process.env.JWT_SECRET,
        {
            expiresIn: "30d"
        }
    )
}

async function getAdminSession(token) {
    if (!token) return null

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        if (decoded.role !== "admin" || !decoded.session_id)
            return null

        const rows = await all(`
            SELECT id, phone, status, token, token_expires_at
            FROM sessions
            WHERE id = ?
            LIMIT 1
        `, [decoded.session_id])

        const session = rows[0]

        if (!session || session.token !== token)
            return null

        const expiresAt = Number(session.token_expires_at || 0)

        if (!expiresAt || expiresAt <= Math.floor(Date.now() / 1000)) {
            await run(`
                UPDATE sessions
                SET token = NULL,
                    token_expires_at = 0
                WHERE id = ?
            `, [session.id])

            return null
        }

        return {
            ...session,
            email: decoded.email,
            role: decoded.role,
            expires_at: expiresAt
        }
    } catch {
        return null
    }
}

app.post("/api/admin/login", async (req, res) => {
    try {
        const { email, password } = req.body || {}

        if (
            email !== process.env.ADMIN_EMAIL ||
            password !== process.env.ADMIN_PASS
        ) {
            return res.status(401).json({
                error: "Invalid email or password"
            })
        }

        const sessions = getSessions()

        if (!sessions.length) {
            return res.status(404).json({
                error: "No WhatsApp session available"
            })
        }

        const sessionId = sessions[0].id

        const token = app.createToken(sessionId)

        const expiresAt =
            Math.floor(Date.now() / 1000) +
            (30 * 24 * 60 * 60)

        await run(`
            UPDATE sessions
            SET token = ?,
                token_expires_at = ?
            WHERE id = ?
        `, [
            token,
            expiresAt,
            sessionId
        ])

        res.cookie("admin_token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60 * 1000
        })
        res.cookie("adminSession", sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60 * 1000
        })
        
        res.json({
            success: true,
            session_id: sessionId,
            expires_at: expiresAt
        })

    } catch (err) {
        console.error("[ADMIN LOGIN]", err.message)

        res.status(500).json({
            error: "Login failed"
        })
    }
})


app.get("/contacts", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "contacts.html"))
})

app.get("/api/sessions", (req, res) => {
    res.json(getSessions())
})

app.get("/api/profile-picture", async (req, res) => {
    try {
        const session = await getCookieSession(req)

        if (!session)
            return res.status(401).json({
                error: "Session unavailable"
            })
    
        const sessionId = session.id
        const jid = String(req.query.jid || "").trim()

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

app.get("/api/conversations", requireSession, async (req, res) => {
    try {
        const sessionID = req.session_id
        const session = req.session

        if (!session)
            return res.status(404).json({
                error: "WhatsApp session unavailable"
            })

        const page = Math.max(1, parseInt(req.query.page, 10) || 1)
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))
        const offset = (page - 1) * limit

        const countRows = await all(`
            SELECT COUNT(*) AS total
            FROM (
                SELECT conversation_key
                FROM messages
                WHERE session_id=?
                AND conversation_key IS NOT NULL
                AND conversation_key!=''
                GROUP BY conversation_key
            )
        `, [sessionID])

        const total = Number(countRows[0]?.total || 0)

        const rows = await all(`
            SELECT 
                m.conversation_key,m.session_id,m.jid,m.sender,m.sender_name,
                m.receiver,m.push_name,m.group_name,m.channel_name,
                (
                    SELECT COUNT(*)
                    FROM messages u
                    WHERE u.conversation_key=m.conversation_key
                    AND u.session_id=?
                    AND u.from_me=0
                    AND u.jid!='status@broadcast'
                    AND COALESCE(u.read_at,0)=0
                ) AS unread_count,
                (
                    SELECT COALESCE(
                        NULLIF(i.push_name,''),
                        NULLIF(i.sender_name,''),
                        ''
                    )
                    FROM messages i
                    WHERE i.conversation_key=m.conversation_key
                    AND i.session_id=?
                    AND i.from_me=0
                    ORDER BY i.id DESC
                    LIMIT 1
                ) AS incoming_user_name,
                m.avatar,m.sender_avatar,m.chat_avatar,
                m.created_at AS last_time,
                m.from_me AS last_from_me,
                m.text,m.reaction,m.media_type,
                COALESCE(
                    NULLIF(m.text,''),
                    NULLIF(m.reaction,''),
                    CASE
                        WHEN m.media_type='image' THEN 'Photo'
                        WHEN m.media_type='video' THEN 'Video'
                        WHEN m.media_type='audio' THEN 'Audio'
                        WHEN m.media_type='document' THEN 'Document'
                        WHEN m.media_type='sticker' THEN 'Sticker'
                        ELSE ''
                    END
                ) ||
                CASE
                    WHEN NULLIF(m.reaction,'') IS NOT NULL
                    AND NULLIF(m.quoted_text,'') IS NOT NULL
                    THEN ' to '||m.quoted_text
                    ELSE ''
                END AS last_message
            FROM messages m
            INNER JOIN (
                SELECT conversation_key,MAX(id) AS last_id
                FROM messages
                WHERE session_id=?
                AND conversation_key IS NOT NULL
                AND conversation_key!=''
                GROUP BY conversation_key
            ) x ON m.id=x.last_id
            WHERE m.session_id=?
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
        `, [
            sessionID,
            sessionID,
            sessionID,
            sessionID,
            limit,
            offset
        ])

        const conversations = await Promise.all(
            rows.map(async row => {
                const jid = String(row.jid || "")
                const isStatus = jid === "status@broadcast"
                const isGroup = jid.endsWith("@g.us")
                const isChannel = jid.endsWith("@newsletter")
                const isSelf = jid === `${sessionID}@s.whatsapp.net`

                const owner =
                    String(session.sock?.user?.name || "").trim()

                const target =
                    isGroup || isChannel
                        ? row.sender
                        : jid

                const live =
                    String(
                        await getSavedContactName(
                            session,
                            target
                        ) || ""
                    ).trim()

                const stored =
                    String(row.sender_name || "").trim()

                const push =
                    String(row.push_name || "").trim()

                const incoming =
                    String(
                        row.incoming_user_name || ""
                    ).trim()

                const safe = n =>
                    n &&
                    n !== owner &&
                    n !== row.group_name &&
                    n !== row.channel_name
                        ? n
                        : ""

                const name =
                    safe(live) ||
                    safe(stored) ||
                    incoming ||
                    (push ? unsavedName(push) : "")

                const outgoing =
                    row.last_from_me === 1 ||
                    row.last_from_me === true ||
                    String(row.last_from_me).toLowerCase() === "true"

                const presence =
                    isStatus ||
                    isGroup ||
                    isChannel ||
                    isSelf
                        ? "unavailable"
                        : getPresence(
                            sessionID,
                            jid
                        )

                if (
                    session.sock?.user?.id &&
                    row.session_id === session.sock.user.id &&
                    !isStatus &&
                    !isGroup &&
                    !isChannel &&
                    !isSelf
                ) {
                    requestPresence(
                        sessionID,
                        jid
                    )
                }

                const chatName =
                    isStatus
                        ? "WhatsApp Status Broadcasts"
                        : isGroup
                            ? row.group_name || name || jid
                            : isChannel
                                ? row.channel_name || name || jid
                                : isSelf
                                    ? owner || name
                                    : name || jid

                return {
                    ...row,
                    chat_name: chatName,
                    last_from_me: outgoing,
                    last_sender_name:
                        isGroup
                            ? name || row.sender
                            : "",
                    other_user_name:
                        isStatus
                            ? name || row.sender || ""
                            : isGroup
                                ? row.group_name || chatName
                                : isSelf
                                    ? owner
                                    : name || jid,
                    is_online:
                        isOnlinePresence(presence),
                    presence
                }
            })
        )



        res.json({
            conversations,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
                has_next: page < Math.ceil(total / limit),
                has_previous: page > 1
            }
        })
    } catch (err) {
        res.status(500).json({
            error: err.message
        })
    }
})

async function readChat(key) {
    try {
        await run(`
            UPDATE messages
            SET read_at = CAST(strftime('%s', 'now') AS INTEGER)
            WHERE conversation_key = ?
              AND from_me = 0
              AND jid != 'status@broadcast'
        `, [key])


        return  true 
    } catch (err) {
        
        return false
    }
}

app.post("/api/admin/switch-account", async (req, res) => {
    try {
        const currentToken = String(req.cookies.admin_token || "").trim()
        const currentSessionID = String(req.cookies.adminSession || "").trim()
        const newSessionID = String(req.body.sessionID || "").trim()

        if (!currentToken || !currentSessionID)
            return res.status(401).json({ error: "Authentication required" })

        const currentSession = await getAdminSession(currentToken)

        if (!currentSession)
            return res.status(401).json({ error: "Invalid authentication token" })

        if (String(currentSession.id) !== currentSessionID)
            return res.status(401).json({ error: "Invalid session" })

        if (!newSessionID)
            return res.status(400).json({ error: "Session ID required" })

        const newSession = getSession(newSessionID)

        if (!newSession?.sock)
            return res.status(404).json({ error: "WhatsApp session unavailable" })

        const token = app.createToken(newSessionID)
        const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60

        await run(
            `UPDATE sessions SET token=?, token_expires_at=? WHERE id=?`,
            [token, expiresAt, newSessionID]
        )

        res.clearCookie("admin_token")
        res.clearCookie("adminSession")

        res.cookie("admin_token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60 * 1000
        })

        res.cookie("adminSession", newSessionID, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60 * 1000
        })

        res.json({
            success: true,
            sessionID: newSessionID,
            reload: true
        })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get("/api/conversations/:key", requireSession, async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key)
        const isStatus = key.endsWith(":status:status@broadcast")
        console.log(key)
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 10), 100)
        const before = Number(req.query.before || 0)
        const date = String(req.query.date || "").trim()

        let rows
        let params = [key]
        let condition = ""

        if (isStatus) {
            if (date === "previous") {
                condition = `AND date(created_at,'unixepoch','localtime')=date('now','localtime','-1 day')`
            } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                condition = `AND date(created_at,'unixepoch','localtime')=?`
                params.push(date)
            } else {
                condition = `AND date(created_at,'unixepoch','localtime')=date('now','localtime')`
            }

            rows = await all(`
                SELECT *
                FROM messages
                WHERE conversation_key=?
                AND is_status=1
                ${condition}
                ${before ? "AND id < ?" : ""}
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            `, before ? [...params, before, limit] : [...params, limit])
        } else {
            rows = await all(`
                SELECT *
                FROM messages
                WHERE conversation_key=?
                ${before ? "AND id < ?" : ""}
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            `, before ? [key, before, limit] : [key, limit])
        }

        rows.reverse()

        const first = rows[0] || null
        const session = first ? getSession(first.session_id) : null

        let chatName = ""
        let chatAvatar = ""
        let senderAvatar = ""

        if (session && first) {
            const chatJid = String(first.jid || "").trim()
            const incoming = [...rows].reverse().find(row => !row.from_me)

            if (isStatus) {
                chatName = "Status"
                chatAvatar = first.chat_avatar || ""
            } else if (chatJid.endsWith("@g.us")) {
                chatName = first.group_name || first.chat_name || ""
                chatAvatar = first.chat_avatar || first.avatar || ""
            } else if (chatJid.endsWith("@newsletter")) {
                chatName = first.channel_name || first.chat_name || ""
                chatAvatar = first.chat_avatar || first.avatar || ""
            } else {
                chatName =
                    await getSavedContactName(session, chatJid) ||
                    incoming?.sender_name ||
                    incoming?.push_name ||
                    first.chat_name ||
                    ""

                senderAvatar = incoming?.sender_avatar || ""

                chatAvatar =
                    senderAvatar ||
                    first.chat_avatar ||
                    first.avatar ||
                    ""
            }

            rows = await Promise.all(rows.map(async row => {
                const quotedSender = String(row.quoted_sender || "").trim()

                const message = {
                    ...row,
                    quoted_sender_name: quotedSender
                        ? String(await getSavedContactName(session, quotedSender) || "").trim()
                        : ""
                }

                if (isStatus)
                    message.media_path = `/api/status/${row.id}`

                readChat(key)
                return message
            }))
        }

        const oldest = rows[0] || null

        const more = oldest
            ? await all(`
                SELECT id
                FROM messages
                WHERE conversation_key=?
                AND id < ?
                LIMIT 1
            `, [key, oldest.id])
            : []

        res.json({
            conversation_key: key,
            chat_name: chatName,
            avatar: chatAvatar,
            sender_avatar: senderAvatar,
            chat_avatar: chatAvatar,
            messages: rows,
            has_more: more.length > 0,
            next_before: oldest?.id || 0
        })
    } catch (err) {
        console.error("[API] Conversation error:", err.message)
        res.status(500).json({ error: err.message })
    }
})

app.delete("/api/delete/conversation/:key", requireSession, async (req, res) => {
    try {
        const key = decodeURIComponent(req.params.key)
        const sessionId = req.session_id

        await run(`
            DELETE FROM messages
            WHERE session_id = ?
            AND conversation_key = ?
        `, [sessionId, key])

        res.json({ success: true })
    } catch (err) {
        console.error("[DELETE CONVERSATION]", err.message)
        res.status(500).json({ error: err.message })
    }
})


app.get("/api/status/:id",requireSession, async(req,res)=>{
    try{
        const id=Number(req.params.id)
        if(!Number.isInteger(id))
            return res.status(400).json({error:"Invalid status ID"})

        const rows=await all(`
            SELECT media_path,media_type,mime_type,is_status
            FROM messages
            WHERE id=?
            LIMIT 1
        `,[id])

        const row=rows[0]
        if(!row||Number(row.is_status)!==1)
            return res.status(404).json({error:"Status not found"})

        if(!row.media_path)
            return res.status(404).json({error:"Status media unavailable"})

        const filePath=path.join( process.cwd(), "lib", row.media_path.replace(/^[/\\]+/,"") )

        if(!fs.existsSync(filePath)){
            return res.status(404).json({error:"Status media not found"})
        }

        if(req.query.preview==="0"){
            if(row.mime_type)res.type(row.mime_type)
            await viewStatus(id)
            return res.sendFile(path.resolve(filePath))
        }

        if(row.media_type==="image"){
            const buffer=await sharp(filePath)
                .resize({
                    width:320,
                    height:320,
                    fit:"inside",
                    withoutEnlargement:true
                })
                .jpeg({quality:55})
                .toBuffer()

            return res.type("image/jpeg").send(buffer)
        }

        if(row.media_type==="video"){
            return res.sendFile(path.resolve(filePath))
        }

        return res.status(404).json({error:"Unsupported status media"})
    }catch(err){
        console.error("[STATUS MEDIA]",err.message)
        if(!res.headersSent)
            res.status(500).json({error:err.message})
    }
})

async function resolveConversationTarget(conversationKey){
    const rows=await all(`
        SELECT session_id,jid,sender
        FROM messages
        WHERE conversation_key=?
        ORDER BY id DESC LIMIT 1
    `,[conversationKey])

    const row=rows[0]

    if(row){
        const session=getSession(row.session_id)
        if(!session?.sock)return null
        return {row,session,jid:row.jid}
    }

    const i=conversationKey.indexOf(":")
    if(i===-1)return null

    const sessionId=conversationKey.slice(0,i)
    const jid=conversationKey.slice(i+1)
    const session=getSession(sessionId)

    if(!session?.sock||!jid)return null

    return {
        row:{session_id:sessionId,jid,sender:jid},
        session,
        jid
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

app.post("/api/messages/react",requireSession,  async (req, res) => {
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

app.post("/api/messages/pin",requireSession,  async (req, res) => {
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

app.post("/api/status/reply",requireSession,  async (req, res) => {
    try {
        const { session_id, sender, text, status_msg_id } = req.body || {}
        const session = await getCookieSession(req)

        if (!session)
            return res.status(401).json({
                error: "Session unavailable"
            })
    

        if (!session?.sock || !sender || !text || !status_msg_id)
            return res.status(400).json({ error: "Missing required fields" })

        const rows = await all(`
            SELECT * FROM messages
            WHERE session_id = ? AND msg_id = ? AND is_status = 1
            LIMIT 1
        `, [session_id, status_msg_id])

        const status = rows[0]
        if (!status)
            return res.status(404).json({ error: "Status not found" })

        let message

        if (status.media_type === "image")
            message = {
                imageMessage: {
                    url: status.media_path,
                    mimetype: status.mime_type || "image/jpeg",
                    caption: status.text || undefined
                }
            }
        else if (status.media_type === "video")
            message = {
                videoMessage: {
                    url: status.media_path,
                    mimetype: status.mime_type || "video/mp4",
                    caption: status.text || undefined
                }
            }
        else
            message = { conversation: status.text || "" }

        const sent = await session.sock.sendMessage(
            sender,
            { text },
            {
                quoted: {
                    key: {
                        remoteJid: "status@broadcast",
                        fromMe: Boolean(status.from_me),
                        id: status.msg_id,
                        participant: status.sender
                    },
                    message
                }
            }
        )

        res.json({ success: true, key: sent?.key || null })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})


app.post("/api/messages/send",requireSession, async(req,res)=>{

    try{

        const body=req.body||{}

        const conversationKey=String(
            body.conversation_key||""
        ).trim()

        const text=
            typeof body.text==="string"
                ? body.text.trim()
                : ""

        const media=
            body.media&&typeof body.media==="object"
                ? body.media
                : null


        if(!conversationKey)
            return res.status(400).json({
                error:"conversation_key is required"
            })

        const target=await resolveConversationTarget(
            conversationKey
        )


        if(!target)
            return res.status(404).json({
                error:"Conversation session is not available"
            })

        if(target.jid==="status@broadcast")
            return res.status(400).json({
                error:"Status broadcasts are read-only"
            })

        if(!text&&!media)
            return res.status(400).json({
                error:"Message text or media is required"
            })

        const replyMessage=await getReplyMessage(
            conversationKey,
            body.reply_to,
            target.row.session_id
        )

        let outgoing

        if(media){

            const mediaType=String(
                media.type||""
            ).toLowerCase()


            if(mediaType==="sticker"){

                const fileName=path.basename(
                    String(media.fileName||"")
                )

                if(!fileName)
                    return res.status(400).json({
                        error:"Sticker file is missing"
                    })

                const stickerPath=path.join(
                    __dirname,
                    "lib",
                    "uploads",
                    "stickers",
                    fileName
                )

                if(!fs.existsSync(stickerPath))
                    return res.status(404).json({
                        error:"Sticker not found"
                    })

                outgoing={
                    sticker:fs.readFileSync(stickerPath)
                }

            }else{

                const allowed=new Set([
                    "image",
                    "video",
                    "audio",
                    "document"
                ])

                if(!allowed.has(mediaType))
                    return res.status(400).json({
                        error:"Unsupported media type"
                    })

                if(
                    typeof media.base64!=="string"||
                    !media.base64
                )
                    return res.status(400).json({
                        error:"Media data is missing"
                    })

                const base64=media.base64.replace(
                    /^data:[^;]+;base64,/,
                    ""
                )

                const buffer=Buffer.from(
                    base64,
                    "base64"
                )


                if(!buffer.length)
                    return res.status(400).json({
                        error:"Media data is empty"
                    })

                const caption=text||undefined

                if(mediaType==="image"){

                    outgoing={
                        image:buffer,
                        caption,
                        mimetype:media.mimetype||undefined
                    }

                }else if(mediaType==="video"){

                    outgoing={
                        video:buffer,
                        caption,
                        mimetype:media.mimetype||undefined
                    }

                }else if(mediaType==="audio"){

                    outgoing={
                        audio:buffer,
                        mimetype:
                            media.mimetype||
                            "audio/webm; codecs=opus",
                        ptt:Boolean(media.ptt)
                    }

                }else{

                    outgoing={
                        document:buffer,
                        mimetype:
                            media.mimetype||
                            "application/octet-stream",
                        fileName:
                            media.fileName||
                            "attachment"
                    }

                    if(caption)
                        outgoing.caption=caption

                }

            }

        }else{

            outgoing={
                text
            }

        }



        const sendOptions=replyMessage
            ? {
                quoted:replyMessage
            }
            : undefined

            console.log(
                target.jid,
                outgoing,
                sendOptions
            )

        const sent=await target.session.sock.sendMessage(
            target.jid,
            outgoing,
            sendOptions
        )
        if(body.client_id&&sent?.key?.id){
            pendingClientIds.set(
                `${target.row.session_id}:${sent.key.id}`,
                body.client_id
            )
        }

        setPendingIds(pendingClientIds)

        const sentType=media?.type||"text"


        res.json({
            success:true,
            type:sentType,
            client_id:body.client_id||null,
            key:sent?.key||null,
            conversation_key:conversationKey,
            reply_to:body.reply_to||null
        })

    }catch(err){

        console.error(
            "[ADMIN SEND] ERROR",
            err.message,
            err
        )

        res.status(500).json({
            error:err.message
        })

    }

})


app.post("/api/calls/reject",requireSession,async(req,res)=>{
    try{
        const{call_id,call_from}=req.body||{}

        if(!call_id||!call_from){
            return res.status(400).json({
                error:"call_id and call_from are required"
            })
        }

        const session=getSession(req.sessionId)

        if(!session?.sock){
            return res.status(404).json({
                error:"Session is not available"
            })
        }

        await session.sock.rejectCall(
            call_id,
            call_from
        )

        res.json({
            success:true
        })
    }catch(err){
        console.error("[CALL REJECT]",err.message)
        res.status(500).json({
            error:err.message
        })
    }
})

const {
    getContentType
}=require("@whiskeysockets/baileys")

const {getButtonArgs}=require("gifted-btns")

app.post("/api/messages/send-link",requireSession,async(req,res)=>{
    try{
        const {
            conversation_key,
            url,
            display_text="Open Link",
            text="Open the link below:"
        }=req.body||{}

        console.log("[SEND LINK]",{
            conversation_key,
            url,
            display_text
        })

        if(!conversation_key||!url)
            return res.status(400).json({
                error:"conversation_key and url are required"
            })

        const target=await resolveConversationTarget(conversation_key)

        if(!target?.session?.sock)
            return res.status(503).json({error:"Session unavailable"})

        if(target.jid==="status@broadcast")
            return res.status(400).json({
                error:"Status broadcasts are read-only"
            })

        const content={
            interactiveMessage:{
                body:{text},
                nativeFlowMessage:{
                    buttons:[
                        {
                            name:"cta_url",
                            buttonParamsJson:JSON.stringify({
                                display_text,
                                url,
                                merchant_url:url
                            })
                        }
                    ]
                }
            }
        }

        const msg=generateWAMessageFromContent(
            target.jid,
            content,
            {
                userJid:target.session.sock.user?.id,
                timestamp:new Date()
            }
        )

        const node=getButtonArgs(content)

        console.log("[SEND LINK] Node",JSON.stringify(node,null,2))

        await target.session.sock.relayMessage(
            target.jid,
            msg.message,
            {
                messageId:msg.key.id,
                additionalNodes:[node]
            }
        )

        console.log("[SEND LINK] Sent",{
            id:msg.key.id,
            jid:target.jid,
            url
        })

        res.json({
            success:true,
            key:msg.key,
            conversation_key
        })
    }catch(err){
        console.error("[SEND LINK] Error:",err)
        res.status(500).json({error:err.message})
    }
})

app.post("/api/pair", async (req, res) => {
    try {
        const phone = String(req.body.phone || "").replace(/\D/g, "")

        if (!phone)
            return res.status(400).json({ error: "Phone number required" })

        if (phone.length < 8)
            return res.status(400).json({ error: "Invalid phone number" })

        const r = await pair(phone, phone)

        if (r.redirect) {
            const token = jwt.sign(
                {
                    session_id: phone,
                    phone
                },
                process.env.JWT_SECRET
            )

            res.cookie("paired_token", token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                expires: new Date("9999-12-31")
            })

            res.cookie("adminSession", phone, {
                httpOnly: true,
                secure: process.env.NODE_ENV === "production",
                sameSite: "lax",
                expires: new Date("9999-12-31")
            })

            return res.json({ redirect: "/" })
        }

        res.json(r)

    } catch (err) {
        console.error("[PAIR]", err.message)
        res.status(500).json({ error: err.message })
    }
})

app.post("/api/pair/qr", async (req, res) => {
    try {
        if (activeQRSession) {
            const session = getSession(activeQRSession)

            if (session && session.status !== "disconnected") {
                return res.json({
                    session_id: activeQRSession
                })
            }

            activeQRSession = null
        }

        const { id } = await createQRSession()

        activeQRSession = id

        res.json({
            session_id: id
        })
    } catch (err) {
        console.error("[QR]", err.message)
        res.status(500).json({
            error: err.message
        })
    }
})

app.post("/api/logout/:id",requireSession,  async (req, res) => {
    try {
        res.cookie("adminSession", 0, {
            maxAge: -60000
        })
        res.json({ success: await logout(req.params.id) })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get("/api/contacts/all",requireSession, async(req,res)=>{
    try{
        const contacts=await all(`
            SELECT id,name,phone,email,created_at
            FROM contacts
            ORDER BY name COLLATE NOCASE ASC
        `)
        res.json({success:true,contacts})
    }catch(err){
        console.error("[CONTACTS]",err)
        res.status(500).json({success:false,error:"Failed to load contacts"})
    }
})

async function viewStatus(id){
    console.log('viewing', id)
    const timestamp=new Date().toISOString()

    const rows = await all(`
        SELECT *
        FROM messages
        WHERE id=?
        ORDER BY id DESC
        LIMIT 1
    `, id)

    const row = rows[0]
    if(!row){
    console.log('not viewed')

        return false

    }
    await run(`UPDATE messages SET read_at=? WHERE id=?`,[timestamp,id])
    console.log('viewed')
    return true

}

app.post("/api/status/post",requireSession,async(req,res)=>{
    try{
        const session=req.session

        if(!session?.sock){
            return res.status(503).json({error:"WhatsApp session is not connected"})
        }

        const body=req.body||{}
        const text=typeof body.text==="string"?body.text.trim():""
        const media=body.media&&typeof body.media==="object"?body.media:null
        const audience=String(body.audience||"contacts").trim()
        const recipients=Array.isArray(body.recipients)?body.recipients:[]

        if(!text&&!media){
            return res.status(400).json({error:"Text or media is required"})
        }

        if(!["contacts","except","selected"].includes(audience)){
            return res.status(400).json({error:"Invalid audience"})
        }

        if((audience==="except"||audience==="selected")&&!recipients.length){
            return res.status(400).json({error:"Recipients are required"})
        }

        let content

        if(media){
            const type=String(media.type||"").toLowerCase()

            if(!["image","video"].includes(type)){
                return res.status(400).json({error:"Status media must be image or video"})
            }

            const base64=String(media.base64||"").replace(/^data:[^;]+;base64,/,"")
            const buffer=Buffer.from(base64,"base64")

            if(!buffer.length){
                return res.status(400).json({error:"Media data is empty"})
            }

            if(type==="image"){
                content={image:buffer,caption:text||undefined,mimetype:media.mimetype||undefined}
            }else{
                content={video:buffer,caption:text||undefined,mimetype:media.mimetype||undefined}
            }
        }else{
            content={text}
        }

        const options={
            broadcast:true,
            backgroundColor:String(body.background_color||"#000000"),
            font:Number(body.font??0)
        }

        if(audience==="selected"){
            options.statusJidList=recipients
        }else if(audience==="except"){
            const excluded=new Set(recipients)

            const rows=await all(
                `SELECT phone FROM contacts WHERE session=? AND phone IS NOT NULL AND phone!=''`,
                [session.id]
            )

            options.statusJidList=rows
                .map(x=>String(x.phone||"").replace(/\D/g,""))
                .filter(phone=>phone.length===12&&phone.startsWith("254"))
                .map(phone=>`${phone}@s.whatsapp.net`)
                .filter(jid=>!excluded.has(jid))
        }

        const sent=await session.sock.sendMessage(
            "status@broadcast",
            content,
            options
        )

        res.json({
            success:true,
            key:sent?.key||null,
            type:media?.type||"text",
            audience
        })
    }catch(err){
        console.error("[STATUS POST]",err.message)
        res.status(500).json({error:err.message})
    }
})

app.get('/api/contacts/length', requireSession, async(req, res) => {
    try{
        const contacts=await all(`
            SELECT id,name,phone,email,created_at
            FROM contacts
            ORDER BY name COLLATE NOCASE ASC
        `)
        res.json({success:true,'count':contacts.length})
    } catch(err){
        res.status(500).json({success:false,error:"Failed to load contacts"})

    }

})

app.get("/api/pair/session", (req, res) => {
    try {
        const token = String(req.cookies.paired_token || "").trim()

        if (!token)
            return res.status(401).json({
                error: "Pairing session unavailable"
            })

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        )

        res.json({
            session_id: decoded.session_id
        })
    } catch {
        res.status(401).json({
            error: "Invalid pairing session"
        })
    }
})

io.on("connection",socket=>{

    const cookies=socket.handshake.headers.cookie||""

    const match=cookies
        .split(";")
        .map(x=>x.trim())
        .find(x=>x.startsWith("adminSession="))

    const sessionId=match
        ? decodeURIComponent(
            match.substring("adminSession=".length)
        )
        : ""

    if(sessionId){

        const session=getSession(sessionId)

        if(session){

            session.socketId=socket.id
            socket.sessionId=sessionId

            socket.join(`session:${sessionId}`)

            console.log(
                "[SOCKET BIND]",
                sessionId,
                "socketId:",
                socket.id
            )
        }
    }

    socket.on("pair-session",sessionId=>{

        sessionId=String(sessionId||"").trim()

        if(!sessionId)
            return

        const session=getSession(sessionId)

        if(!session)
            return

        socket.join(`pair:${sessionId}`)

        if(session.qr){

            socket.emit("pairing-qr",{
                session_id:sessionId,
                qr:session.qr
            })

        }

    })

    socket.on("disconnect",()=>{

        const sessionId=socket.sessionId

        if(!sessionId)
            return

        const session=getSession(sessionId)

        if(session?.socketId===socket.id)
            session.socketId=null

    })

})
app.get("/api/restart",async(req,res)=>{
    res.json({success:true,message:"Restarting..."});
    await updateNames()
    setTimeout(()=>{

        process.exit(0);
    },500);
});

async function restart(){
    setTimeout(()=>{
        process.exit(0);
    },500);
}

const PORT=process.env.PORT||3000

async function startServer(){
    await restoreSessions()

    setPendingIds(pendingClientIds)

    setSessionEventEmitter(io)
    setJwt(jwt)

    server.listen(PORT,()=>{
        console.log(`Server running on port ${PORT}`)
    })
}

startServer()

module.exports={app,server,updateNames}