module.exports = {

    name: "group",
    aliases: ["g"],

    async execute({
        sock,
        jid,
        args,
        isGroup
    }) {

        if (!isGroup) {

            return sock.sendMessage(jid, {
                text:
                    "This command only works in groups."
            })
        }

        const action =
            args[0]?.toLowerCase()

        const metadata =
            await sock.groupMetadata(jid)

        if (action === "info") {

            return sock.sendMessage(jid, {
                text:
`GROUP INFORMATION

Name: ${metadata.subject}
Members: ${metadata.participants.length}
Owner: ${metadata.owner || "Unknown"}`
            })
        }

        if (action === "admins") {

            const admins =
                metadata.participants
                    .filter(user => user.admin)
                    .map(
                        user =>
                            `@${user.id.split("@")[0]}`
                    )

            const mentions =
                metadata.participants
                    .filter(user => user.admin)
                    .map(user => user.id)

            return sock.sendMessage(
                jid,
                {
                    text:
                        `GROUP ADMINS\n\n${admins.join("\n")}`,
                    mentions
                }
            )
        }

        await sock.sendMessage(jid, {
            text:
`GROUP COMMANDS

.group info
.group admins`
        })
    }
}