const {getCommand}=require("./commands")
const { recordMessage }=require("./messages")
const {getProfilePictureUrl}=require("./avatars")
const {inspect}=require("util")
const {downloadMediaMessage}=require("@whiskeysockets/baileys")
const {getSession } = require('./sessions')
const fs=require("fs")
const path=require("path")
const {spawn}=require("child_process")
const sharp=require("sharp")
const {all, run}=require("./database")
const LOG_FILE=path.join(__dirname,"bot_debug.log")
const logStream=fs.createWriteStream(LOG_FILE,{flags:"a"})
let pendingClientIds=new Map()

function setPendingIds(ids){
    pendingClientIds.clear()
    for(const[id,value] of ids)pendingClientIds.set(id,value)
}

function writeLogToFile(level,args){
    const timestamp=new Date().toISOString()
    const formattedArgs=args.map(arg=>{
        if(typeof arg==="string")return arg
        if(arg instanceof Error)return arg.stack||arg.message
        try{return JSON.stringify(arg)}catch{return inspect(arg,{depth:4})}
    }).join(" ")
    logStream.write(`[${timestamp}] [${level.toUpperCase()}] ${formattedArgs}\n`)
}

const originalLog=console.log
const originalError=console.error
const originalWarn=console.warn
const originalInfo=console.info

console.log=(...args)=>{
    writeLogToFile("info",args)
    originalLog.apply(console,args)
}
console.error=(...args)=>{
    writeLogToFile("error",args)
    originalError.apply(console,args)
}
console.warn=(...args)=>{
    writeLogToFile("warn",args)
    originalWarn.apply(console,args)
}
console.info=(...args)=>{
    writeLogToFile("info",args)
    originalInfo.apply(console,args)
}


const PREFIX=process.env.PREFIX||"."
const groupCache=new Map()
const channelCache=new Map()
const commandInFlight=new Set()
const commandCompleted=new Map()
const COMMAND_DEDUPE_TTL=10*60*1000

const MEDIA_DIR=path.join(__dirname,"uploads")
const IMAGE_DIR=path.join(MEDIA_DIR,"images")
const VIDEO_DIR=path.join(MEDIA_DIR,"videos")
const AUDIO_DIR=path.join(MEDIA_DIR,"audio")
const DOC_DIR=path.join(MEDIA_DIR,"documents")
const STICKER_DIR=path.join(MEDIA_DIR,"stickers")
const STATUS_DIR=path.join(MEDIA_DIR,"statuses")
const VIEW_ONCE_DIR=path.join(MEDIA_DIR,"viewonce")

for(const d of[IMAGE_DIR,VIDEO_DIR,AUDIO_DIR,DOC_DIR,STICKER_DIR,STATUS_DIR,VIEW_ONCE_DIR])
    fs.mkdirSync(d,{recursive:true})

function normalizeJid(jid){
    return jid?String(jid).replace(/:\d+@/,"@"):""
}

function getOwnerJid(sock){
    const id=sock?.user?.id
    return id?id.split(":")[0]+"@s.whatsapp.net":""
}

function unwrapMessage(message){
    let c=message?.message
    let depth=0
    while(c&&depth<10){
        depth++
        if(c.ephemeralMessage?.message)c=c.ephemeralMessage.message
        else if(c.viewOnceMessage?.message)c=c.viewOnceMessage.message
        else if(c.viewOnceMessageV2?.message)c=c.viewOnceMessageV2.message
        else if(c.viewOnceMessageV2Extension?.message)c=c.viewOnceMessageV2Extension.message
        else break
    }
    return c||null
}

function isViewOnceMessage(message){
    if(message?.key?.isViewOnce)return true
    let c=message?.message
    let depth=0
    while(c&&depth<10){
        depth++
        if(c.viewOnceMessage?.message||c.viewOnceMessageV2?.message||c.viewOnceMessageV2Extension?.message)return true
        if(c.ephemeralMessage?.message)c=c.ephemeralMessage.message
        else break
    }
    return false
}

