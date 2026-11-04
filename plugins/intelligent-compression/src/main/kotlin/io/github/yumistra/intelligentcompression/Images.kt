@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.intelligentcompression

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

internal object Files {
    fun open(uri: String): InputStream? {
        val ctx = Ctx.context
        val u = Uri.parse(uri)
        val scheme = u.scheme
        if (scheme == null || scheme == "file") {
            val path = u.path ?: uri
            return FileInputStream(File(path))
        }
        return ctx?.contentResolver?.openInputStream(u)
    }

    fun size(uri: String): Long {
        val u = Uri.parse(uri)
        val scheme = u.scheme
        if (scheme == null || scheme == "file") return File(u.path ?: uri).length()
        val ctx = Ctx.context ?: return -1
        try {
            val fd = ctx.contentResolver.openAssetFileDescriptor(u, "r")
            if (fd != null) {
                val len = fd.length
                fd.close()
                if (len >= 0) return len
            }
        } catch (_: Throwable) {
        }
        try {
            val c = ctx.contentResolver.query(u, arrayOf(OpenableColumns.SIZE), null, null, null)
            if (c != null) {
                var len = -1L
                if (c.moveToFirst() && !c.isNull(0)) len = c.getLong(0)
                c.close()
                if (len >= 0) return len
            }
        } catch (_: Throwable) {
        }
        // 마지막 수단: 끝까지 읽어서 센다
        return try {
            val input = open(uri) ?: return -1
            val buf = ByteArray(1 shl 16)
            var total = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                total += n
            }
            input.close()
            total
        } catch (_: Throwable) {
            -1
        }
    }

    fun name(uri: String): String? {
        val u = Uri.parse(uri)
        val scheme = u.scheme
        if (scheme == null || scheme == "file") return File(u.path ?: uri).name
        val ctx = Ctx.context ?: return null
        return try {
            val c = ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null) ?: return null
            var n: String? = null
            if (c.moveToFirst() && !c.isNull(0)) n = c.getString(0)
            c.close()
            n
        } catch (_: Throwable) {
            null
        }
    }

    fun mime(uri: String): String? {
        val u = Uri.parse(uri)
        val scheme = u.scheme
        if (scheme != null && scheme != "file") {
            try {
                val t = Ctx.context?.contentResolver?.getType(u)
                if (t != null) return t
            } catch (_: Throwable) {
            }
        }
        val n = ((name(uri) ?: return null) as java.lang.String).toLowerCase(java.util.Locale.ROOT) as java.lang.String
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg"
        if (n.endsWith(".png")) return "image/png"
        if (n.endsWith(".webp")) return "image/webp"
        if (n.endsWith(".gif")) return "image/gif"
        if (n.endsWith(".heic") || n.endsWith(".heif")) return "image/heic"
        if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4"
        if (n.endsWith(".mov")) return "video/quicktime"
        if (n.endsWith(".webm")) return "video/webm"
        if (n.endsWith(".mkv")) return "video/x-matroska"
        return null
    }

    fun info(uri: String): String {
        val o = JSONObject()
        o.put("size", size(uri))
        o.put("mime", mime(uri) ?: "")
        o.put("name", name(uri) ?: "")
        return o.toString()
    }
}

/**
 * 사진을 목표 크기 이하에서 가장 좋은 화질로 (투명하면 WebP, 아니면 JPEG).
 * 1. 원래 크기 그대로 화질(quality)을 이분 탐색해 목표 이하 중 가장 큰 것
 * 2. 가장 낮은 화질로도 안 되면 크기를 줄여서 다시 (목표에 맞게 비율 계산)
 * 3. 아주 작게(긴 변 160px)까지 줄여도 안 되면 실패
 */
internal object Images {
    private val jobs = ConcurrentHashMap<String, String>()
    private var seq = 0

    private const val MIN_QUALITY = 35
    private const val MAX_QUALITY = 100
    private const val MAX_PIXELS = 24_000_000L
    private const val MIN_SIDE = 160

    fun start(uri: String, target: Long): String {
        val id = synchronized(this) { "j" + (++seq) }
        jobs[id] = state("running", null, 0, null)
        val t = Thread(Worker(id, uri, target), "intelligent-compression")
        t.priority = Thread.NORM_PRIORITY - 1
        t.start()
        return id
    }

    fun job(id: String): String {
        val s = jobs[id] ?: return state("error", null, 0, "unknown job")
        if ((s as java.lang.String).indexOf("\"running\"") < 0) jobs.remove(id)
        return s
    }

    private fun state(state: String, uri: String?, size: Long, error: String?): String {
        val o = JSONObject()
        o.put("state", state)
        if (uri != null) o.put("uri", uri)
        o.put("size", size)
        if (error != null) o.put("error", error)
        return o.toString()
    }

    private class Worker(private val id: String, private val uri: String, private val target: Long) : Runnable {
        override fun run() {
            try {
                val out = compress(uri, target)
                jobs[id] = state("done", out.first, out.second, null)
            } catch (t: Throwable) {
                jobs[id] = state("error", null, 0, t.message ?: t.toString())
            }
        }
    }

