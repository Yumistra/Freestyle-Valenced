package io.github.yumistra.discordwatch

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 설정과 저장:
 *  - 토큰은 안드로이드 키 저장소(Keystore)의 AES 키로 암호화해서 저장한다 (기기 밖으로 꺼낼 수 없는 키)
 *  - 최근 메시지 (지워졌을 때 내용을 알려고): 메모리 + 파일
 *  - 보낼 기록 (Message Logger 로): queue.jsonl, 3일이 지나면 지운다
 */
object Store {
    private const val KEY_ALIAS = "discord-watch-token"
    private const val PREFS = "watch"
    const val DEFAULT_TARGET = "com.discord"
    const val CACHE_MAX = 3000
    const val QUEUE_KEEP_MS = 3L * 24 * 3600 * 1000

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ── 토큰 ────────────────────────────────────────────────────────────
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    fun saveToken(ctx: Context, token: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val enc = c.doFinal(token.trim().toByteArray(Charsets.UTF_8))
        prefs(ctx).edit()
            .putString("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
            .putString("token", Base64.encodeToString(enc, Base64.NO_WRAP))
            .apply()
    }

    fun token(ctx: Context): String? {
        val p = prefs(ctx)
        val iv = p.getString("iv", null) ?: return null
        val enc = p.getString("token", null) ?: return null
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(c.doFinal(Base64.decode(enc, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Throwable) {
            null
        }
    }

    fun clearToken(ctx: Context) {
        prefs(ctx).edit().remove("iv").remove("token").apply()
    }

    fun hasToken(ctx: Context) = prefs(ctx).contains("token")

    // ── 설정 ────────────────────────────────────────────────────────────
    fun target(ctx: Context): String = prefs(ctx).getString("target", DEFAULT_TARGET)?.ifBlank { DEFAULT_TARGET } ?: DEFAULT_TARGET
    fun setTarget(ctx: Context, v: String) = prefs(ctx).edit().putString("target", v.trim()).apply()
    fun enabled(ctx: Context) = prefs(ctx).getBoolean("enabled", false)
    fun setEnabled(ctx: Context, v: Boolean) = prefs(ctx).edit().putBoolean("enabled", v).apply()
    fun notify(ctx: Context) = prefs(ctx).getBoolean("notify", true)
    fun setNotify(ctx: Context, v: Boolean) = prefs(ctx).edit().putBoolean("notify", v).apply()

    // ── 최근 메시지 ─────────────────────────────────────────────────────
    private val cache = object : LinkedHashMap<String, JSONObject>(256, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?) = size > CACHE_MAX
    }
    private var cacheLoaded = false
    private var cacheDirty = 0

    private fun cacheFile(ctx: Context) = File(ctx.filesDir, "cache.jsonl")

    @Synchronized
    fun remember(ctx: Context, m: JSONObject) {
        loadCache(ctx)
        cache[m.optString("id")] = m
        if (++cacheDirty >= 50) flushCache(ctx)
    }

    @Synchronized
    fun recall(ctx: Context, id: String): JSONObject? {
        loadCache(ctx)
        return cache[id]
    }

    @Synchronized
    fun forget(ctx: Context, id: String) {
        loadCache(ctx)
        if (cache.remove(id) != null) cacheDirty++
    }

    @Synchronized
    fun cacheSize(ctx: Context): Int {
        loadCache(ctx)
        return cache.size
    }

    private fun loadCache(ctx: Context) {
        if (cacheLoaded) return
        cacheLoaded = true
        val f = cacheFile(ctx)
        if (!f.exists()) return
        try {
            f.forEachLine { line ->
                try {
                    val o = JSONObject(line)
                    cache[o.optString("id")] = o
                } catch (_: Throwable) {
                }
            }
        } catch (_: Throwable) {
        }
    }

    @Synchronized
    fun flushCache(ctx: Context) {
        if (!cacheLoaded || cacheDirty == 0) return
        cacheDirty = 0
        try {
            val tmp = File(ctx.filesDir, "cache.jsonl.tmp")
            tmp.bufferedWriter().use { w -> for (o in cache.values) w.write(o.toString() + "\n") }
            tmp.renameTo(cacheFile(ctx))
        } catch (_: Throwable) {
        }
    }

    // ── 보낼 기록 ───────────────────────────────────────────────────────
    private fun queueFile(ctx: Context) = File(ctx.filesDir, "queue.jsonl")

    @Synchronized
    fun enqueue(ctx: Context, line: JSONObject) {
        queueFile(ctx).appendText(line.toString() + "\n")
    }

    /** 3일 안의 기록 (오래된 건 지운다) */
    @Synchronized
    fun queue(ctx: Context): List<String> {
        val f = queueFile(ctx)
        if (!f.exists()) return emptyList()
        val now = System.currentTimeMillis()
        val keep = f.readLines().filter { line ->
            try {
                now - JSONObject(line).optLong("at") < QUEUE_KEEP_MS
            } catch (_: Throwable) {
                false
            }
        }
        f.writeText(if (keep.isEmpty()) "" else keep.joinToString("\n") + "\n")
        return keep
    }

    /** 읽기만 (화면 표시용) */
    @Synchronized
    fun queueSize(ctx: Context): Int {
        val f = queueFile(ctx)
        return if (f.exists()) f.readLines().count { it.isNotBlank() } else 0
    }
}