function isStatusMessage(message){
    const key=message?.key||{}
    return key.remoteJid==="status@broadcast"||
        key.remoteJidAlt==="status@broadcast"||
        key.participant==="status@broadcast"||
        key.participantAlt==="status@broadcast"
}

function getMediaInfo(message) {

    const m = message?.message || message || {}

    if (m.imageMessage) {
        return {
            type: "image",
            mimetype: m.imageMessage.mimetype || "image/jpeg",
            fileName: "",
            size: Number(m.imageMessage.fileLength || 0)
        }
    }

    if (m.videoMessage) {
        return {
            type: "video",
            mimetype: m.videoMessage.mimetype || "video/mp4",
            fileName: "",
            size: Number(m.videoMessage.fileLength || 0)
        }
    }

    if (m.audioMessage) {
        return {
            type: "audio",
            mimetype: m.audioMessage.mimetype || "audio/ogg",
            fileName: "",
            size: Number(m.audioMessage.fileLength || 0)
        }
    }

    if (m.documentMessage) {
        return {
            type: "document",
            mimetype: m.documentMessage.mimetype || "application/octet-stream",
            fileName: m.documentMessage.fileName || "",
            size: Number(m.documentMessage.fileLength || 0)
        }
    }

    if (m.stickerMessage) {
        return {
            type: "sticker",
            mimetype: m.stickerMessage.mimetype || "image/webp",
            fileName: "",
            size: Number(m.stickerMessage.fileLength || 0)
        }
    }

    return {
        type: "",
        mimetype: "",
        fileName: "",
        size: 0
    }
}

function getMessageContent(message){
    return unwrapMessage(message)
}

function getText(message){
    const c=unwrapMessage(message)
    if(!c)return ""
    return c.conversation||
        c.extendedTextMessage?.text||
        c.imageMessage?.caption||
        c.videoMessage?.caption||
        c.documentMessage?.caption||
        c.audioMessage?.caption||
        c.buttonsResponseMessage?.selectedButtonId||
        c.buttonsResponseMessage?.selectedDisplayText||
        c.templateButtonReplyMessage?.selectedId||
        c.templateButtonReplyMessage?.selectedDisplayText||
        c.listResponseMessage?.singleSelectReply?.selectedRowId||
        c.listResponseMessage?.title||
        ""
}

function getMessageText(message){
    if(!message)return ""
    return message.conversation||
        message.extendedTextMessage?.text||
        message.imageMessage?.caption||
        message.videoMessage?.caption||
        message.documentMessage?.caption||
        message.audioMessage?.caption||
        message.buttonsResponseMessage?.selectedDisplayText||
        message.listResponseMessage?.title||
        message.templateButtonReplyMessage?.selectedDisplayText||
        ""
}

function normalizePhone(phone){
    let p=String(phone||"").replace(/\D/g,"")
    if(p.startsWith("254"))return p
    if(p.startsWith("0"))return"254"+p.slice(1)
    return p
}

function clean(value){
    return value==null?"":String(value).trim()
}

function validSenderName(name){
    if(!name)return false
    name=String(name).trim()
    return name.length>=1&&name.length<=80
}

function cleanSenderName(name,fallback=""){
    if(validSenderName(name))return String(name).trim()
    if(validSenderName(fallback))return String(fallback).trim()
    return ""
}

function unsavedName(name){
    name=clean(name)
    if(!name)return ""
    return name.startsWith("~")?name:`~${name}`
}
async function getStoredContact(jid,sessionId){


    if(!jid||!sessionId)
        return null

    let phone=String(jid)
        .split("@")[0]
        .split(":")[0]

    phone=phone.replace(/\D/g,"")

    let alternate=phone

    if(phone.startsWith("254")){

        alternate="0"+phone.slice(3)

    }else if(phone.startsWith("0")){

        alternate="254"+phone.slice(1)

    }


    const rows=await all(`
        SELECT *
        FROM contacts
        WHERE session=?
        AND (
            REPLACE(phone,'+','')=?
            OR REPLACE(phone,'+','')=?
        )
        LIMIT 1
    `,[
        sessionId,
        phone,
        alternate
    ])


    return rows[0]||null
}

