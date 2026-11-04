@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.intelligentcompression

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 디스코드가 파일을 준비하는 곳(MediaManagerModule.resolveToMediaFilePath, 그리고 compressVideo)을 네이티브에서 가로챈다.
 * (새 디스코드는 MediaManager 가 TurboModule 이라 JS 에서는 바꿀 수 없다)
 *
 *  1. 업로드 한도(JS 가 알려 준다) 안이면 → 원본 그대로 (allowOptimization=false, skipVideoTranscode=true)
 *  2. 넘으면 → 사진은 Images, 영상은 디스코드 변환기 + 길이로 계산한 비트레이트(encodingConfig), 소리는 Audio
 *  3. 그래도 안 되면 → 거부
 */
internal object Config {
    @Volatile
    var limit: Long = 10L * 1024 * 1024

    @Volatile
    var images = true

    @Volatile
    var videos = true

    /** "discord" = 디스코드 변환기, "avc" = 직접 H.264, "hevc" = 직접 H.265 */
    @Volatile
    var codec = "avc"
}

private class Rejected(val reason: String) : RuntimeException(reason)

/** 설정 화면에 보여 줄 진단 */
internal object Diag {
    @Volatile
    var calls = 0

    @Volatile
    var last = ""

    fun json(hooked: String): String {
        val o = org.json.JSONObject()
        o.put("hooked", hooked)
        o.put("calls", calls)
        o.put("last", last)
        o.put("limit", Config.limit)
        return o.toString()
    }
}

internal object Resolve {
    /** 우리가 원래 함수를 부를 때 붙이는 표시 (그건 가로채지 않는다) */
    const val MARK = "__intelligentCompression"

    @Volatile
    var loader: ClassLoader? = null

    @Volatile
    var resolveMethod: Method? = null

    /** 알림은 JS 가 가져가서 디스코드 토스트로 띄운다 (toasts 네이티브 함수) */
    val toasts = java.util.concurrent.ConcurrentLinkedQueue<String>()

    fun toast(text: String) {
        toasts.add(text)
        while (toasts.size > 20) toasts.poll()
    }

    fun takeToasts(): String {
        val a = org.json.JSONArray()
        while (true) {
            val t = toasts.poll() ?: break
            a.put(t)
        }
        return a.toString()
    }

    private fun fmt(b: Long): String {
        val mb = 1024.0 * 1024.0
        if (b >= mb) {
            val v = b / mb
            return if (v >= 100) "" + Math.round(v) + " MB" else "" + (Math.round(v * 10) / 10.0) + " MB"
        }
        return "" + Math.max(1L, Math.round(b / 1024.0)) + " KB"
    }

    // ── ReadableMap (JavaOnlyMap) 다루기 ─────────────────────────────────────
    private fun mapClass(): Class<*> = Class.forName("com.facebook.react.bridge.JavaOnlyMap", true, loader)

    /** 원래 옵션을 복사해서 고친 새 맵 */
    fun options(src: Any?, booleans: Array<Any>, encoding: Any?): Any {
        val c = mapClass()
        val readable = Class.forName("com.facebook.react.bridge.ReadableMap", true, loader)
        val m: Any = if (src != null) c.getMethod("deepClone", readable).invoke(null, src)!! else c.getConstructor().newInstance()
        val putBoolean = c.getMethod("putBoolean", String::class.java, java.lang.Boolean.TYPE)
        putBoolean.invoke(m, MARK, true)
        var i = 0
        while (i + 1 < booleans.size) {
            putBoolean.invoke(m, booleans[i] as String, booleans[i + 1] as Boolean)
            i += 2
        }
        if (encoding != null) c.getMethod("putMap", String::class.java, readable).invoke(m, "encodingConfig", encoding)
        else {
            try {
                c.getMethod("remove", String::class.java).invoke(m, "encodingConfig")
            } catch (_: Throwable) {
            }
        }
        return m
    }

