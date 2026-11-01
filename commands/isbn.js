
module.exports = {
    name: "isbn",
    aliases: [],

    async execute({ sock, jid, args, message }) {
        try {
            const isbn = (args || []).join("").replace(/[-\s]/g, "");

            if (!/^(978|979)\d{10}$/.test(isbn)) {
                return sock.sendMessage(jid, {
                    text: "Usage: .isbn 9789914352566"
                }, { quoted: message });
            }

            const url = `https://isbn.tunupublishers.com/api/barcode?isbn=${encodeURIComponent(isbn)}`;
            const response = await fetch(url);

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));

                return sock.sendMessage(jid, {
                    text: error.error || "Failed to generate the ISBN barcode."
                }, { quoted: message });
            }

            const image = Buffer.from(await response.arrayBuffer());

            await sock.sendMessage(jid, {
                image,
                caption: `ISBN: ${isbn}`
            }, { quoted: message });

        } catch (error) {
            console.error("ISBN command error:", error);

            await sock.sendMessage(jid, {
                text: "Could not generate the ISBN barcode. Please try again."
            }, { quoted: message });
        }
    }
};
