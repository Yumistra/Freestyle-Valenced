@file:JvmName("VoiceChangerPlugin")

package io.github.yumistra.voicechanger

import android.media.AudioFormat
import android.media.AudioRecord
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.WeakHashMap

/**
 * Voice Changer 의 네이티브 부분.
 * 디스코드(WebRTC JavaAudioDeviceModule)는 마이크를 android.media.AudioRecord.read 로 읽는다.
 * read 가 끝난 직후, 디스코드가 그 소리를 쓰기 전에 버퍼 안의 소리를 그 자리에서 바꾼다.
 *  - girl / baby: 목소리를 높인다 (+ 저음을 깎는다)
 *  - mommy: 조금 높이고 따뜻하고 부드럽게
 *  - deep: 목소리를 낮춘다 (+ 저음을 키운다)
 *  - bad: 싸구려 마이크처럼 저음, 고음을 깎고 중간만 남겨 크게 키우고 찢어지게 (BAD VOICE)
 */

@Volatile private var voice = "off"
@Volatile private var hooked = false
@Volatile private var reads = 0L
@Volatile private var processed = 0L
@Volatile private var rate = 0
@Volatile private var channels = 0
@Volatile private var format = 0
@Volatile private var lastError: String? = null
@Volatile private var javaInputHook = false
/** 디스코드가 실제로 물어봐서 자바 입력으로 바꿨는지 (음성 엔진이 만들어질 때) */
@Volatile private var javaInputForced = false

// ── 소리 처리 ──────────────────────────────────────────────────────────

/** RBJ 바이쿼드 필터 */
private class Biquad(kind: Int, sr: Float, f: Float, q: Float = 0.707f, gainDb: Float = 0f) {
    private var b0 = 1f
    private var b1 = 0f
    private var b2 = 0f
    private var a1 = 0f
    private var a2 = 0f
    private var z1 = 0f
    private var z2 = 0f

    init {
        val w = (2.0 * Math.PI * Math.min(f.toDouble(), sr * 0.45) / sr)
        val cos = Math.cos(w)
        val alpha = Math.sin(w) / (2 * q)
        val a = Math.pow(10.0, gainDb / 40.0)
        var nb0: Double
        var nb1: Double
        var nb2: Double
        var na0: Double
        var na1: Double
        var na2: Double
        when (kind) {
            LP -> {
                nb0 = (1 - cos) / 2; nb1 = 1 - cos; nb2 = (1 - cos) / 2
                na0 = 1 + alpha; na1 = -2 * cos; na2 = 1 - alpha
            }
            HP -> {
                nb0 = (1 + cos) / 2; nb1 = -(1 + cos); nb2 = (1 + cos) / 2
                na0 = 1 + alpha; na1 = -2 * cos; na2 = 1 - alpha
            }
            PEAK -> {
                nb0 = 1 + alpha * a; nb1 = -2 * cos; nb2 = 1 - alpha * a
                na0 = 1 + alpha / a; na1 = -2 * cos; na2 = 1 - alpha / a
            }
            else -> { // LOW_SHELF
                val s = 2 * Math.sqrt(a) * alpha
                nb0 = a * ((a + 1) - (a - 1) * cos + s)
                nb1 = 2 * a * ((a - 1) - (a + 1) * cos)
                nb2 = a * ((a + 1) - (a - 1) * cos - s)
                na0 = (a + 1) + (a - 1) * cos + s
                na1 = -2 * ((a - 1) + (a + 1) * cos)
                na2 = (a + 1) + (a - 1) * cos - s
            }
        }
        b0 = (nb0 / na0).toFloat(); b1 = (nb1 / na0).toFloat(); b2 = (nb2 / na0).toFloat()
        a1 = (na1 / na0).toFloat(); a2 = (na2 / na0).toFloat()
    }

    fun run(x: Float): Float {
        val y = b0 * x + z1
        z1 = b1 * x - a1 * y + z2
        z2 = b2 * x - a2 * y
        return y
    }

    companion object {
        const val LP = 0
        const val HP = 1
        const val PEAK = 2
        const val LOW_SHELF = 3
    }
}