    fun encodingConfig(w: Int, h: Int, fps: Double, bitrate: Int, rotation: Int): Any {
        val c = mapClass()
        val m = c.getConstructor().newInstance()
        val putInt = c.getMethod("putInt", String::class.java, Integer.TYPE)
        val putDouble = c.getMethod("putDouble", String::class.java, java.lang.Double.TYPE)
        putInt.invoke(m, "targetWidth", w)
        putInt.invoke(m, "targetHeight", h)
        putDouble.invoke(m, "frameRate", fps)
        putDouble.invoke(m, "keyFrameIntervalSeconds", 5.0)
        putInt.invoke(m, "targetBitrate", bitrate)
        c.getMethod("putBoolean", String::class.java, java.lang.Boolean.TYPE).invoke(m, "createHDR", false)
        putInt.invoke(m, "rotationDegrees", rotation)
        putInt.invoke(m, "progressUpdateGranularity", 1)
        return m
    }

    private fun hasMark(options: Any?): Boolean {
        if (options == null) return false
        return try {
            options.javaClass.getMethod("hasKey", String::class.java).invoke(options, MARK) == true
        } catch (_: Throwable) {
            false
        }
    }

    // ── 디스코드 원래 함수를 부르고 결과를 기다리기 ────────────────────────────
    private class Waiter : InvocationHandler {
        val latch = CountDownLatch(1)

        @Volatile
        var result: Any? = null

        @Volatile
        var error: String? = null

        override fun invoke(proxy: Any, method: Method, args: Array<Any?>?): Any? {
            val n = method.name
            if (n == "resolve") {
                result = if (args != null && args.size > 0) args[0] else null
                latch.countDown()
            } else if ((n as java.lang.String).startsWith("reject")) {
                val sb = StringBuilder()
                if (args != null) {
                    var i = 0
                    while (i < args.size) {
                        val a = args[i++]
                        if (a == null) continue
                        if (sb.length > 0) sb.append(": ")
                        sb.append(if (a is Throwable) (a.message ?: a.toString()) else a.toString())
                    }
                }
                error = if (sb.length > 0) sb.toString() else "rejected"
                latch.countDown()
            } else if (n == "hashCode") {
                return System.identityHashCode(proxy)
            } else if (n == "equals") {
                return args != null && args.size > 0 && args[0] === proxy
            } else if (n == "toString") {
                return "IntelligentCompressionPromise"
            }
            return null
        }
    }

    /** 원래 resolveToMediaFilePath 를 불러서 끝날 때까지 기다린다 (작업 스레드에서만) */
    fun callOriginal(module: Any, uri: String, options: Any): String {
        val m = resolveMethod ?: throw IllegalStateException("no resolve method")
        val promiseClass = m.parameterTypes[2]
        val w = Waiter()
        val promise = Proxy.newProxyInstance(promiseClass.classLoader, arrayOf(promiseClass), w)
        XposedBridge.invokeOriginalMethod(m, module, arrayOf(uri, options, promise))
        if (!w.latch.await(30, TimeUnit.MINUTES)) throw IllegalStateException("timed out")
        val e = w.error
        if (e != null) throw IllegalStateException(e)
        return w.result?.toString() ?: throw IllegalStateException("no result")
    }

    private fun resolvePromise(promise: Any, value: Any) {
        promise.javaClass.getMethod("resolve", Any::class.java).invoke(promise, value)
    }

    private fun rejectPromise(promise: Any, code: String, message: String) {
        try {
            promise.javaClass.getMethod("reject", String::class.java, String::class.java).invoke(promise, code, message)
        } catch (_: NoSuchMethodException) {
            val ifaces = promise.javaClass.interfaces
            var done = false
            var i = 0
            while (!done && i < ifaces.size) {
                try {
                    ifaces[i].getMethod("reject", String::class.java, String::class.java).invoke(promise, code, message)
                    done = true
                } catch (_: Throwable) {
                }
                i++
            }
        }
    }

    // ── 가로채기 ─────────────────────────────────────────────────────────────
    fun handle(param: XC_MethodHook.MethodHookParam) {
        val args = param.args
        if (args.size < 3) return
        val uri = args[0] as? String ?: return
        val options = args[1]
        val promise = args[2] ?: return
        if (hasMark(options)) return
        Diag.calls++
        Diag.last = "got " + uri
        val module = param.thisObject ?: return
        // 원래 함수는 건너뛰고 작업 스레드에서 직접 처리
        param.result = null
        val t = Thread(Job(module, uri, options, promise), "intelligent-compression-resolve")
        t.priority = Thread.NORM_PRIORITY - 1
        t.start()
    }

