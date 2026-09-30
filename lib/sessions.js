const fs = require("fs")
const path = require("path")
const { Boom } = require("@hapi/boom")
const pino = require("pino")
const { run, all, get } = require("./database")
const { refreshSessionAvatars } = require("./avatar-refresh")
const crypto = require("crypto")
const { emitMessage } = require("./messages")

let makeWASocket
let useMultiFileAuthState
let DisconnectReason
let Browsers
let fetchLatestWaWebVersion
let pairingCompleted = false
let sessionEventEmitter = null
let jwt = null
let callEmitter=null

function emitCall(sessionId,call,event="call"){
    const session=getSession(sessionId)
    if(!session?.socketId||!callEmitter)return
    callEmitter.to(session.socketId).emit(event,call)
}


async function loadBaileys() {
    if (makeWASocket) return
    const b = await import("@whiskeysockets/baileys")
    makeWASocket = b.default
    useMultiFileAuthState = b.useMultiFileAuthState
    DisconnectReason = b.DisconnectReason
    Browsers = b.Browsers
    fetchLatestWaWebVersion = b.fetchLatestWaWebVersion
}

const sessions = new Map()
const SESSION_DIR = path.resolve(process.env.SESSION_DIR || "./sessions")

fs.mkdirSync(SESSION_DIR, { recursive: true })

const logger = pino({ level: process.env.LOG_LEVEL || "silent" })

async function createQRSession() {
    const id = `qr_${crypto.randomUUID()}`

    const session = await createSession(id, null)

    return {
        id,
        session
    }
}

async function saveStatus(id, phone, status) {
    try {
        await run(`
            INSERT INTO sessions (id, phone, status)
            VALUES (?, ?, ?)
            ON CONFLICT(id)
            DO UPDATE SET
                phone = excluded.phone,
                status = excluded.status,
                updated_at = unixepoch()
        `, [id, phone, status])
    } catch (e) {
        console.error("[DB]", e.message)
    }
}

