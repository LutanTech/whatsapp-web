module.exports = {

    name: "info",

    async execute({
        sock,
        jid,
        sender,
        isGroup
    }) {

        await sock.sendMessage(jid, {
            text:
`BOT INFORMATION

User: ${sender}
Chat: ${isGroup ? "Group" : "Private"}
Status: Online`
        })
    }
}