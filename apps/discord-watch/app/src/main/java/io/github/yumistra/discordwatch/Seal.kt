package io.github.yumistra.discordwatch

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.X509EncodedKeySpec
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 암호화 (Discord Watch 앱과 Message Logger 플러그인에 같은 코드가 있다. 패키지 이름만 다르다).
 *  - ChaCha20-Poly1305: 32바이트 키, 12바이트 nonce (매번 새로), 결과 = nonce + 암호문(태그 포함)
 *  - X25519 일회용 키 교환 + HKDF-SHA256 → 주고받을 때마다 새 키
 *  - 봉투: "1.<받는 키 id>.<보내는 쪽 일회용 공개키>.<암호문>" (base64url), 안은 gzip
 */
object Seal {
    private val random = SecureRandom()
    private const val INFO = "discord-watch transport v1"

    fun randomKey(): ByteArray = ByteArray(32).also { random.nextBytes(it) }

    private fun chacha(): Cipher {
        // 안드로이드(Conscrypt) 이름, 자바 이름
        for (name in arrayOf("ChaCha20/Poly1305/NoPadding", "ChaCha20-Poly1305")) {
            try {
                return Cipher.getInstance(name)
            } catch (_: Throwable) {
            }
        }
        throw IllegalStateException("ChaCha20-Poly1305 not available")
    }

    fun encrypt(key: ByteArray, plain: ByteArray, aad: ByteArray? = null): ByteArray {
        val nonce = ByteArray(12).also { random.nextBytes(it) }
        val c = chacha()
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
        if (aad != null) c.updateAAD(aad)
        val ct = c.doFinal(plain)
        return nonce + ct
    }

    fun decrypt(key: ByteArray, box: ByteArray, aad: ByteArray? = null): ByteArray {
        require(box.size > 12 + 16) { "too short" }
        val c = chacha()
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(box, 0, 12))
        if (aad != null) c.updateAAD(aad)
        return c.doFinal(box, 12, box.size - 12)
    }

    // ── base64url (android.util.Base64 없이, 양쪽 같은 결과) ─────────────
    private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun b64(b: ByteArray): String {
        val s = StringBuilder((b.size + 2) / 3 * 4)
        var i = 0
        while (i < b.size) {
            val n = (b[i].toInt() and 0xff shl 16) or ((if (i + 1 < b.size) b[i + 1].toInt() and 0xff else 0) shl 8) or (if (i + 2 < b.size) b[i + 2].toInt() and 0xff else 0)
            s.append(B64[n shr 18 and 63]).append(B64[n shr 12 and 63])
            if (i + 1 < b.size) s.append(B64[n shr 6 and 63])
            if (i + 2 < b.size) s.append(B64[n and 63])
            i += 3
        }
        return s.toString()
    }

    fun unb64(s: String): ByteArray {
        val out = ByteArrayOutputStream(s.length * 3 / 4)
        var buf = 0
        var bits = 0
        for (ch in s) {
            val v = B64.indexOf(ch)
            require(v >= 0) { "bad base64" }
            buf = (buf shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write(buf shr bits and 0xff)
            }
        }
        return out.toByteArray()
    }

    fun gzip(b: ByteArray): ByteArray {
        val o = ByteArrayOutputStream()
        GZIPOutputStream(o).use { it.write(b) }
        return o.toByteArray()
    }

    fun gunzip(b: ByteArray, max: Int = 64 * 1024 * 1024): ByteArray {
        val o = ByteArrayOutputStream()
        GZIPInputStream(ByteArrayInputStream(b)).use { i ->
            val buf = ByteArray(16384)
            while (true) {
                val n = i.read(buf)
                if (n < 0) break
                o.write(buf, 0, n)
                require(o.size() <= max) { "too big" }
            }
        }
        return o.toByteArray()
    }

    // ── X25519 ───────────────────────────────────────────────────────────
    private inline fun <T> first(names: Array<String>, f: (String) -> T): T {
        var last: Throwable? = null
        for (n in names) {
            try {
                return f(n)
            } catch (t: Throwable) {
                last = t
            }
        }
        throw IllegalStateException("X25519 not available", last)
    }

    fun newPair(): KeyPair = first(arrayOf("X25519", "XDH")) { KeyPairGenerator.getInstance(it).generateKeyPair() }

    private fun publicOf(raw: ByteArray) = first(arrayOf("X25519", "XDH")) { KeyFactory.getInstance(it).generatePublic(X509EncodedKeySpec(raw)) }

    private fun shared(priv: PrivateKey, pubRaw: ByteArray): ByteArray = first(arrayOf("X25519", "XDH")) {
        val ka = KeyAgreement.getInstance(it)
        ka.init(priv)
        ka.doPhase(publicOf(pubRaw), true)
        ka.generateSecret()
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        return m.doFinal(data)
    }

    /** HKDF-SHA256 (32바이트 하나) */
    private fun hkdf(secret: ByteArray, salt: ByteArray): ByteArray {
        val prk = hmac(salt, secret)
        return hmac(prk, INFO.toByteArray(Charsets.UTF_8) + byteArrayOf(1))
    }

    /** 공개키 → 짧은 id (받는 쪽이 어느 키로 열지 알게) */
    fun idOf(pubRaw: ByteArray): String = b64(MessageDigest.getInstance("SHA-256").digest(pubRaw).copyOf(9))

    /** 받는 쪽 공개키로 잠근다. 매번 새 일회용 키를 만든다 */
    fun seal(recipientPub: ByteArray, plain: ByteArray): String {
        val eph = newPair()
        val ephPub = eph.public.encoded
        val key = hkdf(shared(eph.private, recipientPub), ephPub + recipientPub)
        val id = idOf(recipientPub)
        val box = encrypt(key, gzip(plain), id.toByteArray(Charsets.UTF_8))
        return "1." + id + "." + b64(ephPub) + "." + b64(box)
    }

    /** 봉투의 받는 키 id (없으면 null) */
    fun recipientOf(env: String): String? = env.split('.').takeIf { it.size == 4 && it[0] == "1" }?.get(1)

    /** 내 키로 연다. 맞지 않거나 바뀌었으면 예외 */
    fun open(myPair: KeyPair, env: String): ByteArray {
        val p = env.split('.')
        require(p.size == 4 && p[0] == "1") { "bad envelope" }
        val myPub = myPair.public.encoded
        require(p[1] == idOf(myPub)) { "not for this key" }
        val ephPub = unb64(p[2])
        val key = hkdf(shared(myPair.private, ephPub), ephPub + myPub)
        return gunzip(decrypt(key, unb64(p[3]), p[1].toByteArray(Charsets.UTF_8)))
    }
}

/** 최근 일회용 키 몇 개 (받는 쪽이 열 때 고른다) */
class KeyRing(private val keep: Int) {
    private val pairs = LinkedHashMap<String, KeyPair>()

    /** 새 키를 만들고 공개키(base64url)를 돌려준다 */
    @Synchronized
    fun fresh(): String {
        val p = Seal.newPair()
        val pub = p.public.encoded
        pairs[Seal.idOf(pub)] = p
        while (pairs.size > keep) pairs.remove(pairs.keys.first())
        return Seal.b64(pub)
    }

    /** 연다. once 면 쓴 키를 버린다 */
    @Synchronized
    fun open(env: String, once: Boolean): ByteArray {
        val id = Seal.recipientOf(env) ?: throw IllegalArgumentException("bad envelope")
        val p = pairs[id] ?: throw IllegalStateException("unknown key")
        val r = Seal.open(p, env)
        if (once) pairs.remove(id)
        return r
    }
}