async function createSession(id,phone=""){

    await loadBaileys()

    if(sessions.has(id)){
        const existing=sessions.get(id)
        if(existing?.status==="connecting"&&existing?.sock)
            return existing
        sessions.delete(id)
    }

    const folder=path.join(SESSION_DIR,id)
    fs.mkdirSync(folder,{recursive:true})

    let auth

    try{
        const t=Date.now()
        auth=await useMultiFileAuthState(folder)
    }catch(e){
        console.error("[AUTH] Load failed:",e.message)
        throw e
    }

    const {state,saveCreds}=auth

    let version

    try{
        const t=Date.now()
        const latest=await fetchLatestWaWebVersion()

        if(latest?.version)
            version=latest.version
    }catch(e){
        console.error("[WA] Version fetch failed:",e.message)
    }

    let sock

    try{
        const t=Date.now()
        const options={
            auth:state,
            logger,
            markOnlineOnConnect:false,
            syncFullHistory:true,
            browser:Browsers.windows("Chrome"),
            connectTimeoutMs:60000,
            defaultQueryTimeoutMs:60000
        }

        if(version)
            options.version=version

        sock=makeWASocket(options)


    }catch(e){
        console.error("[WA] Socket failed:",e.message)
        throw e
    }

    const session={
        id,
        phone,
        sock,
        status:"connecting",
        contacts:new Map(),
        presence:new Map(),
        presenceRequested:new Map()
    }

    sessions.set(id,session)
    await saveStatus(id,phone,"connecting")

    sock.ev.on("creds.update",async creds=>{
        try{
            await saveCreds(creds)
        }catch(e){
            console.error("[AUTH] Save failed:",e.message)
        }
    })

    sock.ev.on("contacts.set",({contacts})=>{
        if(!contacts)return
        for(const contact of contacts){
            if(!contact?.id)continue
            const old=session.contacts.get(contact.id)||{}
            session.contacts.set(contact.id,{...old,...contact})
        }
    })

    sock.ev.on("contacts.upsert",async items=>{
        for(const contact of items){
            if(!contact?.id)continue
    
            const old=session.contacts.get(contact.id)||{}
            session.contacts.set(contact.id,{...old,...contact})
    
            const jid=contact.phoneNumber||contact.id
            if(!jid?.endsWith("@s.whatsapp.net"))continue
    
            const phone=String(jid).replace(/\D/g,"")
            const name=String(contact.name||contact.notify||contact.pushName||"").trim()
    
            if(!phone||!name)continue
    
            try{
                const existing=await get(`
                    SELECT id,name
                    FROM contacts
                    WHERE session=?
                    AND REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','')=?
                    LIMIT 1
                `,[session.id,phone])
    
                if(existing){
                    if(existing.name!==name){
                        await run(`
                            UPDATE contacts
                            SET name=?
                            WHERE id=?
                        `,[name,existing.id])
                    }
                }else{
                    await run(`
                        INSERT INTO contacts(session,name,phone)
                        VALUES(?,?,?)
                    `,[session.id,name,phone])
                }
            }catch(e){
                console.error("[CONTACTS]",e.message)
            }
        }
    
        sessionEventEmitter?.to(session.socketId).emit("invalidateContacts")
    })

    sock.ev.on("call",calls=>{
        for(const call of calls){
            sessionEventEmitter?.emit("call",{
                session_id:session.id,
                id:call.id,
                chat_id:call.chatId,
                from:call.from,
                caller_pn:call.callerPn||"",
                status:call.status,
                is_video:!!call.isVideo,
                is_group:!!call.isGroup,
                date:call.date
            })
        }
    })

    sock.ev.on("contacts.update",items=>{
        for(const contact of items){
            if(!contact?.id)continue
            const old=session.contacts.get(contact.id)||{}
            session.contacts.set(contact.id,{...old,...contact})
        }
    })

    sock.ev.on("presence.update",({id:jidId,presences})=>{
        if(!jidId||!presences)return

        for(const [jid,presence] of Object.entries(presences)){
            const state=String(
                presence.lastKnownPresence||""
            ).toLowerCase()

            sessionEventEmitter?.emit("presence",{
                phone,
                session_id:session.id,
                jid,
                presence:state,
                online:["available","composing","recording"].includes(state),
                typing:state==="composing",
                recording:state==="recording"
            })
        }
    })

    sock.ev.on("connection.update",async({connection,lastDisconnect,qr})=>{
        if(qr){
            session.qr=qr
            sessionEventEmitter?.to(`pair:${id}`).emit(
                "pairing-qr",
                {session_id:id,qr}
            )
        }



        console.log(`[CONNECTION] ${id}: ${connection}`,lastDisconnect?.error?.message||"",new Boom(lastDisconnect?.error).output.statusCode||"",lastDisconnect?.error?.data||"")

        if(connection==="connecting"){
            session.status="connecting"
            await saveStatus(id,session.phone,"connecting")
        }

        if(connection==="open"){
            session.status="connected"

            if(id.startsWith("qr_")&&sock.user?.id){
                const phone=String(sock.user.id)
                    .split(":")[0]
                    .split("@")[0]

                const oldId=id
                const oldFolder=path.join(SESSION_DIR,oldId)
                const newFolder=path.join(SESSION_DIR,phone)

                session.promoting=true

                await sock.ws?.close?.()

                await run(
                    "DELETE FROM sessions WHERE id=?",
                    [oldId]
                )

                if(fs.existsSync(newFolder)){
                    await fs.promises.rm(newFolder,{
                        recursive:true,
                        force:true
                    })
                }

                await fs.promises.rename(oldFolder,newFolder)
                sessions.delete(oldId)

                const permanent=await createSession(phone,phone)
                permanent.status="connected"
                permanent.phone=phone

                await saveStatus(
                    phone,
                    phone,
                    "connected"
                )
                broadcastExistingMessages(session)

                const qrToken=jwt.sign(
                    {session_id:phone},
                    process.env.JWT_SECRET,
                    {expiresIn:"10m"}
                )

                sessionEventEmitter?.to(`pair:${oldId}`).emit(
                    "paired-qr",
                    {
                        session_id:phone,
                        phone,
                        qr_token:qrToken,
                        adminSession:phone
                    }
                )

                console.log(
                    `[QR] Session renamed: ${oldId} → ${phone}`
                )

                return
            }

            await saveStatus(
                id,
                session.phone,
                "connected"
            )
            broadcastExistingMessages(session)


            sessionEventEmitter?.to(`pair:${id}`).emit(
                "paired",
                {
                    session_id:id,
                    phone:session.phone
                }
            )

            console.log(`[WA] Connected: ${id}`)

            all(`
                SELECT DISTINCT jid
                FROM messages
                WHERE session_id=?
                AND jid IS NOT NULL
                AND jid!=''
                AND jid!='status@broadcast'
            `,[id]).then(async rows=>{
                const jids=rows
                    .map(row=>row.jid)
                    .filter(Boolean)

                await Promise.allSettled(
                    jids.map(jid=>
                        sock.presenceSubscribe(jid)
                    )
                )


            }).catch(error=>{
                console.error(
                    `[PRESENCE] Subscription failed: ${id}`,
                    error.message
                )
            })

            refreshSessionAvatars(session)
                .then(count=>{
                })
                .catch(error=>{
                    console.error(
                        `[AVATAR] Session refresh failed: ${id}`,
                        error.message
                    )
                })
        }

        if(connection!=="close")return
        if(session.promoting)return

        const code=new Boom(
            lastDisconnect?.error
        ).output.statusCode

        session.status="disconnected"

        await saveStatus(
            session.id,
            session.phone,
            "disconnected"
        )

        if(
            code===DisconnectReason.loggedOut||
            code===DisconnectReason.badSession||
            code===DisconnectReason.connectionReplaced
        ){
            sessions.delete(session.id)
            return
        }

        if(![
            DisconnectReason.connectionClosed,
            DisconnectReason.connectionLost,
            DisconnectReason.timedOut,
            DisconnectReason.restartRequired
        ].includes(code)){
            sessions.delete(session.id)
            return
        }

        const reconnectId=session.id
        const reconnectPhone=session.phone

        session.status="connecting"

        setTimeout(()=>{
            createSession(
                reconnectId,
                reconnectPhone
            ).catch(e=>{
                console.error(
                    `[WA] Reconnect failed: ${reconnectId}`,
                    e.message
                )
            })
        },5000)
    })

    sock.ev.on("messaging-history.set",({messages})=>{
        const count=messages?.length||0
        if(!count)return

        session.historyDownloaded=
            (session.historyDownloaded||0)+count

        sessionEventEmitter?.to(`session:${id}`).emit(
            "history-progress",
            {
                session_id:id,
                downloaded:session.historyDownloaded,
                total:0
            }
        )

        console.log(
            `[HISTORY] ${id}: ${count} messages received`
        )
    })

    sock.ev.on("messages.upsert",async event=>{
        const messages=event.messages||[]
        if(!messages.length)return
    
        const bot=require("./bot")
        const isHistory=event.type==="append"
        const batchSize=25
    
        for(let i=0;i<messages.length;i+=batchSize){
            const batch=messages.slice(i,i+batchSize)
    
            await Promise.allSettled(
                batch.map(message=>{
    
                    return bot.handleMessage(
                        session,
                        message,
                        isHistory
                    ).catch(e=>{
                        console.error(
                            `[MSG] ${session.id} Processing failed:`,
                            e.message
                        )
                    })
                })
            )
        }
    })

    return session
}


