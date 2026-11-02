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
const MEDIA_DIR=path.join(__dirname,"uploads")

async function loadBaileys() {
    if (makeWASocket) return
    const b = await import("@whiskeysockets/baileys")
    makeWASocket = b.default
    useMultiFileAuthState = b.useMultiFileAuthState
    DisconnectReason = b.DisconnectReason
    Browsers = b.Browsers
    fetchLatestWaWebVersion = b.fetchLatestWaWebVersion
}

async function getFavoriteStickers(session){
    const found=[]

    async function walk(dir){
        for(const item of await fs.promises.readdir(dir,{withFileTypes:true})){
            const file=path.join(dir,item.name)

            if(item.isDirectory())await walk(file)
            else{
                const hash=crypto.createHash("sha256").update(await fs.promises.readFile(file)).digest("hex")

                if(session.favoriteStickerHashes?.has(hash))found.push(file)
            }
        }
    }

    await walk(MEDIA_DIR)
    return found
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

async function subscribePresence(session,jid){
    if(!session?.sock||!jid)return

    jid=String(jid).trim()

    if(
        jid==="status@broadcast"||
        jid.endsWith("@g.us")||
        jid.endsWith("@newsletter")
    )return

    try{
        await session.sock.presenceSubscribe(jid)
    }catch(error){
        console.error(`[PRESENCE] Subscribe failed: ${session.id} ${jid}`,error.message)
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
    await state.keys.set({
        "app-state-sync-version":{
            regular_low:null
        }
    })

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


async function emitMessageStatus(key, status) {
    if (!key?.id || !key?.fromMe) return;

    const statusMap = {
        0: "failed",
        1: "pending",
        2: "sent",
        3: "delivered",
        4: "read",
        5: "played"
    };

    const normalizedStatus = typeof status === "number"
        ? statusMap[status]
        : String(status || "").toLowerCase();

    if (!normalizedStatus) return;

    try {
        const rows = await all(
            `SELECT id, conversation_key FROM messages
             WHERE session_id=? AND msg_id=? AND from_me=1
             LIMIT 1`,
            [session.id, key.id]
        );

        if (!rows?.length) return;

        const message = rows[0];

        await run(
            `UPDATE messages SET status=?
             WHERE id=? AND session_id=?`,
            [normalizedStatus, message.id, session.id]
        );

        sessionEventEmitter?.emit("message-status", {
            id: message.id,
            msg_id: key.id,
            session_id: session.id,
            conversation_key: message.conversation_key,
            status: normalizedStatus
        });

        sessionEventEmitter?.emit("conversation-status", {
            session_id: session.id,
            conversation_key: message.conversation_key,
            msg_id: key.id,
            status: normalizedStatus
        });
    } catch (error) {
        console.error("[STATUS] Update failed:", error.message);
    }
}
    await saveStatus(id,phone,"connecting")

    sock.ev.on("messages.update", async updates => {
        for (const { key, update } of updates) {
            if (update?.status === undefined || update?.status === null) continue;
    
            await emitMessageStatus(key, update.status);
        }
    });
    
    sock.ev.on("message-receipt.update", async updates => {
        for (const { key, receipt } of updates) {
            if (!receipt) continue;
    
            let status = null;
    
            if (receipt.playedTimestamp) {
                status = "played";
            } else if (receipt.readTimestamp) {
                status = "read";
            } else if (receipt.receiptTimestamp || receipt.timestamp) {
                status = "delivered";
            }
    
            if (status) {
                await emitMessageStatus(key, status);
            }
        }
    });
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

    sock.ev.on("presence.update",async({id,presences})=>{
        if(!id||!presences)return
    
        const conversationJid=String(id).trim()
    
        const conversationKey=conversationJid.endsWith("@g.us")
            ?`${session.id}:group:${conversationJid}`
            :conversationJid==="status@broadcast"
                ?`${session.id}:status:${conversationJid}`
                :`${session.id}:${conversationJid}:${session.id}`
    
        for(const [jid,presence] of Object.entries(presences)){
            try{
                const state=String(presence?.lastKnownPresence||"").toLowerCase()
    
                let resolvedJid=jid
    
                if(jid.endsWith("@lid")){
                    try{
                        resolvedJid=await withTimeout(
                            sock.signalRepository.lidMapping.getPNForLID(jid)
                        )||jid
                    }catch{}
                }
    
                let phoneNumber=null
    
                if(resolvedJid.endsWith("@s.whatsapp.net")){
                    phoneNumber=resolvedJid
                        .split("@")[0]
                        .split(":")[0]
                        .replace(/\D/g,"")
                }
    
                let contact={}
    
                try{
                    contact=await getContact(session.id,resolvedJid)||{}
                }catch{}
    
                const waContact=
                    session.contacts.get(jid)||
                    session.contacts.get(resolvedJid)||{}
    
                let pushName=
                    contact.pushName||
                    contact.notify||
                    contact.name||
                    waContact.pushName||
                    waContact.notify||
                    waContact.name||
                    null
    
                if(!pushName){
                    try{
                        const rows=await all(`
                            SELECT push_name,sender_name
                            FROM messages
                            WHERE session_id=?
                            AND from_me=0
                            AND sender IN (?,?)
                            AND (
                                COALESCE(push_name,'')!=''
                                OR COALESCE(sender_name,'')!=''
                            )
                            ORDER BY id DESC
                            LIMIT 1
                        `,[session.id,jid,resolvedJid])
    
                        pushName=
                            rows[0]?.push_name||
                            rows[0]?.sender_name||
                            null
                    }catch(error){
                        console.error("[PRESENCE NAME]",error.message)
                    }
                }

                let displayAvatar=
                    contact.avatar||
                    contact.profilePicture||
                    waContact.avatar||
                    waContact.imgUrl||
                    waContact.profilePicture||
                    ""

                if(!displayAvatar){
                    try{
                        const rows=await all(`
                            SELECT sender_avatar,avatar
                            FROM messages
                            WHERE session_id=?
                            AND from_me=0
                            AND sender IN (?,?)
                            ORDER BY id DESC
                            LIMIT 1
                        `,[session.id,jid,resolvedJid])
                        
                        let displayAvatar=
                            rows[0]?.sender_avatar||
                            rows[0]?.avatar||
                            ""
                        
                        if(!displayAvatar){
                            try{
                                displayAvatar=await sock.profilePictureUrl(resolvedJid,"image")||""
                            }catch{}
                        }
                    }catch(error){
                        console.error("[PRESENCE AVATAR]",error.message)
                    }
                }
    
                const displayName=pushName||phoneNumber||"Someone"
    
                sessionEventEmitter?.emit("presence",{
                    phone:session.id,
                    session_id:session.id,
    
                    jid,
                    resolved_jid:resolvedJid,
                    phone_number:phoneNumber,
    
                    avatar:displayAvatar,
                    name:displayName,
                    push_name:pushName,
                    notify:contact.notify||waContact.notify||null,
                    verified_name:contact.verifiedName||waContact.verifiedName||null,
                    short_name:contact.shortName||waContact.shortName||null,
                    business_name:contact.businessName||waContact.businessName||null,
                    contact,
    
                    conversation_jid:conversationJid,
                    conversation_key:conversationKey,
    
                    presence:state,
                    online:["available","composing","recording"].includes(state),
                    typing:state==="composing",
                    recording:state==="recording"
                })
            }catch(error){
                console.error("[PRESENCE]",jid,error.message)
            }
        }
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

            if(!session.stickerSyncStarted){
                session.stickerSyncStarted=true
            
            
                if(typeof sock.resyncAppState==="function"){
                    sock.resyncAppState(["regular_low"],true)
                        .then(()=>{
                        })
                        .catch(error=>{
                            console.error(`[STICKER] Sync failed: ${id}`,error)
                        })
                }
            }

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
    
    const favoritesDir=path.join(MEDIA_DIR,"stickers","favorites")
    fs.mkdirSync(favoritesDir,{recursive:true})
    
    sock.ev.on("sticker.update",async({sticker})=>{
        try{
            if(!sticker?.isFavorite)return
    
            const message={
                key:{
                    id:Buffer.from(sticker.fileEncSha256).toString("hex")
                },
                message:{
                    stickerMessage:{
                        url:sticker.url,
                        directPath:sticker.directPath,
                        mediaKey:sticker.mediaKey,
                        fileEncSha256:sticker.fileEncSha256,
                        mimetype:sticker.mimetype,
                        fileLength:sticker.fileLength,
                        height:sticker.height,
                        width:sticker.width,
                        isAnimated:sticker.isLottie
                    }
                }
            }

            const {saveMedia} = require('./bot')
    
            const saved=await saveMedia(
                sock,
                message,
                "sticker",
                favoritesDir,
                "favorite"
            )
    
            if(saved){
            }
        }catch(error){
            console.error("[STICKER] Favourite save failed:",error.message)
        }
    })

    let stickerSyncStarted=false

sock.ev.on("connection.update",({connection})=>{
    if(connection==="open"&&!stickerSyncStarted){
        stickerSyncStarted=true


        sock.resyncAppState(["regular_low"],true)
            .then(()=>console.log("[STICKER] App state sync completed"))
            .catch(e=>console.error("[STICKER] Sync failed:",e.message))
    }
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
                batch.map(async message=>{
                    if(!isHistory){
                        const jid=String(
                            message.key?.remoteJid||""
                        ).trim()
    
                        if(
                            jid&&
                            !jid.endsWith("@g.us")&&
                            !jid.endsWith("@newsletter")&&
                            jid!=="status@broadcast"
                        ){
                            subscribePresence(session,jid)
                        }
                    }
    
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
            SELECT id,phone,created_at
            FROM sessions
            WHERE status!='logged_out'
        `)

        const valid=[]

        for(const row of rows||[]){
            if(!row.phone&&Date.now()-new Date(row.created_at).getTime()>60000){
                await run("DELETE FROM sessions WHERE id=?",[row.id])
                continue
            }

            valid.push(row)
        }

        await Promise.all(
            valid.map(row=>createSession(row.id,row.phone))
        )

        return valid
    }catch(e){
        console.error(`[AUTH] Restore failed after ${Date.now()-started}ms:`,e.message)
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
    emitCall,
    getFavoriteStickers
}