/**
 * 지연선 두 개를 번갈아 읽는 음높이 바꾸기 (지연이 짧아 통화에 쓸 수 있다).
 * ratio > 1 이면 높게, < 1 이면 낮게
 */
private class PitchShifter(sr: Int, private val ratio: Float) {
    private val size = 8192
    private val mask = size - 1
    private val buf = FloatArray(size)
    private var w = 0
    private val window = Math.max(256f, sr * 0.035f)
    private var phase = 0f
    private val step = (1f - ratio) / window

    private fun tap(d: Float): Float {
        val pos = w - 1 - d
        val i = Math.floor(pos.toDouble()).toInt()
        val frac = pos - i
        val a = buf[i and mask]
        val b = buf[(i + 1) and mask]
        return a + (b - a) * frac
    }

    fun run(x: Float): Float {
        buf[w] = x
        val p2 = (phase + 0.5f) % 1f
        val g1 = Math.sin(Math.PI * phase).toFloat()
        val g2 = Math.sin(Math.PI * p2).toFloat()
        val y = tap(phase * window) * g1 * g1 + tap(p2 * window) * g2 * g2
        phase += step
        if (phase >= 1f) phase -= 1f
        if (phase < 0f) phase += 1f
        w = (w + 1) and mask
        return y
    }
}

/** 채널 하나의 처리 사슬 */
private class Chain(val kind: String, sr: Int) {
    private val pitch: PitchShifter? = when (kind) {
        "girl" -> PitchShifter(sr, 1.45f)
        "deep" -> PitchShifter(sr, 0.72f)
        "baby" -> PitchShifter(sr, 1.85f)
        "mommy" -> PitchShifter(sr, 1.22f)
        else -> null
    }
    private val filters: Array<Biquad> = when (kind) {
        "girl" -> arrayOf(Biquad(Biquad.HP, sr.toFloat(), 160f), Biquad(Biquad.PEAK, sr.toFloat(), 3000f, 1f, 3f))
        "deep" -> arrayOf(Biquad(Biquad.LOW_SHELF, sr.toFloat(), 220f, 0.707f, 6f), Biquad(Biquad.LP, sr.toFloat(), 7000f))
        "baby" -> arrayOf(Biquad(Biquad.HP, sr.toFloat(), 260f), Biquad(Biquad.LP, sr.toFloat(), 6500f))
        // 엄마 목소리: 조금만 높이고, 따뜻하게(400 Hz 언저리), 부드럽게(높은 쪽을 살짝 깎는다)
        "mommy" -> arrayOf(Biquad(Biquad.HP, sr.toFloat(), 120f), Biquad(Biquad.PEAK, sr.toFloat(), 420f, 0.9f, 3f), Biquad(Biquad.PEAK, sr.toFloat(), 3500f, 1f, -2f), Biquad(Biquad.LP, sr.toFloat(), 7500f))
        // 싸구려 마이크: 전화기 대역(300 Hz ~ 3.4 kHz) 만 남긴다. 이 대역에 말소리가 다 들어 있어서 찢어져도 말은 들린다.
        // 1 kHz(코맹맹이)와 2.8 kHz(자음이 또렷해지는 곳)를 키운다
        "bad" -> arrayOf(
            Biquad(Biquad.HP, sr.toFloat(), 300f), Biquad(Biquad.HP, sr.toFloat(), 300f),
            Biquad(Biquad.LP, sr.toFloat(), 3400f), Biquad(Biquad.LP, sr.toFloat(), 3400f),
            Biquad(Biquad.PEAK, sr.toFloat(), 1000f, 1.0f, 5f),
            Biquad(Biquad.PEAK, sr.toFloat(), 2800f, 1.2f, 4f),
        )
        else -> emptyArray()
    }
    private var hold = 0f
    private var holdLeft = 0
    private var env = 0f

