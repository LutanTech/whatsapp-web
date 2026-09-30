const fs = require("fs")
const path = require("path")
const https = require("https")
const { all, run, get } = require("./database")
const { downloadMediaMessage, downloadContentFromMessage } = require("@whiskeysockets/baileys")
const { stringStream } = require("cheerio")
const { SourceTextModule } = require("vm")
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

function setMessageEmitter(io) {
    messageEmitter = io || null
}
function emitMessage(sessionId,message,event="message"){

    const {getSession}=require("./sessions")
    const session=getSession(sessionId)

    if(!session?.socketId||!messageEmitter)return

    messageEmitter
        .to(session.socketId)
        .emit(event,message)
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
    if (!data) return ""

    if (data.text) return data.text
    if (data.body) return data.body

    const m = unwrapMessage(data) || data

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.documentMessage?.fileName ||
        ""
    )
}

function unsavedName(name){
    name=clean(name)
    return name&&!name.startsWith("~")?`~${name}`:name
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

async function resolveLidMentions(session,text,message){
    const content=unwrapMessage(message)
    const contextInfo=
        content?.extendedTextMessage?.contextInfo||
        content?.imageMessage?.contextInfo||
        content?.videoMessage?.contextInfo||
        content?.documentMessage?.contextInfo

    const mentions=contextInfo?.mentionedJid||[]

    for(const jid of mentions){
        if(!jid.endsWith("@lid"))continue

        try{
            const pn=await session.sock.signalRepository.lidMapping.getPNForLID(jid)
            if(!pn)continue

            const lid=jid.split("@")[0]
            const phone=pn.split("@")[0].split(":")[0]

            text=text.replace(
                new RegExp(`@${lid}(?!\\d)`,"g"),
                `@${phone}`
            )
        }catch{}
    }

    return text
}


async function recordMessage(data) {
    const { getContact } = require("./sessions")

    const waSession=data.session
    const session=clean(
        data.session_id||
        data.sessionId
    )||"default"

    const source = data.message || {}
    const key = data.key || {}
    const rawMessage = source

    if (!rawMessage || rawMessage.protocolMessage)
        return null

    const message = rawMessage


    const newsletterInvite=message.newsletterAdminInviteMessage||null

    let text=String(
        newsletterInvite?.caption||
        extractText(message)||
        ""
    )
    
    if(waSession)
        text=await resolveLidMentions(waSession,text,message)
    
    if(/^@all$/i.test(text))
        text="--mention-- Everyone"
    else if(/^@\d+$/.test(text)){
        const contact=await getContact(session,text.slice(1))
        text=`--mention-- ${contact?.name||text}`
    }


    

    const fromMe =
        data.from_me !== undefined
            ? (data.from_me ? 1 : 0)
            : (key.fromMe ? 1 : 0)

    const jid = clean(
        data.jid ||
        data.chatJid ||
        key.remoteJid ||
        key.remoteJidAlt
    )

    if (!jid)
        return null

    const pushName = clean(
        data.pushName ||
        data.push_name ||
        source.pushName ||
        source.verifiedBizName ||
        source.verifiedName
    )

    let sender = ""
    let receiver = ""
    let cKey = null

    const channelName = clean(
        data.channel_name ||
        data.channelName
    )

    const groupName = clean(
        data.group_name ||
        data.groupName ||
        channelName
    )

    if (jid === "status@broadcast") {
        sender =
            clean(
                data.sender ||
                data.senderJid ||
                key.participant
            ) || "status@broadcast"

        receiver = jid
        cKey = statusConversationKey(session,jid)

    } else if (jid.endsWith("@g.us")) {
        sender =
            clean(
                data.sender ||
                data.senderJid ||
                key.participant
            ) || (fromMe ? session : jid)

        receiver = jid
        cKey = groupConversationKey(session,jid)

    } else if (jid.endsWith("@newsletter")) {
        sender =
            clean(
                data.sender ||
                data.senderJid ||
                key.participant
            ) || jid

        receiver = jid
        cKey = channelConversationKey(session,jid)

    } else {
        sender =
            fromMe
                ? session
                : clean(
                    data.sender ||
                    data.senderJid ||
                    key.participant
                ) || jid

        receiver = fromMe ? jid : session
        cKey = conversationKey(session,sender,receiver)
    }

    if (!cKey)
        return null

    let senderName=""

    if(sender){
        const phone=sender
            .replace(/@s\.whatsapp\.net$/,"")
            .replace(/\D/g,"")
    
        if(phone){
            const contact=await get(
                `SELECT name FROM contacts
                 WHERE session=?
                 AND REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-','')=?
                 LIMIT 1`,
                [session,phone]
            )
    
            senderName=clean(contact?.name)
        }
    }
    
    if(!senderName){
        senderName=clean(
            data.sender_name||
            data.senderName||
            pushName
        )
    }
    const context =
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        message.stickerMessage?.contextInfo ||
        message.buttonsResponseMessage?.contextInfo ||
        message.listResponseMessage?.contextInfo ||
        null

    const quoted = context?.quotedMessage || null

    const quotedMsgId = clean(
        context?.stanzaId
    )

    const quotedSender = clean(
        context?.participant
    )

    const quotedText = clean(
        quoted?.conversation ||
        quoted?.extendedTextMessage?.text ||
        quoted?.imageMessage?.caption ||
        quoted?.videoMessage?.caption ||
        quoted?.documentMessage?.caption ||
        quoted?.audioMessage?.caption ||
        quoted?.stickerMessage?.caption ||
        ""
    )

    const reaction = clean(
        data.reaction
    )

    const reactionMsgId = clean(
        data.reaction_msg_id ||
        data.reactionMsgId
    )

    const createdAt = Number(
        data.created_at ||
        data.timestamp ||
        data.messageTimestamp ||
        source.messageTimestamp ||
        Math.floor(Date.now() / 1000)
    )

    const msgId = clean(
        data.msg_id ||
        data.message_id ||
        key.id
    )

    const media = getMediaInfo(message)


    const mediaType=clean(
        data.media_type||
        data.mediaType||
        (newsletterInvite?"link":media?.type)||
        ""
    )
    
    const mediaPath=clean(
        data.media_path||
        data.mediaPath||
        ""
    )
    
    const mimeType=clean(
        data.mime_type||
        data.mimeType||
        media?.mimetype||
        ""
    )
    
    const fileName=clean(
        data.file_name||
        data.fileName||
        media?.fileName||
        ""
    )
    
    const mediaSize=Number(
        data.media_size||
        data.mediaSize||
        media?.size||
        0
    )

    const isStatus =
        data.is_status !== undefined
            ? (data.is_status ? 1 : 0)
            : (jid === "status@broadcast" ? 1 : 0)


    const isViewOnce =
        data.is_view_once ? 1 : 0

    const avatar = clean(
        data.avatar ||
        data.chat_avatar
    )

    const senderAvatar = clean(
        data.sender_avatar
    )

    const chatAvatar = clean(
        data.chat_avatar ||
        data.avatar
    )

    const linkUrl = clean(
        data.link_url ||
        data.linkUrl
    )

    const linkTitle = clean(
        data.link_title ||
        data.linkTitle
    )

    const linkDescription = clean(
        data.link_description ||
        data.linkDescription
    )

    const linkImage = clean(
        data.link_image ||
        data.linkImage
    )

    const clientId = clean(
        data.clientId || ''
    )

    const linkSiteName = clean(
        data.link_site_name ||
        data.linkSiteName
    )

    const linkType = clean(
        data.link_type ||
        data.linkType
    )


    const newsletterJid=clean(
        data.newsletter_jid||
        media?.newsletterJid||
        newsletterInvite?.newsletterJid||
        ""
    )
    
    const newsletterName=clean(
        data.newsletter_name||
        media?.newsletterName||
        newsletterInvite?.newsletterName||
        ""
    )
    
    const inviteExpiration=Number(
        data.invite_expiration||
        media?.inviteExpiration||
        newsletterInvite?.inviteExpiration||
        0
    )
    


    const columns=[
        "session_id",
        "jid",
        "sender",
        "receiver",
        "conversation_key",
        "text",
        "created_at",
        "msg_id",
        "from_me",
        "push_name",
        "sender_name",
        "group_name",
        "channel_name",
        "media_type",
        "media_path",
        "mime_type",
        "file_name",
        "media_size",
        "direct_path",
        "media_url",
        "media_key",
        "file_enc_sha256",
        "is_status",
        "is_view_once",
        "avatar",
        "sender_avatar",
        "chat_avatar",
        "quoted_msg_id",
        "quoted_sender",
        "quoted_text",
        "reaction",
        "reaction_msg_id",
        "link_url",
        "link_title",
        "link_description",
        "link_image",
        "link_site_name",
        "link_type",
        "client_id",
        "newsletter_jid",
        "newsletter_name",
        "invite_expiration",
    ]
    
    const values=[
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
        mediaSize,
        data.direct_path||null,
        data.media_url||null,
        data.media_key||null,
        data.file_enc_sha256||null,
        isStatus,
        isViewOnce,
        avatar,
        senderAvatar,
        chatAvatar,
        quotedMsgId,
        quotedSender,
        quotedText,
        reaction,
        reactionMsgId,
        linkUrl,
        linkTitle,
        linkDescription,
        linkImage,
        linkSiteName,
        linkType,
        clientId,
        newsletterJid,
        newsletterName,
        inviteExpiration,
    ]

    const result = await run(
        `INSERT OR IGNORE INTO messages (${columns.join(",")})
         VALUES (${values.map(() => "?").join(",")})`,
        values
    )

    if (!result?.id)
        return null

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
        avatar,
        sender_avatar: senderAvatar,
        chat_avatar: chatAvatar,
        media_type: mediaType,
        media_path: mediaPath,
        mime_type: mimeType,
        file_name: fileName,
        media_size: mediaSize,
        direct_path: data.direct_path || null,
        media_url: data.media_url || null,
        media_key: data.media_key || null,
        file_enc_sha256: data.file_enc_sha256 || null,
        is_status: isStatus,
        is_view_once: isViewOnce,
        quoted_msg_id: quotedMsgId,
        quoted_sender: quotedSender,
        quoted_text: quotedText,
        reaction,
        reaction_msg_id: reactionMsgId,
        link_url: linkUrl,
        link_title: linkTitle,
        link_description: linkDescription,
        link_image: linkImage,
        link_site_name: linkSiteName,
        link_type: linkType,
        client_id: clientId,
        newsletter_jid:newsletterJid,
        newsletter_name:newsletterName,
        invite_expiration:inviteExpiration,
    }

    if(messageEmitter)
        emitMessage(session,saved)
    
    return saved
}

module.exports={
    recordMessage,
    conversationKey,
    groupConversationKey,
    channelConversationKey,
    statusConversationKey,
    extractText,
    setMessageEmitter,
    emitMessage
}