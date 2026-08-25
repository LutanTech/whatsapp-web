const fs = require("fs")
const path = require("path")

const commands = new Map()

function loadCommands() {

    commands.clear()

    const dir = path.join(__dirname, "..", "commands")

    if (!fs.existsSync(dir)) {
        console.error("[CMD] Commands folder missing:", dir)
        return
    }

    for (const file of fs.readdirSync(dir)) {

        if (!file.endsWith(".js")) continue

        try {

            const command = require(path.join(dir, file))

            if (!command.name || typeof command.execute !== "function") {
                console.error(`[CMD] Invalid command: ${file}`)
                continue
            }

            commands.set(
                command.name.toLowerCase(),
                command
            )


        } catch (error) {
            console.error(`[CMD] Failed loading ${file}:`, error)
        }
    }

}

function getCommand(name) {
    return commands.get(name.toLowerCase())
}

function getCommands() {
    return [...commands.values()]
}

loadCommands()

module.exports = {
    loadCommands,
    getCommand,
    getCommands
}