    fun run(x0: Float): Float {
        var x = pitch?.run(x0) ?: x0
        for (f in filters) x = f.run(x)
        if (kind == "bad") {
            // 말할 때만 키운다: 조용할 때 키우면 잡음만 커진다 (노이즈 게이트)
            val ax = Math.abs(x)
            env = if (ax > env) env + (ax - env) * 0.02f else env * 0.9995f
            val gate = Math.min(1f, Math.max(0f, (env - 0.006f) / 0.015f))
            // 아주 세게 키워서 찢어지게: 거의 모든 소리가 최대 크기로 눌려서 시끄럽다
            x = Math.tanh((x * 28f).toDouble()).toFloat() * 0.97f
            // 살짝 거친 디지털 느낌 (말을 가리지 않을 만큼만)
            if (holdLeft <= 0) {
                hold = Math.round(x * 96f) / 96f
                holdLeft = 2
            }
            holdLeft--
            x = hold * gate
        }
        return x
    }
}

private class State(val kind: String, val sr: Int, val ch: Int) {
    val chains = Array(Math.max(1, ch)) { Chain(kind, sr) }
}

private val states = WeakHashMap<AudioRecord, State>()

private fun stateOf(rec: AudioRecord): State? {
    val kind = voice
    if (kind == "off") return null
    val sr = try { rec.sampleRate } catch (_: Throwable) { 48000 }
    val ch = try { rec.channelCount } catch (_: Throwable) { 1 }
    synchronized(states) {
        val s = states[rec]
        if (s != null && s.kind == kind && s.sr == sr && s.ch == ch) return s
        val n = State(kind, sr, ch)
        states[rec] = n
        return n
    }
}

private fun clamp(v: Float) = if (v > 1f) 1f else if (v < -1f) -1f else v

/** 16 비트 소리 (ByteBuffer) */
private fun runBytes16(st: State, buf: ByteBuffer, start: Int, bytes: Int) {
    val b = buf.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    var i = start
    var c = 0
    val end = Math.min(start + bytes, b.limit()) - 1
    while (i < end) {
        val x = b.getShort(i) / 32768f
        val y = clamp(st.chains[c].run(x))
        b.putShort(i, (y * 32767f).toInt().toShort())
        c = (c + 1) % st.chains.size
        i += 2
    }
}

private fun runBytesFloat(st: State, buf: ByteBuffer, start: Int, bytes: Int) {
    val b = buf.duplicate().order(ByteOrder.nativeOrder())
    var i = start
    var c = 0
    val end = Math.min(start + bytes, b.limit()) - 3
    while (i < end) {
        b.putFloat(i, clamp(st.chains[c].run(b.getFloat(i))))
        c = (c + 1) % st.chains.size
        i += 4
    }
}

private fun runShorts(st: State, a: ShortArray, off: Int, n: Int) {
    var c = 0
    for (i in off until Math.min(a.size, off + n)) {
        a[i] = (clamp(st.chains[c].run(a[i] / 32768f)) * 32767f).toInt().toShort()
        c = (c + 1) % st.chains.size
    }
}

private fun runFloats(st: State, a: FloatArray, off: Int, n: Int) {
    var c = 0
    for (i in off until Math.min(a.size, off + n)) {
        a[i] = clamp(st.chains[c].run(a[i]))
        c = (c + 1) % st.chains.size
    }
}

private fun runByteArray16(st: State, a: ByteArray, off: Int, n: Int) {
    var c = 0
    var i = off
    val end = Math.min(a.size, off + n) - 1
    while (i < end) {
        val s = ((a[i].toInt() and 0xff) or (a[i + 1].toInt() shl 8)).toShort()
        val y = (clamp(st.chains[c].run(s / 32768f)) * 32767f).toInt()
        a[i] = (y and 0xff).toByte()
        a[i + 1] = ((y shr 8) and 0xff).toByte()
        c = (c + 1) % st.chains.size
        i += 2
    }
}

/** AudioRecord.read 의 모든 모양 뒤 */
private object AfterRead : XC_MethodHook() {
    /**
     * read(buf, size) 는 안에서 read(buf, size, READ_BLOCKING) 을 다시 부른다. 둘 다 걸려 있어서
     * 그냥 두면 같은 소리를 두 번 처리한다 (음높이 처리가 시간을 두 배로 먹어 지지직 소리만 남는다).
     * 그래서 가장 바깥 read 가 끝났을 때 한 번만 처리한다
     */
    private val depth = ThreadLocal<IntArray>()

