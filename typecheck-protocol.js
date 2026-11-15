export function parseMessages(buffer, onMessage) {
    while (true) {
        const text = buffer.toString('utf8');
        const headerEnd = text.indexOf('\r\n\r\n');
        if (headerEnd < 0) return buffer;

        const match = /Content-Length: (\d+)/i.exec(text.slice(0, headerEnd));
        if (!match) return buffer;

        const length = Number(match[1]);
        const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4));
        if (buffer.length < bodyStart + length) return buffer;

        const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
        buffer = buffer.slice(bodyStart + length);

        onMessage(JSON.parse(body));
    }
}


export function encodeMessage(message) {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}