    private class Job(val module: Any, val uri: String, val options: Any?, val promise: Any) : Runnable {
        override fun run() {
            try {
                val out = work(module, uri, options)
                Diag.last = Diag.last + " → " + Files.size(out)
                resolvePromise(promise, out)
            } catch (r: Rejected) {
                Diag.last = Diag.last + " → rejected: " + r.reason
                toast(r.reason)
                rejectPromise(promise, "E_TOO_LARGE", "Intelligent Compression: " + r.reason)
            } catch (t: Throwable) {
                val msg = t.message ?: t.toString()
                Diag.last = Diag.last + " → error: " + msg
                toast("Intelligent Compression failed: " + msg)
                // 마지막 수단: 디스코드가 하던 대로
                try {
                    resolvePromise(promise, callOriginal(module, uri, options(options, arrayOf(), currentEncoding(options))))
                } catch (t2: Throwable) {
                    rejectPromise(promise, "E_FAILED", t2.message ?: t2.toString())
                }
            }
        }
    }

    private fun currentEncoding(options: Any?): Any? = try {
        if (options == null) null else options.javaClass.getMethod("getMap", String::class.java).invoke(options, "encodingConfig")
    } catch (_: Throwable) {
        null
    }

    private fun kindOf(mime: String?, name: String?): String {
        val m = ((mime ?: "") as java.lang.String).toLowerCase(java.util.Locale.ROOT) as java.lang.String
        val n = ((name ?: "") as java.lang.String).toLowerCase(java.util.Locale.ROOT) as java.lang.String
        if (m.equals("image/gif") || n.endsWith(".gif")) return "gif"
        if (m.startsWith("image/")) return "image"
        if (m.startsWith("video/")) return "video"
        if (n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".webp") || n.endsWith(".heic") || n.endsWith(".heif")) return "image"
        if (n.endsWith(".mp4") || n.endsWith(".mov") || n.endsWith(".m4v") || n.endsWith(".webm") || n.endsWith(".mkv") || n.endsWith(".3gp")) return "video"
        return "other"
    }

    fun work(module: Any, uri: String, options: Any?): String {
        val size = Files.size(uri)
        val kind = kindOf(Files.mime(uri), Files.name(uri))
        val limit = Config.limit
        Diag.last = kind + " " + size + " / limit " + limit
        val original = options(options, arrayOf("allowOptimization", false, "isLowQuality", false, "skipVideoTranscode", true), null)
        if (kind == "other" || (kind == "image" && !Config.images) || (kind == "video" && !Config.videos) || size <= 0) {
            return callOriginal(module, uri, options(options, arrayOf(), currentEncoding(options)))
        }
        // 1. 한도 안이면 원본 그대로
        if (size <= limit) {
            val out = callOriginal(module, uri, original)
            val outSize = Files.size(out)
            // HEIC 처럼 호환 형식으로 바뀌며 커질 수 있으니 한 번 더 본다
            if (outSize <= 0 || outSize <= limit) return out
        }
        // 2. 넘으면 거의 딱 맞게
        if (kind == "gif") throw Rejected("GIFs can't be compressed (" + fmt(size) + " > " + fmt(limit) + ")")
        if (kind == "image") {
            val r = try {
                Images.compress(uri, limit - 16 * 1024)
            } catch (e: IllegalStateException) {
                if (e.message == "too-big") throw Rejected("Can't fit in " + fmt(limit) + " even at the lowest quality")
                throw e
            }
            toast("Compressed " + fmt(size) + " → " + fmt(r.second))
            return adopt(module, r.first, options)
        }
        val out = video(module, uri, options, size, limit)
        toast("Compressed " + fmt(size) + " → " + fmt(Files.size(out)))
        return adopt(module, out, options)
    }

    /**
     * 우리가 만든 파일을 디스코드 자신의 준비 과정(원본 그대로 복사)에 한 번 더 통과시킨다.
     * 그러면 디스코드가 직접 만든 파일과 같은 곳·같은 모양이 되어 업로더가 그대로 받아 준다.
     */
    private fun adopt(module: Any, file: String, options: Any?): String {
        return try {
            val out = callOriginal(module, file, options(options, arrayOf("allowOptimization", false, "isLowQuality", false, "skipVideoTranscode", true, "useOriginalIfSmaller", false), null))
            Diag.last = Diag.last + ", adopted"
            out
        } catch (t: Throwable) {
            Diag.last = Diag.last + ", adopt failed: " + (t.message ?: t.toString())
            file
        }
    }

    // ── 영상 ─────────────────────────────────────────────────────────────────
    private const val MIN_VIDEO_BPS = 48_000.0
    private const val BITS_PER_PIXEL = 0.08
    private const val MIN_SHORT_SIDE = 144.0

    private class Meta {
        var durationMs = 0L
        var width = 0
        var height = 0
        var rotation = 0
        var fps = 30.0
        var totalBps = 0L
        var videoBps = 0L
        var audioBps = -1L
    }

    private fun meta(uri: String): Meta {
        val m = Meta()
        val r = MediaMetadataRetriever()
        try {
            val u = Uri.parse(uri)
            if (u.scheme == null || u.scheme == "file") r.setDataSource(u.path ?: uri) else r.setDataSource(Ctx.context, u)
            m.durationMs = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION))
            m.width = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)).toInt()
            m.height = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)).toInt()
            m.rotation = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)).toInt()
            m.totalBps = num(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE))
        } catch (_: Throwable) {
        } finally {
            try {
                r.release()
            } catch (_: Throwable) {
            }
        }
        // 트랙별 정보 (영상 프레임 수·비트레이트, 소리 비트레이트)
        try {
            val ex = MediaExtractor()
            val u = Uri.parse(uri)
            if (u.scheme == null || u.scheme == "file") ex.setDataSource(u.path ?: uri) else ex.setDataSource(Ctx.context!!, u, null)
            var i = 0
            while (i < ex.trackCount) {
                val f = ex.getTrackFormat(i++)
                val mime = (f.getString(MediaFormat.KEY_MIME) ?: "") as java.lang.String
                if (mime.startsWith("video/")) {
                    if (f.containsKey(MediaFormat.KEY_FRAME_RATE)) {
                        m.fps = try {
                            f.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble()
                        } catch (_: Throwable) {
                            f.getFloat(MediaFormat.KEY_FRAME_RATE).toDouble()
                        }
                    }
                    if (f.containsKey(MediaFormat.KEY_BIT_RATE)) m.videoBps = f.getInteger(MediaFormat.KEY_BIT_RATE).toLong()
                } else if (mime.startsWith("audio/")) {
                    if (f.containsKey(MediaFormat.KEY_BIT_RATE)) m.audioBps = f.getInteger(MediaFormat.KEY_BIT_RATE).toLong()
                    else if (m.audioBps < 0) m.audioBps = 0
                }
            }
            ex.release()
        } catch (_: Throwable) {
        }
        if (!(m.fps > 0) || m.fps > 240) m.fps = 30.0
        return m
    }

    private fun num(s: String?): Long = try {
        if (s == null) 0 else java.lang.Long.parseLong((s as java.lang.String).trim())
    } catch (_: Throwable) {
        0
    }

    private fun even16(v: Double): Int = Math.max(16, Math.round(v / 16.0).toInt() * 16)

    private fun video(module: Any, uri: String, options: Any?, size: Long, limit: Long): String {
        val m = meta(uri)
        val seconds = m.durationMs / 1000.0
        if (!(seconds > 0)) throw Rejected("Can't read the video length")
        // 소리 비트레이트: 트랙 정보 → 없으면 (전체 - 영상)으로 짐작
        var srcAudio = m.audioBps
        if (srcAudio < 0) srcAudio = 0
        else if (srcAudio == 0L) {
            val total = if (m.totalBps > 0) m.totalBps.toDouble() else size * 8.0 / seconds
            srcAudio = if (m.videoBps > 0) Math.max(0.0, total - m.videoBps).toLong() else 160_000
        }
        srcAudio = Math.min(srcAudio, 1_600_000)
        val srcVideo = if (m.videoBps > 0) m.videoBps.toDouble() else Math.max(0.0, (if (m.totalBps > 0) m.totalBps.toDouble() else size * 8.0 / seconds) - srcAudio)

        val target = limit * 0.97
        val totalBps = (target - 64 * 1024) * 8.0 / seconds
        // 소리 몫: 전체의 12% 정도 (24~128kbps). 원래 소리가 그보다 작으면 그대로 옮긴다
        val audioTarget = Math.round(Math.min(Math.max(totalBps * 0.12, 24_000.0), 128_000.0)).toInt()
        val reencodeAudio = srcAudio > audioTarget * 1.15
        var audioBps = if (reencodeAudio) audioTarget else srcAudio.toInt()
        var videoBps = totalBps - audioBps
        if (srcVideo > 0) videoBps = Math.min(videoBps, srcVideo)

        var best: String? = null
        var bestSize = 0L
        // 직접 인코딩 (설정): H.264 High / H.265. 기기가 못 하면 디스코드 변환기로
        var own: String? = if (Config.codec == "hevc") Encoder.HEVC else if (Config.codec == "avc") Encoder.AVC else null
        if (own == Encoder.HEVC && Encoder.encoderFor(Encoder.HEVC) == null) {
            toast("This device can't encode H.265 — using H.264")
            own = Encoder.AVC
        }
        if (own != null && Encoder.encoderFor(own) == null) own = null
        var attempt = 0
        while (attempt < 4) {
            if (videoBps < MIN_VIDEO_BPS) break
            val fps = if (videoBps < 300_000) Math.min(m.fps, 20.0) else if (videoBps < 2_000_000) Math.min(m.fps, 30.0) else Math.min(m.fps, 60.0)
            val w = if (m.width > 0) m.width.toDouble() else 1280.0
            val h = if (m.height > 0) m.height.toDouble() else 720.0
            // H.265 는 같은 비트레이트로 더 큰 화면을 감당한다
            val bpp = if (own == Encoder.HEVC) 0.035 else if (own == Encoder.AVC) 0.06 else BITS_PER_PIXEL
            var scale = Math.min(1.0, Math.sqrt(videoBps / (fps * bpp) / (w * h)))
            // H.265 는 원본 해상도를 더 오래 지킨다 (긴 변 2560 까지, 기기 인코더가 못 하면 Encoder.fit 이 줄인다)
            scale = Math.min(scale, (if (own == Encoder.HEVC) 2560.0 else 1920.0) / Math.max(w, h))
            scale = Math.max(scale, Math.min(1.0, MIN_SHORT_SIDE / Math.min(w, h)))
            var out: String? = null
            if (own != null) {
                try {
                    Diag.last = Diag.last + ", " + (if (own == Encoder.HEVC) "H.265" else "H.264") + " " + even16(w * scale) + "x" + even16(h * scale) + " " + Math.round(videoBps / 1000) + "k"
                    out = Encoder.encode(uri, Encoder.Plan(even16(w * scale), even16(h * scale), fps, Math.round(videoBps).toInt(), if (reencodeAudio) audioBps else 0, own))
                } catch (t: Throwable) {
                    toast("Own encoder failed (" + (t.message ?: t.toString()) + ") — using Discord's")
                    own = null
                }
            }
            if (out == null) {
                val enc = encodingConfig(even16(w * scale), even16(h * scale), fps, Math.round(videoBps).toInt(), m.rotation)
                out = callOriginal(module, uri, options(options, arrayOf("allowOptimization", true, "isLowQuality", false, "skipVideoTranscode", false, "useOriginalIfSmaller", false), enc))
                // 디스코드 변환기는 소리를 그대로 옮기므로 소리만 따로 줄인다
                if (reencodeAudio) {
                    try {
                        out = Audio.reencode(out, audioBps)
                    } catch (_: Throwable) {
                    }
                }
            }
            val outSize = Files.size(out!!)
            if (outSize <= 0) return out
            if (outSize <= limit) {
                if (outSize > bestSize) {
                    best = out
                    bestSize = outSize
                }
                if (outSize >= limit * 0.9 || (srcVideo > 0 && videoBps >= srcVideo)) return out
                if (attempt >= 2) return best!!
                videoBps = Math.min(videoBps * Math.min(target / outSize * 0.98, 2.0), if (srcVideo > 0) srcVideo else Double.MAX_VALUE)
            } else {
                videoBps *= target / outSize * 0.97
                if (videoBps < MIN_VIDEO_BPS * 2 && reencodeAudio) audioBps = 24_000
            }
            attempt++
        }
        if (best != null) return best
        throw Rejected("Too long to fit in " + fmt(limit) + " even at the lowest quality")
    }
}

/** resolveToMediaFilePath / compressVideo 앞에서 */
internal object OnResolve : XC_MethodHook() {
    override fun beforeHookedMethod(param: MethodHookParam) {
        try {
            Resolve.handle(param)
        } catch (t: Throwable) {
            Resolve.toast("Intelligent Compression failed: " + (t.message ?: t.toString()))
        }
    }
}
