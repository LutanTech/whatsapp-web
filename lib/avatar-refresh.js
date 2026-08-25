const { all, run } = require("./database")
const { getProfilePictureUrl } = require("./avatars")

function clean(value) {
    return value == null ? "" : String(value).trim()
}

function chatAvatarTarget(row) {
    const jid = clean(row?.jid)

    if (jid === "status@broadcast")
        return clean(row?.sender) || jid

    return jid
}

function getSavedContactName(session, jid) {
    const target = clean(jid)
    if (!target) return ""

    try {
        const botName = require("./bot").getContactName(session, target)
        if (botName) return clean(botName)
    } catch {}

    const normalized = target.replace(/:\d+@/, "@")
    const phone = normalized.split("@")[0]
    const contacts = session.contacts

    if (contacts instanceof Map) {
        const direct =
            contacts.get(target) ||
            contacts.get(normalized) ||
            contacts.get(`${phone}@s.whatsapp.net`)

        if (direct?.name || direct?.verifiedName)
            return clean(direct.name || direct.verifiedName)

        const match = Array.from(contacts.values()).find(contact =>
            contact?.id === target ||
            contact?.id === normalized ||
            contact?.lid === target ||
            contact?.lid === normalized ||
            contact?.pn === target ||
            contact?.pn === normalized ||
            String(contact?.phoneNumber || "") === phone
        )

        return clean(match?.name || match?.verifiedName)
    }

    return ""
}

async function refreshRowAvatar(session, conversationKey, row) {
    const chatTarget = chatAvatarTarget(row)
    const senderTarget =
        clean(row.sender) && clean(row.sender) !== chatTarget
            ? clean(row.sender)
            : ""
    const ownerName = clean(session.sock?.user?.name)
    const isStatus = row.jid === "status@broadcast"
    const isGroup = String(row.jid || "").endsWith("@g.us")
    const isChannel = String(row.jid || "").endsWith("@newsletter")
    const savedChatName = getSavedContactName(session, chatTarget)
    const savedSenderName = getSavedContactName(session, row.sender)
    const safeChatName = savedChatName && savedChatName !== ownerName
        ? savedChatName
        : ""
    const safeSenderName = savedSenderName &&
        savedSenderName !== ownerName &&
        savedSenderName !== clean(row.group_name) &&
        savedSenderName !== clean(row.channel_name)
        ? savedSenderName
        : ""
    const incomingName = clean(
        row.incoming_name ||
        row.incoming_push_name
    )

    const chatName = isStatus
        ? safeChatName || incomingName
        : isGroup
        ? clean(row.group_name) || safeChatName
        : isChannel
        ? clean(row.channel_name) || safeChatName
        : safeChatName || incomingName

    const senderName = isGroup
        ? incomingName ||
            (!row.from_me ? safeSenderName : "") ||
            (!ownerName && clean(row.sender_name) !== clean(row.group_name)
                ? clean(row.sender_name)
                : "")
        : safeSenderName ||
            incomingName ||
            (!ownerName || clean(row.sender_name) !== ownerName
                ? clean(row.sender_name)
                : "")

    const displayName = chatName || senderName

    const [chatAvatar, senderAvatar] = await Promise.all([
        getProfilePictureUrl(session.sock, chatTarget),
        senderTarget
            ? getProfilePictureUrl(session.sock, senderTarget)
            : Promise.resolve("")
    ])

    const nameWhere = row.jid === "status@broadcast"
        ? " AND sender=?"
        : ""

    const params = [
        chatAvatar,
        senderAvatar,
        senderName,
        chatAvatar,
        session.id,
        conversationKey
    ]

    if (nameWhere)
        params.push(row.sender)

    await run(`
        UPDATE messages
        SET
            avatar=COALESCE(NULLIF(?, ''), avatar),
            sender_avatar=COALESCE(NULLIF(?, ''), sender_avatar),
            sender_name=CASE
                WHEN from_me=0 THEN COALESCE(NULLIF(?, ''), sender_name)
                ELSE sender_name
            END,
            chat_avatar=COALESCE(NULLIF(?, ''), chat_avatar)
        WHERE session_id=? AND conversation_key=?${nameWhere}
    `, params)

    return {
        ...row,
        avatar: chatAvatar || row.avatar || "",
        sender_avatar: senderAvatar || row.sender_avatar || "",
        sender_name: senderName || clean(row.sender_name),
        chat_name: displayName,
        chat_avatar: chatAvatar || row.chat_avatar || ""
    }
}