async function updateAbout(sock,sessionId,jid) {
    try {
        if(!sock||!sessionId||!jid||jid==="status@broadcast"||jid.endsWith("@g.us")||jid.endsWith("@newsletter"))return
        const result=await sock.fetchStatus(jid)
        const about=typeof result?.status==="string"?result.status:""
        await run(`
            INSERT INTO abouts (session_id,jid,about,updated_at)
            VALUES (?,?,?,strftime('%s','now'))
            ON CONFLICT(session_id,jid)
            DO UPDATE SET about=excluded.about,updated_at=excluded.updated_at
        `,[sessionId,jid,about])
        return about
    }catch(err){
        console.error("[ABOUT]",err.message)
        return ""
    }
}

async function getSavedContactName(session,jid){

    if(!jid)
        return ""

    let target=normalizeJid(jid)

    if(target.endsWith("@lid")){

        try{

            const mapping=session?.sock?.signalRepository?.lidMapping

            if(mapping&&typeof mapping.getPNForLID==="function"){
                target=await mapping.getPNForLID(target)||""
            }

        }catch(e){

            console.warn(
                "[CONTACT] LID resolution failed:",
                target,
                e.message
            )

        }

    }

    if(!target)
        return ""

    const contact=await getStoredContact(
        target,
        session.id
    )

    return clean(contact?.name)
}

async function getContact(session,jid){
    if(!jid)return null

    const sock=session?.sock
    const normalized=normalizeJid(jid)

    if(normalized.endsWith("@lid")){
        try{
            const lidMapping=sock?.signalRepository?.lidMapping

            if(lidMapping&&typeof lidMapping.getPNForLID==="function"){
                const phoneJid=await lidMapping.getPNForLID(normalized)

                if(phoneJid){
                    const stored=await getStoredContact(phoneJid)
                    if(stored)return stored
                }
            }
        }catch(e){
            console.warn("[CONTACT] LID resolution failed:",normalized,e.message)
        }
    }

    if(!normalized.endsWith("@lid")){
        const stored=await getStoredContact(normalized)
        if(stored)return stored
    }

    const contacts=
        session?.contacts||
        session?.store?.contacts||
        sock?.store?.contacts||
        sock?.contacts||
        {}

    if(contacts instanceof Map){
        return contacts.get(jid)||
            contacts.get(normalized)||
            Array.from(contacts.values()).find(c=>
                c?.id===jid||
                c?.id===normalized||
                c?.lid===jid||
                c?.lid===normalized||
                c?.pn===jid||
                c?.pn===normalized
            )||null
    }

    return contacts[jid]||
        contacts[normalized]||
        Object.values(contacts).find(c=>
            c?.id===jid||
            c?.id===normalized||
            c?.lid===jid||
            c?.lid===normalized||
            c?.pn===jid||
            c?.pn===normalized
        )||null
}

