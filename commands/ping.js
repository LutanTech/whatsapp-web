module.exports = {
    name: "ping",
    aliases: ["p"],

    async execute({ sock, jid }) {

        const start = Date.now()

        await sock.sendMessage(jid, {
            text: "🏓 Pong!"
        })

        console.log(
            `Ping ${Date.now() - start}ms`
        )
    }
}