async function broadcastExistingMessages(session){
    if(!session?.id||!sessionEventEmitter)return
    try{
        const started=Date.now()

        
        const rows=await all(`
            SELECT *
            FROM messages
            WHERE session_id=?
            ORDER BY created_at ASC,id ASC
        `,[session.id])
        
        
        sessionEventEmitter
            .to(`session:${session.id}`)
            .emit("messages-sync",{
                session_id:session.id,
                messages:rows
            })
        
    }catch(e){
        console.error(`[SYNC] ${session.id}:`,e.message)
    }
}
async function pair(id, phone) {
    phone = String(phone).replace(/\D/g, "")

    if (!phone) throw new Error("Invalid phone number")

    const session = await createSession(id, phone)
    const registered = session.sock.authState?.creds?.registered

    if (registered) {
        
        return { registered: true, code: null, redirect:true }
    }

    if (session.sock.ws?.readyState !== 1) {
        await new Promise(resolve => setTimeout(resolve, 3000))
    }

    const code = await session.sock.requestPairingCode(phone)

    return { registered: false, code }
}

async function logout(id) {
    const session = sessions.get(id)
    if (!session) return false

    try {
        await session.sock.logout()
    } catch (e) {
        console.error("[AUTH] Logout failed:", e.message)
    }

    sessions.delete(id)
    await saveStatus(id, session.phone, "logged_out")

    const folder = path.join(SESSION_DIR, session.phone)

    if (fs.existsSync(folder)) {
        await fs.promises.rm(folder, { recursive: true, force: true })
    }

    return true
}