    override fun beforeHookedMethod(param: MethodHookParam) {
        val d = depth.get() ?: IntArray(1).also { depth.set(it) }
        d[0]++
    }

    override fun afterHookedMethod(param: MethodHookParam) {
        val d = depth.get()
        if (d != null) {
            d[0]--
            if (d[0] > 0) return
        }
        try {
            val n = (param.result as? Int) ?: return
            if (n <= 0) return
            reads++
            val rec = param.thisObject as? AudioRecord ?: return
            val st = stateOf(rec) ?: return
            rate = st.sr
            channels = st.ch
            val fmt = try { rec.audioFormat } catch (_: Throwable) { AudioFormat.ENCODING_PCM_16BIT }
            format = fmt
            val a = param.args
            when (val target = a.getOrNull(0)) {
                is ByteBuffer -> {
                    val start = target.position()
                    if (fmt == AudioFormat.ENCODING_PCM_FLOAT) runBytesFloat(st, target, start, n) else runBytes16(st, target, start, n)
                }
                is ShortArray -> runShorts(st, target, a[1] as Int, n)
                is FloatArray -> runFloats(st, target, a[1] as Int, n)
                is ByteArray -> if (fmt != AudioFormat.ENCODING_PCM_8BIT) runByteArray16(st, target, a[1] as Int, n) else return
                else -> return
            }
            processed++
        } catch (t: Throwable) {
            lastError = t.toString()
        }
    }
}

val voiceChangerPlugin = plugin {
    var unhooks = emptySet<XC_MethodHook.Unhook>()

    start {
        try {
            unhooks = XposedBridge.hookAllMethods(AudioRecord::class.java, "read", AfterRead)
            hooked = unhooks.isNotEmpty()
        } catch (t: Throwable) {
            lastError = "hook: $t"
        }
        // 디스코드는 보통 마이크를 OpenSL ES (네이티브) 로 읽어서 위의 AudioRecord.read 를 거치지 않는다.
        // WebRTC 는 "저지연 입력을 지원하지 않는 폰" 이면 마이크만 자바 AudioRecord 로 읽는다
        // (kAndroidJavaInputAndOpenSLESOutputAudio). 그래서 지원하지 않는다고 답한다.
        // 디스코드가 음성 엔진을 만들 때 한 번 묻기 때문에, 플러그인을 켠 뒤 디스코드를 다시 켜야 적용된다
        try {
            val mgr = Class.forName("org.webrtc.audio.WebRtcAudioManager", false, classLoader)
            val u = XposedBridge.hookAllMethods(mgr, "isLowLatencyInputSupported", object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    javaInputForced = true
                    param.result = false
                }
            })
            unhooks = unhooks + u
            javaInputHook = u.isNotEmpty()
        } catch (t: Throwable) {
            lastError = "java input: $t"
        }

        registerNativeMethod("${manifest.id}.set") { args ->
            val v = (args.getOrNull(0) as? String)?.takeIf { it in setOf("off", "girl", "deep", "baby", "mommy", "bad") } ?: "off"
            voice = v
            synchronized(states) { states.clear() }
            true
        }
        registerNativeMethod("${manifest.id}.status") {
            JSONObject()
                .put("voice", voice)
                .put("hooked", hooked)
                .put("hooks", unhooks.size)
                .put("javaInputHook", javaInputHook)
                .put("javaInputForced", javaInputForced)
                .put("reads", reads)
                .put("processed", processed)
                .put("rate", rate)
                .put("channels", channels)
                .put("format", format)
                .put("error", lastError ?: JSONObject.NULL)
                .toString()
        }
    }

    stop {
        for (u in unhooks) try {
            u.unhook()
        } catch (_: Throwable) {
        }
        unhooks = emptySet()
        hooked = false
        voice = "off"
    }
}