async function getSavedContactName(session,jid){



    if(!jid)
        return ""

    let target=normalizeJid(jid)



    if(target.endsWith("@lid")){

        try{

            const mapping=session?.sock?.signalRepository?.lidMapping



            if(mapping&&typeof mapping.getPNForLID==="function"){

                const resolved=await mapping.getPNForLID(target)



                target=resolved||""
            }

        }catch(e){

            console.error(
                "[NAME] LID RESOLUTION FAILED",
                target,
                e.message
            )

        }

    }

    if(!target){
        return ""
    }

    const contact=await getStoredContact(
        target,
        session.id
    )


    return clean(contact?.name)
}
function findContact(session,query){
    if(!query)return null

    const rawContacts=
        session?.contacts||
        session?.store?.contacts||
        session?.sock?.store?.contacts||
        session?.sock?.contacts||
        {}

    const contactsList=
        rawContacts instanceof Map
            ?Array.from(rawContacts.values())
            :Object.values(rawContacts)

    const q=String(query).trim().toLowerCase()
    const cleanPhone=q.replace(/[^0-9]/g,"")

    return contactsList.find(c=>{
        if(!c||(!c.name&&!c.verifiedName))return false

        const cId=c.id?String(c.id).toLowerCase():""
        const cPhone=c.phoneNumber?String(c.phoneNumber):""
        const cName=c.name?String(c.name).toLowerCase():""
        const cVerified=c.verifiedName?String(c.verifiedName).toLowerCase():""

        return cId===q||
            (cleanPhone&&cPhone&&cPhone.includes(cleanPhone))||
            cName.includes(q)||
            cVerified.includes(q)
    })||null
}

function searchContacts(session,query=""){
    const rawContacts=
        session?.contacts||
        session?.store?.contacts||
        session?.sock?.store?.contacts||
        session?.sock?.contacts||
        {}

    const contactsList=
        rawContacts instanceof Map
            ?Array.from(rawContacts.values())
            :Object.values(rawContacts)

    const savedContacts=contactsList.filter(c=>Boolean(c?.name||c?.verifiedName))
    if(!query)return savedContacts

    const q=String(query).trim().toLowerCase()
    const cleanPhone=q.replace(/[^0-9]/g,"")

    return savedContacts.filter(c=>{
        const cId=c.id?String(c.id).toLowerCase():""
        const cPhone=c.phoneNumber?String(c.phoneNumber):""
        const cName=c.name?String(c.name).toLowerCase():""
        const cVerified=c.verifiedName?String(c.verifiedName).toLowerCase():""

        return cId.includes(q)||
            (cleanPhone&&cPhone.includes(cleanPhone))||
            cName.includes(q)||
            cVerified.includes(q)
    })
}


async function getGroupMetadata(sock,jid){
    if(!sock||!jid?.endsWith("@g.us"))return ""

    const cached=groupCache.get(jid)

    if(cached&&Date.now()-cached.timestamp<30*60*1000)
        return cached.name

    try{
        const metadata=await sock.groupMetadata(jid)
        const name=metadata?.subject||""

        groupCache.set(jid,{
            name,
            timestamp:Date.now()
        })

        return name
    }catch{
        return ""
    }
}

function parseNewsletterMeta(meta){
    if(!meta||typeof meta!=="object")
        return{name:"",icon:""}

    const text=v=>{
        if(!v)return ""
        if(typeof v==="string")return v.trim()
        if(typeof v?.text==="string")return v.text.trim()
        return ""
    }

    const name=
        text(meta.name)||
        text(meta.thread_metadata?.name)||
        text(meta.subject)

    let icon=""

    if(typeof meta.picture==="string")
        icon=meta.picture
    else if(typeof meta.picture?.url==="string")
        icon=meta.picture.url
    else if(typeof meta.thread_metadata?.picture?.url==="string")
        icon=meta.thread_metadata.picture.url
    else if(typeof meta.preview==="string")
        icon=meta.preview

    return{name,icon}
}

async function getChannelMetadata(sock,jid){
    if(!sock||!jid?.endsWith("@newsletter"))
        return{name:"",icon:""}

    const cached=channelCache.get(jid)

    if(cached&&Date.now()-cached.timestamp<30*60*1000)
        return cached

    try{
        if(typeof sock.newsletterMetadata!=="function")
            return{name:"",icon:""}

        const meta=await sock.newsletterMetadata("jid",jid)
        const result=parseNewsletterMeta(meta)

        if(result.name){
            channelCache.set(jid,{
                ...result,
                timestamp:Date.now()
            })
        }

        return result
    }catch{
        return{name:"",icon:""}
    }
}

async function deleteCommand(sock,message){
    if(!sock?.sendMessage||!message?.key)return
}