async function restoreSessions(){
    const started=Date.now()

    try{

        const rows=await all(`
            SELECT id,phone
            FROM sessions
            WHERE status!='logged_out'
        `)

        if(rows?.length){
            await Promise.all(
                rows.map(async row=>{
                    await createSession(row.id,row.phone)

                })
            )
        }


        return rows
    }catch(e){
        console.error(
            `[AUTH] Restore failed after ${Date.now()-started}ms:`,
            e.message
        )
        return []
    }
}

function setSessionEventEmitter(emitter) {
    sessionEventEmitter = emitter || null
    callEmitter=emitter||null
}

function setJwt(Sessjwt) {
    jwt = Sessjwt || null
}

function getSession(id){
    const session=sessions.get(id)
    return session
}

function getSessions() {
    return [...sessions.values()].map(session => ({
        id: session.id,
        phone: session.phone,
        status: session.status
    }))
}

function getPresence(id, jid) {
    if (!id || !jid) return "unavailable"

    const session = sessions.get(id) || sessions.get("default") || Array.from(sessions.values())[0]
    if (!session) return "unavailable"

    const target = normalizeContactJid(jid)
    const value = session.presence?.get(target)
    return String(value?.state || "unavailable").toLowerCase()
}

function isOnlinePresence(state) {
    return ["online", "available", "composing", "recording"].includes(
        String(state || "").toLowerCase()
    )
}

function requestPresence(id, jid) {
    if (!id || !jid) return

    const session = sessions.get(id) || sessions.get("default") || Array.from(sessions.values())[0]
    if (!session?.sock?.presenceSubscribe) return

    const target = normalizeContactJid(jid)
    if (!target || target.endsWith("@g.us") || target === "status@broadcast" || target.endsWith("@newsletter")) return

    const lastRequest = Number(session.presenceRequested?.get(target) || 0)
    if (Date.now() - lastRequest < 30000) return

    session.presenceRequested.set(target, Date.now())
    session.sock.presenceSubscribe(target).catch(() => {})
}

function normalizeContactJid(jid) {
    return String(jid || "")
        .trim()
        .replace(/:\d+(?=@)/, "")
}

function contactAddressMatches(contact, jid) {
    const target = normalizeContactJid(jid)
    if (!target || !contact) return false

    const targetPhone = target.split("@")[0]
    const aliases = [
        contact.id,
        contact.lid,
        contact.pn,
        contact.phoneNumber,
        contact.jid
    ].map(normalizeContactJid).filter(Boolean)

    return aliases.some(alias =>
        alias === target ||
        (targetPhone && alias.split("@")[0] === targetPhone)
    )
}

async function getContact(session,jid){
    if(!session||!jid)return null

    const phone=String(jid)
        .replace(/^@/,"")
        .replace(/\D/g,"")

    if(!phone)return null

    const contact=await get(`
        SELECT name,phone,email
        FROM contacts
        WHERE session=?
        AND REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','')=?
        LIMIT 1
    `,[session,phone])

    return contact||null
}

function isSavedContact(id, jid) {
    const contact = getContact(id, jid)
    if (!contact) return false
    return !!(contact.name || contact.verifiedName)
}

function getContacts(id) {
    const session = sessions.get(id)
    if (!session) return []

    return [...session.contacts.values()].filter(contact =>
        Boolean(contact.name || contact.verifiedName)
    )
}

module.exports = {
    createSession,
    pair,
    logout,
    restoreSessions,
    getSession,
    getSessions,
    setSessionEventEmitter,
    getContact,
    getContacts,
    isSavedContact,
    getPresence,
    isOnlinePresence,
    requestPresence,
    createQRSession,
    setJwt,
    emitCall
}