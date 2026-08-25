const fs=require("fs")
const path=require("path")
const{Boom}=require("@hapi/boom")
const pino=require("pino")
const{run,all}=require("./database")
const{refreshSessionAvatars}=require("./avatar-refresh")

let makeWASocket
let useMultiFileAuthState
let DisconnectReason
let Browsers
let fetchLatestWaWebVersion

async function loadBaileys(){
    if(makeWASocket)return
    const b=await import("@whiskeysockets/baileys")
    makeWASocket=b.default
    useMultiFileAuthState=b.useMultiFileAuthState
    DisconnectReason=b.DisconnectReason
    Browsers=b.Browsers
    fetchLatestWaWebVersion=b.fetchLatestWaWebVersion
}

const sessions=new Map()
const SESSION_DIR=path.resolve(
    process.env.SESSION_DIR||"./sessions"
)

fs.mkdirSync(SESSION_DIR,{recursive:true})

const logger=pino({
    level:process.env.LOG_LEVEL||"silent"
})

async function saveStatus(id,phone,status){
    try{
        await run(`
            INSERT INTO sessions
            (id,phone,status)
            VALUES(?,?,?)
            ON CONFLICT(id)
            DO UPDATE SET
                phone=excluded.phone,
                status=excluded.status,
                updated_at=unixepoch()
        `,[id,phone,status])
    }catch(e){
        console.error("[DB]",e.message)
    }
}



async function createSession(id,phone=""){
    await loadBaileys()

    if(sessions.has(id))
        return sessions.get(id)

    const folder=path.join(
        SESSION_DIR,
        id
    )

    fs.mkdirSync(
        folder,
        {recursive:true}
    )

    let auth

    try{
        auth=await useMultiFileAuthState(
            folder
        )
    }catch(e){
        console.error(
            "[AUTH] Load failed:",
            e.message
        )
        throw e
    }

    const{
        state,
        saveCreds
    }=auth

    let version

    try{
        const latest=
            await fetchLatestWaWebVersion()

        if(latest?.version)
            version=latest.version
    }catch(e){
        console.error(
            "[WA] Version fetch failed:",
            e.message
        )
    }

    let sock

    try{
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
        console.error(
            "[WA] Socket failed:",
            e.message
        )
        throw e
    }

    const session={
        id,
        phone,
        sock,
        status:"connecting",
        contacts:new Map()
    }

    sessions.set(
        id,
        session
    )

    await saveStatus(
        id,
        phone,
        "connecting"
    )

    sock.ev.on(
        "creds.update",
        async creds=>{
            try{
                await saveCreds(creds)
            }catch(e){
                console.error(
                    "[AUTH] Save failed:",
                    e.message
                )
            }
        }
    )

    sock.ev.on(
        "messaging-history.set",
        ({contacts})=>{
            if(!contacts)
                return

            for(const contact of contacts){
                if(!contact?.id)
                    continue

                const old=
                    session.contacts.get(
                        contact.id
                    )||{}

                session.contacts.set(
                    contact.id,
                    {
                        ...old,
                        ...contact
                    }
                )
            }
        }
    )

    sock.ev.on(
        "contacts.set",
        ({contacts})=>{
            if(!contacts)
                return

            for(const contact of contacts){
                if(!contact?.id)
                    continue

                const old=
                    session.contacts.get(
                        contact.id
                    )||{}

                session.contacts.set(
                    contact.id,
                    {
                        ...old,
                        ...contact
                    }
                )
            }
        }
    )

    sock.ev.on(
        "contacts.upsert",
        items=>{
            for(const contact of items){
                if(!contact?.id)
                    continue

                const old=
                    session.contacts.get(
                        contact.id
                    )||{}

                session.contacts.set(
                    contact.id,
                    {
                        ...old,
                        ...contact
                    }
                )
            }
        }
    )

    sock.ev.on(
        "contacts.update",
        items=>{
            for(const contact of items){
                if(!contact?.id)
                    continue

                const old=
                    session.contacts.get(
                        contact.id
                    )||{}

                session.contacts.set(
                    contact.id,
                    {
                        ...old,
                        ...contact
                    }
                )
            }
        }
    )

    sock.ev.on(
        "connection.update",
        async update=>{
            const{
                connection,
                lastDisconnect
            }=update

            if(connection==="connecting"){
                session.status="connecting"

                await saveStatus(
                    id,
                    phone,
                    "connecting"
                )
            }

            if(connection==="open"){
                session.status="connected"

                await saveStatus(
                    id,
                    phone,
                    "connected"
                )

                console.log(
                    `[WA] Connected: ${id}`
                )

                refreshSessionAvatars(session)
                    .then(count=>{
                        console.log(
                            `[AVATAR] Refreshed ${count} conversation avatar(s) for ${id}`
                        )
                    })
                    .catch(error=>{
                        console.error(
                            `[AVATAR] Session refresh failed: ${id}`,
                            error.message
                        )
                    })
            }

            if(connection!=="close")
                return

            let code

            try{
                code=new Boom(
                    lastDisconnect?.error
                ).output.statusCode
            }catch{
                code=undefined
            }

            session.status="disconnected"

            await saveStatus(
                id,
                phone,
                "disconnected"
            )

            console.error(
                `[WA] Disconnected: ${id} (${code||"unknown"})`
            )

            if(
                lastDisconnect?.error?.message
            ){
                console.error(
                    `[WA] ${lastDisconnect.error.message}`
                )
            }

            if(
                code===DisconnectReason.loggedOut||
                code===DisconnectReason.badSession
            ){
                sessions.delete(id)

                console.error(
                    `[WA] Session invalid: ${id}`
                )

                return
            }

            if(
                code===DisconnectReason.connectionReplaced
            ){
                sessions.delete(id)

                console.error(
                    `[WA] Session replaced: ${id}`
                )

                return
            }

            const reconnectable=[
                DisconnectReason.connectionClosed,
                DisconnectReason.connectionLost,
                DisconnectReason.timedOut,
                DisconnectReason.restartRequired
            ]

            if(
                !reconnectable.includes(code)
            ){
                sessions.delete(id)

                console.error(
                    `[WA] Not reconnecting: ${id}`
                )

                return
            }

            sessions.delete(id)

            console.log(
                `[WA] Reconnecting: ${id}`
            )

            setTimeout(()=>{
                createSession(
                    id,
                    phone
                ).catch(e=>{
                    console.error(
                        `[WA] Reconnect failed: ${id}`,
                        e.message
                    )
                })
            },5000)
        }
    )

    sock.ev.on(
        "messages.upsert",
        async event=>{
            for(const message of event.messages){
                try{
                    await require(
                        "./bot"
                    ).handleMessage(
                        session,
                        message
                    )
                }catch(e){
                    console.error(
                        "[MSG] Processing failed:",
                        e.message
                    )
                }
            }
        }
    )

    

    return session
}