async function executeCommand(session,message,jid,sender,text){
    const body=text.slice(PREFIX.length).trim()
    if(!body)return false

    const parts=body.split(/\s+/)
    const name=parts.shift()?.toLowerCase()
    const command=getCommand?.(name)

    if(!command)return false

    const messageId=message?.key?.id
    const requestKey=`${session?.id||"default"}:${jid}:${messageId||"no-id"}:${name}`
    const completedAt=commandCompleted.get(requestKey)

    if(
        commandInFlight.has(requestKey)||
        (completedAt&&Date.now()-completedAt<COMMAND_DEDUPE_TTL)
    ){
        console.warn(`[CMD] Duplicate command suppressed: ${requestKey}`)
        return false
    }

    if(completedAt)commandCompleted.delete(requestKey)
    commandInFlight.add(requestKey)

    try{
        await command.execute({
            sock:session.sock,
            session,
            message,
            jid,
            sender,
            text,
            args:parts,
            isGroup:jid.endsWith("@g.us"),
            command:name,
            getProfilePictureUrl,
            getSavedContactName:targetJid=>getSavedContactName(session,targetJid)
        })
        return true
    }finally{
        commandInFlight.delete(requestKey)
        commandCompleted.set(requestKey,Date.now())
    }
}

async function downloadMedia(session,message){
    try{
        const content=unwrapMessage(message)
        if(!content)return null

        const media=
            content.imageMessage||
            content.videoMessage||
            content.audioMessage||
            content.documentMessage||
            content.stickerMessage

        if(!media)return null

        if(!media.mediaKey){
            console.log("[MEDIA] No media key:",message.key?.remoteJid,message.key?.id)
            return null
        }

        const buffer=await downloadMediaMessage(
            {
                key:message.key,
                message:content
            },
            "buffer",
            {},
            {
                logger:console,
                reuploadRequest:session.sock.updateMediaMessage
            }
        )

        if(!buffer?.length)return null

        return{buffer,media,content}
    }catch(e){
        console.error("[MEDIA]",e.message)
        return null
    }
}

async function compressImage(buffer,file){
    await sharp(buffer)
        .rotate()
        .resize({
            width:1280,
            height:1280,
            fit:"inside",
            withoutEnlargement:true
        })
        .jpeg({
            quality:78,
            progressive:true,
            mozjpeg:true
        })
        .toFile(file)
}

async function compressVideo(buffer,file){
    return new Promise((resolve,reject)=>{
        const ffmpeg=spawn("ffmpeg",[
            "-hide_banner",
            "-loglevel","error",
            "-i","pipe:0",
            "-vf","scale=trunc(min(iw\\,1280)/2)*2:trunc(min(ih\\,1280)/2)*2:force_original_aspect_ratio=decrease",
            "-c:v","libx264",
            "-preset","veryfast",
            "-crf","27",
            "-c:a","aac",
            "-b:a","96k",
            "-movflags","+faststart",
            "-y",file
        ])

        let error=""

        ffmpeg.stderr.on("data",data=>{
            error+=data.toString()
        })

        ffmpeg.on("error",reject)

        ffmpeg.on("close",code=>{
            if(code===0)resolve(file)
            else reject(new Error(error||`ffmpeg exited with code ${code}`))
        })

        ffmpeg.stdin.end(buffer)
    })
}
async function compressAudio(buffer,file){
    return new Promise((resolve,reject)=>{
        const ffmpeg=spawn("ffmpeg",[
            "-hide_banner",
            "-loglevel","error",
            "-i","pipe:0",
            "-c:a","aac",
            "-b:a","96k",
            "-ar","44100",
            "-ac","2",
            "-y",file
        ])

        let error=""

        ffmpeg.stderr.on("data",d=>error+=d.toString())
        ffmpeg.on("error",reject)

        ffmpeg.on("close",code=>{
            if(code===0)resolve(file)
            else reject(new Error(error||`FFmpeg exited with ${code}`))
        })

        ffmpeg.stdin.on("error",()=>{})
        ffmpeg.stdin.write(buffer,()=>ffmpeg.stdin.end())
    })
}

