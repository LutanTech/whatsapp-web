require("dotenv").config()

const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const path = require("path")
const sharp = require("sharp")
const cookieParser = require("cookie-parser")

const { pair, logout, restoreSessions, getSessions, getSession, getPresence, isOnlinePresence, requestPresence, setSessionEventEmitter } = require("./lib/sessions")
const { refreshConversationAvatar } = require("./lib/avatar-refresh")
const { all, run } = require("./lib/database")
const { recordMessage, conversationKey, setMessageEmitter } = require("./lib/messages")
const { getContactName, getSavedContactName, clean, unsavedName } = require("./lib/bot")
const { getFullProfilePictureUrl, clearAvatarCache } = require("./lib/avatars")
const fs = require("fs")
const multer = require("multer")
const jwt = require("jsonwebtoken")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.json({ limit: "25mb" }))
app.use(express.static("public"))
app.use(cookieParser())

console.clear()
console.log(process.env.BCK_PASS)
console.log(process.env.ADMIN_EMAIL)
console.log(process.env.ADMIN_PASS)

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

async function migrateAbouts() {
    await run(`
        CREATE TABLE IF NOT EXISTS abouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            jid TEXT NOT NULL,
            about TEXT,
            updated_at INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(session_id, jid)
        )
    `)
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

app.post("/api/contacts/import", upload.single("file"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: "VCF file is required" })

        const content = fs.readFileSync(req.file.path, "utf8")

        const cards = content
            .split(/BEGIN:VCARD/i)
            .slice(1)
            .map(block => block.split(/END:VCARD/i)[0])
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
                }

                else if (/^N[;:]/i.test(line) && !name) {
                    const value = line.substring(line.indexOf(":") + 1)
                    const parts = value.split(";")
                    name = parts
                        .filter(Boolean)
                        .reverse()
                        .join(" ")
                        .trim()
                }

                else if (/^TEL[;:]/i.test(line)) {
                    const value = line.substring(line.indexOf(":") + 1).trim()
                    if (value) phones.push(value)
                }

                else if (/^EMAIL[;:]/i.test(line)) {
                    const value = line.substring(line.indexOf(":") + 1).trim()
                    if (value) emails.push(value)
                }
            }

            name=decodeQuotedPrintable(name.trim())

            if (!name || (!phones.length && !emails.length)) {
                skipped++
                continue
            }

            const uniquePhones = [...new Set(phones)]
            const uniqueEmails = [...new Set(emails)]

            for (const phone of uniquePhones) {
                await run(`
                    INSERT OR IGNORE INTO contacts (name, phone, email)
                    VALUES (?, ?, ?)
                `, [
                    name,
                    phone,
                    uniqueEmails[0] || ""
                ])

                numbers++
            }

            if (!uniquePhones.length) {
                await run(`
                    INSERT OR IGNORE INTO contacts (name, phone, email)
                    VALUES (?, ?, ?)
                `, [
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

async function updateNames(){
    try{
        const rows=await all(`SELECT id,session_id,jid,sender,push_name,from_me FROM messages WHERE session_id IS NOT NULL`)
        let updated=0,skipped=0
        for(const row of rows){
            const session=getSession(row.session_id)
            if(!session){skipped++;continue}
            const target=String(row.jid||"").endsWith("@g.us")||row.jid==="status@broadcast"?row.sender:row.jid
            const saved=await getSavedContactName(session,target)
            const push=clean(row.push_name)
            const name=saved||(row.from_me?"":push?unsavedName(push):"")
            if(!name){skipped++;continue}
            await run(`UPDATE messages SET sender_name=? WHERE id=?`,[name,row.id])
            updated++
        }
    }catch(err){console.error("[CONTACT UPDATE]",err)}
}

async function migrateDatabaseSchema() {
    const columnsToMigrate = [
        `ALTER TABLE messages ADD COLUMN channel_name TEXT`,
        `ALTER TABLE messages ADD COLUMN avatar TEXT`,
        `ALTER TABLE messages ADD COLUMN sender_avatar TEXT`,
        `ALTER TABLE messages ADD COLUMN chat_avatar TEXT`,
        `ALTER TABLE messages ADD COLUMN media_size INTEGER DEFAULT 0`,
        `ALTER TABLE messages ADD COLUMN is_status INTEGER DEFAULT 0`,
        `ALTER TABLE messages ADD COLUMN is_view_once INTEGER DEFAULT 0`,
        `ALTER TABLE messages ADD COLUMN read_at INTEGER DEFAULT 0`,
        `ALTER TABLE sessions ADD COLUMN token TEXT`,
        `ALTER TABLE sessions ADD COLUMN token_expires_at INTEGER DEFAULT 0`,
       ` ALTER TABLE messages ADD COLUMN link_url TEXT`,
        `ALTER TABLE messages ADD COLUMN link_title TEXT`,
        `ALTER TABLE messages ADD COLUMN link_description TEXT`,
        `ALTER TABLE messages ADD COLUMN link_image TEXT`,
        `ALTER TABLE messages ADD COLUMN link_site_name TEXT`,
        `ALTER TABLE messages ADD COLUMN link_type TEXT`,
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


app.get("/", async (req, res) => {
    const session = await getAdminSession(req.cookies.admin_token)

    if (session)
        return res.redirect("/admin")

    res.redirect("/admin")
})

app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin.html"))
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
        updateNames()

        const rows = await all(`
            SELECT
                m.conversation_key,m.session_id,m.jid,m.sender,m.sender_name,
                m.receiver,m.push_name,m.group_name,m.channel_name,
                (
                    SELECT COUNT(*) FROM messages u
                    WHERE u.conversation_key=m.conversation_key
                    AND u.from_me=0
                    AND u.jid!='status@broadcast'
                    AND COALESCE(u.read_at,0)=0
                ) AS unread_count,
                (
                    SELECT COALESCE(NULLIF(i.push_name,''),NULLIF(i.sender_name,''),'')
                    FROM messages i
                    WHERE i.conversation_key=m.conversation_key
                    AND i.from_me=0
                    ORDER BY i.id DESC LIMIT 1
                ) AS incoming_user_name,
                m.avatar,m.sender_avatar,m.chat_avatar,
                m.created_at AS last_time,m.from_me AS last_from_me,
                m.text,m.reaction,m.media_type,
                COALESCE(NULLIF(m.text,''),NULLIF(m.reaction,''),CASE
                    WHEN m.media_type='image' THEN 'Photo'
                    WHEN m.media_type='video' THEN 'Video'
                    WHEN m.media_type='audio' THEN 'Audio'
                    WHEN m.media_type='document' THEN 'Document'
                    WHEN m.media_type='sticker' THEN 'Sticker'
                    ELSE ''
                END) ||
                CASE
                    WHEN NULLIF(m.reaction,'') IS NOT NULL AND NULLIF(m.quoted_text,'') IS NOT NULL
                    THEN ' to '||m.quoted_text
                    ELSE ''
                END AS last_message
            FROM messages m
            INNER JOIN (
                SELECT conversation_key,MAX(id) AS last_id
                FROM messages
                WHERE conversation_key IS NOT NULL AND conversation_key!=''
                GROUP BY conversation_key
            ) x ON m.id=x.last_id
            ORDER BY m.created_at DESC
        `)

        updateNames()

        const conversations = await Promise.all(rows.map(async row => {
            const session=getSession(row.session_id)
            const jid=String(row.jid||"")
            const isStatus=jid==="status@broadcast"
            const isGroup=jid.endsWith("@g.us")
            const isChannel=jid.endsWith("@newsletter")
            const isSelf=jid===`${row.session_id}@s.whatsapp.net`
            const owner=String(session?.sock?.user?.name||"").trim()
            const target=isGroup||isChannel?row.sender:jid
            const live=session?String(await getContactName(session,target)||"").trim():""
            const stored=String(row.sender_name||"").trim()
            const push=String(row.push_name||"").trim()
            const incoming=String(row.incoming_user_name||"").trim()
            const safe=n=>n&&n!==owner&&n!==row.group_name&&n!==row.channel_name?n:""
            const name=safe(live)||safe(stored)||incoming||(push?unsavedName(push):"")
            const outgoing=row.last_from_me===1||row.last_from_me===true||String(row.last_from_me).toLowerCase()==="true"
            const presence=!session||isStatus||isGroup||isChannel||isSelf?"unavailable":getPresence(row.session_id,jid)

            if(session&&!isStatus&&!isGroup&&!isChannel&&!isSelf)
                requestPresence(row.session_id,jid)

            const chatName=isStatus
                ?"WhatsApp Status Broadcasts"
                :isGroup
                ?row.group_name||name||jid
                :isChannel
                ?row.channel_name||name||jid
                :isSelf
                ?owner||name
                :name||jid

            return {
                ...row,
                chat_name:chatName,
                last_from_me:outgoing,
                last_sender_name:isGroup? name||row.sender : "",
                other_user_name:isStatus
                    ?name||row.sender||""
                    :isGroup
                    ?row.group_name||chatName
                    :isSelf
                    ?owner
                    :name||jid,
                is_online:isOnlinePresence(presence),
                presence
            }
        }))

        res.json({ conversations })
    } catch(err) {
        res.status(500).json({ error:err.message })
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

app.get("/api/conversations/:key",async(req,res)=>{
    try{
        const key=decodeURIComponent(req.params.key)
        const isStatus=key.endsWith(":status:status@broadcast")
        const date=String(req.query.date||"").trim()
        let rows,params=[key],condition=""

        if(isStatus){
            if(date==="previous")
                condition=`AND date(created_at,'unixepoch','localtime')=date('now','localtime','-1 day')`
            else if(/^\d{4}-\d{2}-\d{2}$/.test(date)){
                condition=`AND date(created_at,'unixepoch','localtime')=?`
                params.push(date)
            }else
                condition=`AND date(created_at,'unixepoch','localtime')=date('now','localtime')`

            rows=await all(`
                SELECT * FROM messages
                WHERE conversation_key=? AND is_status=1 ${condition}
                ORDER BY created_at ASC,id ASC
            `,params)
        }else{
            rows=await all(`
                SELECT * FROM messages
                WHERE conversation_key=?
                ORDER BY created_at ASC,id ASC
            `,[key])
        }

        let avatar=rows[0]||null
        const session=rows[0]?getSession(rows[0].session_id):null

        if(session){
            rows=await Promise.all(rows.map(async row=>{
                const quotedSender=String(row.quoted_sender||"").trim()

                const message={
                    ...row,
                    quoted_sender_name:quotedSender
                        ?String(await getContactName(session,quotedSender)||"").trim()
                        :""
                }

                if(isStatus)
                    message.media_path=`/api/status/${row.id}`

                return message
            }))
        }

        res.json({
            conversation_key:key,
            chat_name:avatar?.chat_name||avatar?.sender_name||"",
            avatar:avatar?.avatar||"",
            sender_avatar:avatar?.sender_avatar||"",
            chat_avatar:avatar?.chat_avatar||"",
            messages:rows
        })
    }catch(err){
        console.error("[API] Conversation error:",err.message)
        res.status(500).json({error:err.message})
    }
})

app.get("/api/status/:id",async(req,res)=>{
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

        const filePath=path.join( process.cwd(), "public", row.media_path.replace(/^[/\\]+/,"") )

        if(!fs.existsSync(filePath)){
            console.log(filePath)
            return res.status(404).json({error:"Status media not found"})
        }

        if(req.query.preview==="0"){
            if(row.mime_type)res.type(row.mime_type)
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
        const { session_id, sender, text, status_msg_id } = req.body || {}
        const session = getSession(session_id)

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

app.post("/api/messages/send",async(req,res)=>{
    try{
        const body=req.body||{}
        const conversationKey=String(body.conversation_key||"").trim()
        const text=typeof body.text==="string"?body.text.trim():""
        const media=body.media&&typeof body.media==="object"?body.media:null

        if(!conversationKey)return res.status(400).json({error:"conversation_key is required"})

        const target=await resolveConversationTarget(conversationKey)
        if(!target)return res.status(404).json({error:"Conversation session is not available"})
        if(target.jid==="status@broadcast")return res.status(400).json({error:"Status broadcasts are read-only"})
        if(!text&&!media)return res.status(400).json({error:"Message text or media is required"})

        const replyMessage=await getReplyMessage(
            conversationKey,
            body.reply_to,
            target.row.session_id
        )

        let outgoing

        if(media){
            const mediaType=String(media.type||"").toLowerCase()

            if(mediaType==="sticker"){
                const fileName=path.basename(String(media.fileName||""))
                
                if(!fileName)return res.status(400).json({error:"Sticker file is missing"})

                const stickerPath=path.join(__dirname,"lib","uploads","stickers",fileName)

                if(!fs.existsSync(stickerPath))
                    return res.status(404).json({error:"Sticker not found"})

                outgoing={sticker:fs.readFileSync(stickerPath)}
            }else{
                const allowed=new Set(["image","video","audio","document"])
                if(!allowed.has(mediaType))
                    return res.status(400).json({error:"Unsupported media type"})

                if(typeof media.base64!=="string"||!media.base64)
                    return res.status(400).json({error:"Media data is missing"})

                const base64=media.base64.replace(/^data:[^;]+;base64,/,"")
                const buffer=Buffer.from(base64,"base64")
                if(!buffer.length)return res.status(400).json({error:"Media data is empty"})

                const caption=text||undefined

                if(mediaType==="image"){
                    outgoing={image:buffer,caption,mimetype:media.mimetype||undefined}
                }else if(mediaType==="video"){
                    outgoing={video:buffer,caption,mimetype:media.mimetype||undefined}
                }else if(mediaType==="audio"){
                    outgoing={
                        audio:buffer,
                        mimetype:media.mimetype||"audio/webm; codecs=opus",
                        ptt:Boolean(media.ptt)
                    }
                }else{
                    outgoing={
                        document:buffer,
                        mimetype:media.mimetype||"application/octet-stream",
                        fileName:media.fileName||"attachment"
                    }
                    if(caption)outgoing.caption=caption
                }
            }
        }else{
            outgoing={text}
        }

        const sendOptions=replyMessage?{quoted:replyMessage}:undefined

        const sent=await target.session.sock.sendMessage(
            target.jid,
            outgoing,
            sendOptions
        )

        const sentType=media?.type||"text"

        console.log(
            `[ADMIN SEND] ${sentType} -> ${target.jid}`,
            sent?.key?.id||""
        )

        res.json({
            success:true,
            type:sentType,
            key:sent?.key||null,
            conversation_key:conversationKey,
            reply_to:body.reply_to||null
        })
    }catch(err){
        console.error("[ADMIN SEND] Error:",err.message)
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

app.get("/api/contacts/all",async(req,res)=>{
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

app.get('/status/view/:id/:auth', async(req, res) => {
    const id = req.params.id
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
        return res.status(404).json({success:false, 'error':'Status not found'})

    }
    await run(`UPDATE messages SET read_at=? WHERE id=?`,[timestamp,id])
    return res.status(200).json({success:true, 'message':'Viewed'})

})

app.get('/api/contacts/length', async(req, res) => {
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

setInterval( async ()=>{
    io.emit("sessions", getSessions())
    await updateNames()
}, 3000)

const PORT = process.env.PORT || 3000

server.listen(PORT, async () => {
    await migrateDatabaseSchema()
    await restoreSessions()
    migrateContacts()
    migrateAbouts()
    console.log(`Server running on port ${PORT}`)
})

module.exports = { app, server, updateNames }