    private fun decode(uri: String): Bitmap {
        val bounds = BitmapFactory.Options()
        bounds.inJustDecodeBounds = true
        var input = Files.open(uri) ?: throw IllegalStateException("cannot open")
        BitmapFactory.decodeStream(input, null, bounds)
        input.close()
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IllegalStateException("not an image")
        var sample = 1
        while ((bounds.outWidth.toLong() / sample) * (bounds.outHeight.toLong() / sample) > MAX_PIXELS) sample *= 2
        val opts = BitmapFactory.Options()
        opts.inSampleSize = sample
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888
        input = Files.open(uri) ?: throw IllegalStateException("cannot open")
        val bmp = BitmapFactory.decodeStream(input, null, opts)
        input.close()
        if (bmp == null) throw IllegalStateException("cannot decode image")
        // 사진 방향(EXIF) 반영 — JPEG 로 다시 쓰면 방향 정보가 없어지므로 픽셀을 돌려 둔다
        var degrees = 0
        var flip = false
        try {
            val e = Files.open(uri)
            if (e != null) {
                val exif = ExifInterface(e)
                when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> degrees = 90
                    ExifInterface.ORIENTATION_ROTATE_180 -> degrees = 180
                    ExifInterface.ORIENTATION_ROTATE_270 -> degrees = 270
                    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> flip = true
                    ExifInterface.ORIENTATION_TRANSPOSE -> {
                        degrees = 90
                        flip = true
                    }
                    ExifInterface.ORIENTATION_TRANSVERSE -> {
                        degrees = 270
                        flip = true
                    }
                    ExifInterface.ORIENTATION_FLIP_VERTICAL -> {
                        degrees = 180
                        flip = true
                    }
                }
                e.close()
            }
        } catch (_: Throwable) {
        }
        var out = bmp
        if (degrees != 0 || flip) {
            val m = Matrix()
            if (flip) m.postScale(-1f, 1f)
            if (degrees != 0) m.postRotate(degrees.toFloat())
            out = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            if (out !== bmp) bmp.recycle()
        }
        return out
    }

    /** 정말 투명한 픽셀이 있는지 (PNG 는 불투명해도 알파 채널이 있는 경우가 많아서 직접 본다) */
    private fun transparent(bmp: Bitmap): Boolean {
        if (!bmp.hasAlpha()) return false
        val w = bmp.width
        val row = IntArray(w)
        var y = 0
        while (y < bmp.height) {
            bmp.getPixels(row, 0, w, 0, y, w, 1)
            var x = 0
            while (x < w) {
                if ((row[x] ushr 24) != 0xff) return true
                x++
            }
            y += 2
        }
        return false
    }

    @Suppress("DEPRECATION")
    private val WEBP: Bitmap.CompressFormat =
        if (android.os.Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP

    /** 투명한 사진은 WebP(투명 유지), 아니면 JPEG */
    private fun encode(bmp: Bitmap, quality: Int, webp: Boolean): ByteArray {
        val bytes = ByteArrayOutputStream(1 shl 20)
        bmp.compress(if (webp) WEBP else Bitmap.CompressFormat.JPEG, quality, bytes)
        return bytes.toByteArray()
    }

    /** 이 크기에서 target 이하 중 가장 높은 화질. 가장 낮은 화질로도 넘으면 null (그때 크기는 lowest 에) */
    private fun best(bmp: Bitmap, target: Long, lowest: LongArray, webp: Boolean): ByteArray? {
        val top = encode(bmp, MAX_QUALITY - 3, webp)
        if (top.size <= target) {
            // 거의 원본 화질로도 들어가면 100 까지 한 번 더 본다
            val full = encode(bmp, MAX_QUALITY, webp)
            return if (full.size <= target) full else top
        }
        val low = encode(bmp, MIN_QUALITY, webp)
        lowest[0] = low.size.toLong()
        if (low.size > target) return null
        var lo = MIN_QUALITY
        var hi = MAX_QUALITY - 3
        var bestBytes = low
        while (hi - lo > 1) {
            val mid = (lo + hi) / 2
            val b = encode(bmp, mid, webp)
            if (b.size <= target) {
                lo = mid
                bestBytes = b
            } else {
                hi = mid
            }
        }
        return bestBytes
    }

    fun compress(uri: String, target: Long): android.util.Pair<String, Long> {
        var bmp = decode(uri)
        val webp = transparent(bmp)
        val lowest = LongArray(1)
        var guard = 0
        while (guard++ < 12) {
            val bytes = best(bmp, target, lowest, webp)
            if (bytes != null) {
                bmp.recycle()
                return android.util.Pair(write(uri, bytes, if (webp) ".webp" else ".jpg"), bytes.size.toLong())
            }
            // 가장 낮은 화질로도 넘는다 → 넘친 만큼 크기를 줄인다 (파일 크기는 대략 픽셀 수에 비례)
            val ratio = Math.sqrt(target.toDouble() / lowest[0].toDouble()) * 0.97
            val w = Math.max(1, (bmp.width * ratio).toInt())
            val h = Math.max(1, (bmp.height * ratio).toInt())
            if (Math.max(w, h) < MIN_SIDE) {
                bmp.recycle()
                throw IllegalStateException("too-big")
            }
            val next = Bitmap.createScaledBitmap(bmp, w, h, true)
            if (next !== bmp) bmp.recycle()
            bmp = next
        }
        bmp.recycle()
        throw IllegalStateException("too-big")
    }

    private fun write(uri: String, bytes: ByteArray, ext: String): String {
        val ctx = Ctx.context ?: throw IllegalStateException("no context")
        // 파일 이름은 원래 이름 그대로 (.jpg/.webp), 겹치지 않게 폴더를 나눈다
        val dir = File(File(ctx.cacheDir, "intelligent-compression"), "" + System.currentTimeMillis())
        dir.mkdirs()
        var base = Files.name(uri) ?: "image"
        val dot = (base as java.lang.String).lastIndexOf('.'.code)
        if (dot > 0) base = base.substring(0, dot)
        val f = File(dir, base + ext)
        val out = FileOutputStream(f)
        out.write(bytes)
        out.close()
        return Uri.fromFile(f).toString()
    }
}