async function saveMedia(session,message,type,directory,prefix){
    try{
        const result=await downloadMedia(session, message)
        if(!result)return ""
        const{buffer,media}=result
        fs.mkdirSync(directory,{recursive:true})
        const id=message.key?.id||
            `${Date.now()}_${Math.random().toString(36).slice(2)}`
        let file=""

        if(type==="image"){
            file=path.join(directory,`${prefix}_${id}.jpg`)
            await compressImage(buffer,file)
        }
        else if(type==="video"){
            file=path.join(directory,`${prefix}_${id}.mp4`)
            await compressVideo(buffer,file)
        }
        else if(type==="audio"){
            file=path.join(directory,`${prefix}_${id}.m4a`)
            await compressAudio(buffer,file)
        }
        else if(type==="sticker"){
            file=path.join(directory,`${prefix}_${id}.webp`)
            fs.writeFileSync(file,buffer)
        }
        else if(type==="document"){
            const ext=
                path.extname(media.fileName||"").replace(".","")||
                "bin"
            file=path.join(directory,`${prefix}_${id}.${ext}`)
            fs.writeFileSync(file,buffer)
        }
        else return ""

        return `/uploads/${path.relative(MEDIA_DIR,file).replace(/\\/g,"/")}`
    }catch(e){
        console.error("[SAVE MEDIA]",e.message)
        return ""
    }
}

function extractText(message){
    if(!message)
        return ""

    if(message.ephemeralMessage?.message)
        return extractText(message.ephemeralMessage.message)

    if(message.viewOnceMessage?.message)
        return extractText(message.viewOnceMessage.message)

    if(message.viewOnceMessageV2?.message)
        return extractText(message.viewOnceMessageV2.message)

    if(message.viewOnceMessageV2Extension?.message)
        return extractText(message.viewOnceMessageV2Extension.message)

    if(message.editedMessage?.message)
        return extractText(message.editedMessage.message)

    if(message.documentWithCaptionMessage?.message)
        return extractText(message.documentWithCaptionMessage.message)

    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedDisplayText ||
        message.listResponseMessage?.title ||
        message.templateButtonReplyMessage?.selectedDisplayText ||
        message.interactiveResponseMessage?.body?.text ||
        ""
    )
}



