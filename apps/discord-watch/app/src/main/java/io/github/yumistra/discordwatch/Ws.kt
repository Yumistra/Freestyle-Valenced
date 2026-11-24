package io.github.yumistra.discordwatch

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * 아주 작은 웹소켓 (wss 만). 게이트웨이 하나에 쓰려고 직접 만든 것 (okhttp 없이).
 *  - 받는 쪽: 글(text) 프레임, 이어지는 조각, ping 에 pong, close
 *  - 보내는 쪽: 글 프레임 (클라이언트라 마스크를 씌운다)
 * 콜백은 읽기 스레드에서 불린다.
 */
class Ws(url: String, private val listener: Listener) {
    interface Listener {
        fun onText(text: String)
        fun onClosed(code: Int, reason: String)
        fun onFailure(t: Throwable)
    }

    private val host: String
    private val path: String
    private val random = SecureRandom()
    @Volatile private var socket: Socket? = null
    @Volatile private var out: OutputStream? = null
    @Volatile private var done = false

    init {
        val rest = url.removePrefix("wss://").removePrefix("https://")
        val slash = rest.indexOf('/')
        val q = rest.indexOf('?')
        val cut = listOf(slash, q).filter { it >= 0 }.minOrNull() ?: rest.length
        host = rest.substring(0, cut)
        path = rest.substring(cut).let { if (it.isEmpty()) "/" else if (it.startsWith("?")) "/$it" else it }
    }

    fun connect() {
        val t = Thread(Reader(), "ws-read")
        t.isDaemon = true
        t.start()
    }

    private inner class Reader : Runnable {
        override fun run() {
            try {
                open()
                loop(BufferedInputStream(socket!!.getInputStream(), 65536))
            } catch (t: Throwable) {
                if (!done) {
                    done = true
                    closeSocket()
                    listener.onFailure(t)
                }
            }
        }
    }

    private fun open() {
        val raw = Socket()
        raw.connect(InetSocketAddress(host, 443), 20_000)
        raw.soTimeout = 0
        val s = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, host, 443, true) as SSLSocket
        s.startHandshake()
        socket = s
        val o = s.getOutputStream()
        out = o
        val key = ByteArray(16).also { random.nextBytes(it) }
        val k = android.util.Base64.encodeToString(key, android.util.Base64.NO_WRAP)
        val req = "GET $path HTTP/1.1\r\n" +
            "Host: $host\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: $k\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "User-Agent: DiscordWatch\r\n\r\n"
        o.write(req.toByteArray(Charsets.ISO_8859_1))
        o.flush()
        val input = s.getInputStream()
        val status = readLine(input)
        if (!status.contains(" 101")) throw java.io.IOException("Upgrade failed: $status")
        while (readLine(input).isNotEmpty()) {
        }
    }

    private fun readLine(i: InputStream): String {
        val b = StringBuilder()
        while (true) {
            val c = i.read()
            if (c < 0) throw java.io.EOFException()
            if (c == '\n'.code) break
            if (c != '\r'.code) b.append(c.toChar())
            if (b.length > 8192) throw java.io.IOException("Header too long")
        }
        return b.toString()
    }

    private fun readFully(i: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = i.read(buf, off, n - off)
            if (r < 0) throw java.io.EOFException()
            off += r
        }
        return buf
    }

    private fun loop(i: InputStream) {
        val message = ByteArrayOutputStream()
        var messageOp = 0
        while (!done) {
            val b0 = i.read()
            if (b0 < 0) throw java.io.EOFException()
            val b1 = i.read()
            if (b1 < 0) throw java.io.EOFException()
            val fin = b0 and 0x80 != 0
            val op = b0 and 0x0f
            val masked = b1 and 0x80 != 0
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) {
                val e = readFully(i, 2)
                len = ((e[0].toInt() and 0xff) shl 8 or (e[1].toInt() and 0xff)).toLong()
            } else if (len == 127L) {
                val e = readFully(i, 8)
                len = 0
                for (x in e) len = (len shl 8) or (x.toLong() and 0xff)
            }
            if (len > 64L * 1024 * 1024) throw java.io.IOException("Frame too big")
            val mask = if (masked) readFully(i, 4) else null
            val data = readFully(i, len.toInt())
            if (mask != null) for (j in data.indices) data[j] = (data[j].toInt() xor mask[j % 4].toInt()).toByte()
            when (op) {
                0x0, 0x1, 0x2 -> {
                    if (op != 0) {
                        message.reset()
                        messageOp = op
                    }
                    message.write(data)
                    if (fin) {
                        if (messageOp == 0x1) listener.onText(String(message.toByteArray(), Charsets.UTF_8))
                        message.reset()
                    }
                }
                0x8 -> {
                    val code = if (data.size >= 2) ((data[0].toInt() and 0xff) shl 8) or (data[1].toInt() and 0xff) else 1005
                    val reason = if (data.size > 2) String(data, 2, data.size - 2, Charsets.UTF_8) else ""
                    try {
                        frame(0x8, data.copyOf(minOf(2, data.size)))
                    } catch (_: Throwable) {
                    }
                    done = true
                    closeSocket()
                    listener.onClosed(code, reason)
                    return
                }
                0x9 -> frame(0xA, data)
                else -> {}
            }
        }
    }

    @Synchronized
    private fun frame(op: Int, payload: ByteArray) {
        val o = out ?: throw java.io.IOException("Not connected")
        val head = ByteArrayOutputStream(14)
        head.write(0x80 or op)
        val n = payload.size
        when {
            n < 126 -> head.write(0x80 or n)
            n < 65536 -> {
                head.write(0x80 or 126)
                head.write(n shr 8 and 0xff)
                head.write(n and 0xff)
            }
            else -> {
                head.write(0x80 or 127)
                for (s in 7 downTo 0) head.write(((n.toLong() shr (8 * s)) and 0xff).toInt())
            }
        }
        val mask = ByteArray(4).also { random.nextBytes(it) }
        head.write(mask)
        val body = ByteArray(n)
        for (j in 0 until n) body[j] = (payload[j].toInt() xor mask[j % 4].toInt()).toByte()
        o.write(head.toByteArray())
        o.write(body)
        o.flush()
    }

    /** 글 보내기 (실패하면 false) */
    fun send(text: String): Boolean = try {
        frame(0x1, text.toByteArray(Charsets.UTF_8))
        true
    } catch (_: Throwable) {
        false
    }

    /** 정상 종료 (상대에게 close 를 보내고 끊는다). 콜백은 부르지 않는다 */
    fun close(code: Int) {
        if (done) return
        done = true
        try {
            frame(0x8, byteArrayOf((code shr 8 and 0xff).toByte(), (code and 0xff).toByte()))
        } catch (_: Throwable) {
        }
        closeSocket()
    }

    /** 그냥 끊기. 콜백은 부르지 않는다 */
    fun cancel() {
        done = true
        closeSocket()
    }

    private fun closeSocket() {
        try {
            socket?.close()
        } catch (_: Throwable) {
        }
    }
}
