module.exports = {

    name: "menu",

    async execute({ sock, jid }) {

        console.log(`[CMD] Executing .menu for ${jid}`)

        await sock.sendMessage(jid, {
            text: `╭━━━〔 MY BOT 〕━━━╮
┃
┃ .ping
┃ .menu
┃ .info
┃ .group info
┃ .group admins
┃
╰━━━━━━━━━━━━━━╯`
        })
    }
}