async function handleMessage(session,message,isHistory=false){
    const content=message.message||{}

    const key=message.key||{}
    const reaction=content.reactionMessage||null
    if(
        content.protocolMessage ||
        content.senderKeyDistributionMessage
    )
        return


    const jid=key.remoteJid||""
    const sender=key.participant||key.remoteJid||""
    const isStatus=jid==="status@broadcast"

    let chatAvatar=""
    let senderAvatar=""
    let groupName=""
    let channelName=""

    const bot=require("./bot")
    const command=getCommand(message)

    if(command){

        await bot.handleCommand(
            session,
            message,
            command
        )

        return
    }

    const clientId=pendingClientIds.get(
        `${session.id}:${message.key?.id}`
    )||""
    
    if(clientId){
        pendingClientIds.delete(
            `${session.id}:${message.key?.id}`
        )
    }

    let text = extractText(message.message)


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

    if(!isHistory){

        if(isStatus){

            chatAvatar=await getProfilePictureUrl(
                session.sock,
                sender
            )

        }else if(jid.endsWith("@g.us")){

            groupName=await getGroupMetadata(
                session.sock,
                jid
            )

            chatAvatar=await getProfilePictureUrl(
                session.sock,
                jid
            )

        }else if(jid.endsWith("@newsletter")){

            const meta=await getChannelMetadata(
                session.sock,
                jid
            )

            channelName=meta.name
            groupName=meta.name

            chatAvatar=
                meta.icon||
                await getProfilePictureUrl(
                    session.sock,
                    jid
                )

        }else{

            chatAvatar=await getProfilePictureUrl(
                session.sock,
                jid
            )

        }

        senderAvatar=
            sender&&sender!==jid
                ? await getProfilePictureUrl(
                    session.sock,
                    sender
                )
                : chatAvatar

    }

    const ownerName=session.phone||""

    let contactName=""

    if(!isHistory)
        contactName=await getSavedContactName(
            session,
            sender
        )

    if(
        !isHistory&&
        !isStatus&&
        !jid.endsWith("@g.us")&&
        !jid.endsWith("@newsletter")
    ){

        const aboutJid=key.fromMe
            ? jid
            : sender

        if(aboutJid){

            await updateAbout(
                session.sock,
                session.id||"default",
                aboutJid
            )

        }

    }

    let quoted=null

    const contextInfo=
        message.message?.extendedTextMessage?.contextInfo||
        message.message?.imageMessage?.contextInfo||
        message.message?.videoMessage?.contextInfo||
        message.message?.documentMessage?.contextInfo||
        message.message?.audioMessage?.contextInfo||
        message.message?.stickerMessage?.contextInfo

    if(contextInfo?.quotedMessage){

        const quotedSender=
            contextInfo.participant||""

        let quotedName=""

        if(!isHistory)
            quotedName=await getSavedContactName(
                session,
                quotedSender
            )

        quoted={
            id:contextInfo.stanzaId||"",
            sender:quotedSender,
            sender_name:quotedName,
            text:
                extractText(
                    contextInfo.quotedMessage
                )||""
        }

    }

    const media=getMediaInfo(message)

    let saved

    try{


        saved=await recordMessage({
            session,
            session_id:session.id,
            key:message.key,
            message:message.message,
            is_history:isHistory,
            jid,
            sender,
            from_me:message.key?.fromMe?1:0,
            msg_id:message.key?.id,
            push_name:message.pushName,
            timestamp:message.messageTimestamp,
            chat_avatar:chatAvatar,
            sender_avatar:senderAvatar,
            group_name:groupName,
            channel_name:channelName,
            contact_name:contactName,
            sender_name:contactName,
            owner_name:ownerName,
            quoted,
            reaction:reaction?.text||"",
            reaction_msg_id:reaction?.key?.id||"",
            clientId:clientId

        })

    }catch(e){

        console.error(
            "[MSG] record failed",
            key.id,
            e.message
        )

        return

    }

    if(!saved){

        console.clear()

        return

    }

    if(!isHistory||key.fromMe){

        const msgs=require("./messages")


        msgs.emitMessage(
            session.id,
            saved,
            "message"
        )

    }

    const dir=isStatus
        ? STATUS_DIR
        : media.type==="image"
            ? IMAGE_DIR
            : media.type==="video"
                ? VIDEO_DIR
                : media.type==="audio"
                    ? AUDIO_DIR
                    : media.type==="sticker"
                        ? STICKER_DIR
                        : DOC_DIR

    setImmediate(async()=>{

        try{

            const mediaPath=await saveMedia(
                session,
                message,
                media.type,
                dir,
                isStatus?"status":media.type
            )

            if(!mediaPath)
                return

            await run(
                `UPDATE messages SET media_path=? WHERE id=?`,
                [
                    mediaPath,
                    saved.id
                ]
            )

            saved.media_path=mediaPath

            const msgs=require("./messages")

            msgs.emitMessage(
                session.id,
                {
                    id:saved.msg_id,
                    media_path:mediaPath,
                    media_type:media.type
                },
                "media-update"
            )

        }catch(e){

            console.error(
                "[MEDIA] failed",
                key.id,
                e.message
            )

        }

    })

}

module.exports={
    handleMessage,
    getText,
    getMessageContent,
    getSavedContactName,
    getContact,
    findContact,
    searchContacts,
    getProfilePictureUrl,
    getChannelMetadata,
    isViewOnceMessage,
    clean,
    unsavedName,
    getGroupMetadata,
    setPendingIds
}