async function refreshConversationAvatar(session, conversationKey) {
    if (!session?.id || !session?.sock || !conversationKey)
        return null

    const rows = await all(`
        SELECT
            conversation_key,
            jid,
            sender,
            sender_name,
            push_name,
            from_me,
            group_name,
            channel_name,
            avatar,
            sender_avatar,
            chat_avatar
        FROM messages
        WHERE session_id=? AND conversation_key=?
        ORDER BY id DESC
        LIMIT 1
    `, [session.id, conversationKey])

    const latest = rows[0]
    if (!latest) return null

    const incomingRows = await all(`
        SELECT push_name, sender_name, sender
        FROM messages
        WHERE session_id=?
          AND conversation_key=?
          AND from_me=0
        ORDER BY id DESC
        LIMIT 1
    `, [session.id, conversationKey])

    const incoming = incomingRows[0] || {}
    const ownerName = clean(session.sock?.user?.name)
    const incomingContactName = getSavedContactName(session, incoming.sender)
    const incomingCandidates = [
        incomingContactName,
        incoming.push_name,
        incoming.sender_name
    ].map(clean)
    const incomingName = incomingCandidates.find(name =>
        name &&
        name !== ownerName &&
        name !== clean(latest.group_name) &&
        name !== clean(latest.channel_name)
    ) || ""
    const latestWithIncomingName = {
        ...latest,
        incoming_name: incomingName,
        incoming_push_name: clean(incoming.push_name)
    }

    if (latest.jid !== "status@broadcast")
        return refreshRowAvatar(session, conversationKey, latestWithIncomingName)

    const statusRows = await all(`
        SELECT m.conversation_key, m.jid, m.sender, m.sender_name,
               m.push_name, m.from_me, m.group_name, m.channel_name,
               m.avatar, m.sender_avatar, m.chat_avatar
        FROM messages m
        INNER JOIN (
            SELECT sender, MAX(id) AS latest_id
            FROM messages
            WHERE session_id=?
              AND conversation_key=?
              AND jid='status@broadcast'
            GROUP BY sender
        ) latest ON latest.latest_id=m.id
        ORDER BY m.id DESC
    `, [session.id, conversationKey])

    const refreshed = []

    for (const row of statusRows) {
        refreshed.push(await refreshRowAvatar(session, conversationKey, {
            ...row,
            incoming_name: clean(
                getSavedContactName(session, row.sender) ||
                row.push_name ||
                row.sender_name
            )
        }))
    }

    return refreshed.find(row => row.sender === latest.sender) || refreshed[0] || null
}

async function refreshSessionAvatars(session) {
    if (!session?.id || !session?.sock)
        return 0

    const rows = await all(`
        SELECT conversation_key
        FROM messages
        WHERE session_id=?
          AND conversation_key IS NOT NULL
          AND conversation_key != ''
        GROUP BY conversation_key
    `, [session.id])

    let refreshed = 0

    for (const row of rows) {
        try {
            if (await refreshConversationAvatar(session, row.conversation_key))
                refreshed++
        } catch (error) {
            console.warn(
                `[AVATAR] Refresh failed for ${row.conversation_key}:`,
                error.message
            )
        }
    }

    return refreshed
}

module.exports = {
    refreshConversationAvatar,
    refreshSessionAvatars
}