async function pair(id,phone){
    phone=String(phone)
        .replace(/\D/g,"")

    if(!phone)
        throw new Error(
            "Invalid phone number"
        )

    const session=
        await createSession(
            id,
            phone
        )

    const registered=
        session.sock.authState
            ?.creds
            ?.registered

    if(registered){
        return{
            registered:true,
            code:null
        }
    }

    if(
        session.sock.ws?.readyState!==1
    ){
        await new Promise(
            resolve=>setTimeout(
                resolve,
                3000
            )
        )
    }

    const code=
        await session.sock
            .requestPairingCode(
                phone
            )

    console.log(
        `[PAIR] Code generated for ${id}`
    )

    return{
        registered:false,
        code
    }
}

async function logout(id){
    const session=
        sessions.get(id)

    if(!session)
        return false

    try{
        await session.sock.logout()
    }catch(e){
        console.error(
            "[AUTH] Logout failed:",
            e.message
        )
    }

    sessions.delete(id)

    await saveStatus(
        id,
        session.phone,
        "logged_out"
    )

    console.log(
        `[AUTH] Logged out: ${id}`
    )

    return true
}

async function restoreSessions(){
    try{
        const rows=await all(`
            SELECT id,phone
            FROM sessions
            WHERE status!='logged_out'
        `)

        console.log(
            `[AUTH] Restoring ${rows.length} session(s)`
        )

        for(const row of rows){
            const folder=
                path.join(
                    SESSION_DIR,
                    row.id
                )

            if(!fs.existsSync(folder))
                continue

            createSession(
                row.id,
                row.phone
            ).catch(e=>{
                console.error(
                    `[AUTH] Restore failed: ${row.id}`,
                    e.message
                )
            })
        }
    }catch(e){
        console.error(
            "[AUTH] Restore failed:",
            e.message
        )
    }
}

function getSession(id){
    return sessions.get(id)
}

function getSessions(){

    return[
        ...sessions.values()
    ].map(session=>({
        id:session.id,
        phone:session.phone,
        status:session.status
    }))
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

function getContact(id, jid) {
    if (!id || !jid) return null

    const session = sessions.get(id) || sessions.get("default") || Array.from(sessions.values())[0]
    if (!session) return null

    const target = normalizeContactJid(jid)
    const phone = target.split("@")[0]
    const contacts = session.contacts
    const values = contacts instanceof Map
        ? Array.from(contacts.values())
        : Object.values(contacts || {})

    const direct = contacts instanceof Map
        ? contacts.get(jid) || contacts.get(target) || contacts.get(`${phone}@s.whatsapp.net`)
        : contacts?.[jid] || contacts?.[target] || contacts?.[`${phone}@s.whatsapp.net`]

    if (direct?.name || direct?.verifiedName)
        return direct

    return values.find(contact =>
        (contact?.name || contact?.verifiedName) &&
        contactAddressMatches(contact, jid)
    ) || null
}

function isSavedContact(id,jid){
    const contact=
        getContact(id,jid)

    if(!contact)
        return false

    return!!(
        contact.name||
        contact.verifiedName
    )
}

function getContacts(id){
    const session=
        sessions.get(id)

    if(!session)
        return[]

    return[
        ...session.contacts.values()
    ].filter(contact=>
        Boolean(contact.name||contact.verifiedName)
    )
}



module.exports={
    createSession,
    pair,
    logout,
    restoreSessions,
    getSession,
    getSessions,
    getContact,
    getContacts,
    isSavedContact
}