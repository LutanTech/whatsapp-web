require("dotenv").config()

const sqlite3 = require("sqlite3").verbose()
const fs = require("fs")
const path = require("path")

const databaseFile = path.resolve(
    process.env.DATABASE || path.join(__dirname, "../data/bot.db")
)

fs.mkdirSync(path.dirname(databaseFile), {
    recursive: true
})

const db = new sqlite3.Database(databaseFile, err => {
    if (err) {
        console.error("[DB] Connection error:", err)
    } else {
        console.log(`[DB] Connected: ${databaseFile}`)
    }
})

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err && !String(err.message).includes('duplicate column')) {
                console.error("[DB] RUN:", err.message)
                return reject(err)
            }

            resolve({
                id: this.lastID,
                changes: this.changes
            })
        })
    })
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) {
                console.error("[DB] GET:", err.message)
                return reject(err)
            }

            resolve(row)
        })
    })
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error("[DB] ALL:", err.message)
                return reject(err)
            }

            resolve(rows)
        })
    })
}



async function initializeDatabase() {
    await run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            phone TEXT,
            status TEXT DEFAULT 'disconnected',
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            token TEXT,
            token_expires_at INTEGER DEFAULT 0
        )
    `)

    await run(`
        CREATE TABLE IF NOT EXISTS users (
            jid TEXT PRIMARY KEY,
            name TEXT,
            created_at INTEGER DEFAULT (unixepoch())
        )
    `)

    await run(`
        CREATE TABLE IF NOT EXISTS groups (
            jid TEXT PRIMARY KEY,
            name TEXT,
            settings TEXT DEFAULT '{}',
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch())
        )
    `)

    await run(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            session INTEGER,
            created_at INTEGER DEFAULT (unixepoch()),
            UNIQUE(name, phone)
        )
    `)

    await run(`
        CREATE TABLE IF NOT EXISTS abouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            jid TEXT NOT NULL,
            about TEXT,
            updated_at INTEGER DEFAULT (unixepoch()),
            UNIQUE(session_id, jid)
        )
    `)

    await run(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            name TEXT,
            key_hash TEXT NOT NULL UNIQUE,
            active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME
        );
        `)

    await run(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                jid TEXT,
                sender TEXT,
                sender_name TEXT,
                text TEXT,
                msg_id TEXT,
                from_me INTEGER DEFAULT 0,
                push_name TEXT,
                receiver TEXT,
                conversation_key TEXT,
                media_type TEXT,
                media_path TEXT,
                mime_type TEXT,
                file_name TEXT,
                media_size INTEGER DEFAULT 0,
                is_status INTEGER DEFAULT 0,
                is_view_once INTEGER DEFAULT 0,
                group_name TEXT,
                channel_name TEXT,
                avatar TEXT,
                sender_avatar TEXT,
                chat_avatar TEXT,
                quoted_msg_id TEXT,
                quoted_text TEXT,
                quoted_sender TEXT,
                reaction TEXT,
                reaction_msg_id TEXT,
                created_at INTEGER DEFAULT (unixepoch()),
                link_image TEXT,
                link_site_name TEXT,
                link_type TEXT,
                read_at INTEGER DEFAULT 0,
                link_url TEXT,
                link_title TEXT,
                link_description TEXT,
                client_id TEXT,
                status TEXT
            )
        `)

        const migrations=[
            `ALTER TABLE messages ADD COLUMN direct_path TEXT`,
            `ALTER TABLE messages ADD COLUMN media_url TEXT`,
            `ALTER TABLE messages ADD COLUMN media_key TEXT`,
            `ALTER TABLE messages ADD COLUMN file_enc_sha256 TEXT`,
            `ALTER TABLE messages ADD COLUMN newsletter_jid TEXT`,
            `ALTER TABLE messages ADD COLUMN newsletter_name TEXT`,
            `ALTER TABLE messages ADD COLUMN invite_expiration INTEGER`
        ]

    for (const sql of migrations) {
        try {
            await run(sql)
        } catch (e) {
            console.log('[DB ERROR]', e.message)
        }
    }
    await run(`
        DELETE FROM messages
        WHERE id NOT IN (
            SELECT MIN(id)
            FROM messages
            WHERE msg_id IS NOT NULL AND msg_id != ''
            GROUP BY session_id, msg_id
        )
        AND msg_id IS NOT NULL
        AND msg_id != ''
    `)
    
    await run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_msg
        ON messages(session_id, msg_id)
        WHERE msg_id IS NOT NULL AND msg_id != ''
    `)
    await run(`
        CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id)
    `)

    await run(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(session_id, conversation_key)
    `)

    await run(`
        CREATE INDEX IF NOT EXISTS idx_messages_created
        ON messages(session_id, created_at)
    `)

    await run(`
        CREATE INDEX IF NOT EXISTS idx_messages_jid
        ON messages(session_id, jid)
    `)

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
            `, [
                sender,
                receiver,
                key,
                row.id
            ])

            updated++
        }
    } catch (err) {
        console.error("[DB] Migration error:", err.message)
    }

    console.log("[DB] Tables ready")
}

initializeDatabase().catch(err => {
    console.error("[DB] Initialization failed:", err)
})

module.exports = {
    db,
    run,
    get,
    all
}