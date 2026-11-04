@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.intelligentcompression

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayList

/**
 * MP4 "fast start": moov(목차)를 파일 앞으로 옮긴다 (qt-faststart 와 같은 방식).
 * MediaMuxer 는 moov 를 맨 뒤에 쓰는데, 디스코드가 직접 만든 영상은 항상 앞에 있다(createMP4FastStartUri).
 * 업로드·미리보기 쪽이 앞에 있다고 기대할 수 있어서 똑같이 맞춘다.
 */
internal object FastStart {
    private class Atom(val type: String, val offset: Long, val size: Long)

    private fun type(b: ByteArray, at: Int): String = String(b, at, 4, Charsets_US_ASCII)

    private val Charsets_US_ASCII = java.nio.charset.Charset.forName("US-ASCII")

    /** 고친 새 파일 경로 (이미 앞에 있거나 못 읽으면 원래 경로) */
    fun apply(path: String): String {
        val src = File(path)
        val raf = RandomAccessFile(src, "r")
        val atoms = ArrayList<Atom>()
        try {
            val len = raf.length()
            var pos = 0L
            val head = ByteArray(16)
            while (pos + 8 <= len) {
                raf.seek(pos)
                raf.readFully(head, 0, 8)
                var size = ((head[0].toLong() and 0xff) shl 24) or ((head[1].toLong() and 0xff) shl 16) or ((head[2].toLong() and 0xff) shl 8) or (head[3].toLong() and 0xff)
                val t = type(head, 4)
                if (size == 1L) {
                    raf.readFully(head, 8, 8)
                    size = ByteBuffer.wrap(head, 8, 8).long
                } else if (size == 0L) {
                    size = len - pos
                }
                if (size < 8) return path
                atoms.add(Atom(t, pos, size))
                pos += size
            }
            var moov: Atom? = null
            var mdatIndex = -1
            var moovIndex = -1
            var i = 0
            while (i < atoms.size) {
                val a = atoms[i]
                if (a.type == "moov") {
                    moov = a
                    moovIndex = i
                }
                if (a.type == "mdat" && mdatIndex < 0) mdatIndex = i
                i++
            }
            if (moov == null || mdatIndex < 0 || moovIndex < mdatIndex) return path
            if (moov.size > Int.MAX_VALUE) return path
            val data = ByteArray(moov.size.toInt())
            raf.seek(moov.offset)
            raf.readFully(data)
            // moov 가 mdat 앞으로 가면 그 크기만큼 mdat 이 뒤로 밀린다 → 샘플 위치표(stco/co64)를 그만큼 고친다
            patch(ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN), 8, data.size, moov.size)

            val out = File(src.parentFile, "fs-" + src.name)
            val fos = FileOutputStream(out)
            try {
                val copy = ByteArray(1 shl 16)
                var j = 0
                while (j < atoms.size) {
                    val a = atoms[j]
                    if (j == mdatIndex) fos.write(data)
                    if (a.type != "moov") {
                        raf.seek(a.offset)
                        var left = a.size
                        while (left > 0) {
                            val n = raf.read(copy, 0, Math.min(copy.size.toLong(), left).toInt())
                            if (n < 0) break
                            fos.write(copy, 0, n)
                            left -= n
                        }
                    }
                    j++
                }
            } finally {
                fos.close()
            }
            raf.close()
            if (src.delete() && out.renameTo(src)) return path
            return out.absolutePath
        } catch (_: Throwable) {
            return path
        } finally {
            try {
                raf.close()
            } catch (_: Throwable) {
            }
        }
    }

    private fun patch(b: ByteBuffer, start: Int, end: Int, shift: Long) {
        var pos = start
        while (pos + 8 <= end) {
            val size = b.getInt(pos).toLong() and 0xffffffffL
            if (size < 8 || pos + size > end) return
            val t = String(byteArrayOf(b.get(pos + 4), b.get(pos + 5), b.get(pos + 6), b.get(pos + 7)), Charsets_US_ASCII)
            if (t == "trak" || t == "mdia" || t == "minf" || t == "stbl") {
                patch(b, pos + 8, (pos + size).toInt(), shift)
            } else if (t == "stco") {
                val count = b.getInt(pos + 12)
                var k = 0
                while (k < count) {
                    val at = pos + 16 + k * 4
                    val v = (b.getInt(at).toLong() and 0xffffffffL) + shift
                    b.putInt(at, v.toInt())
                    k++
                }
            } else if (t == "co64") {
                val count = b.getInt(pos + 12)
                var k = 0
                while (k < count) {
                    val at = pos + 16 + k * 8
                    b.putLong(at, b.getLong(at) + shift)
                    k++
                }
            }
            pos += size.toInt()
        }
    }

    /** file:// 주소면 고쳐서 같은 주소로 */
    fun applyUri(uri: String): String {
        val u = android.net.Uri.parse(uri)
        if (u.scheme != null && u.scheme != "file") return uri
        val p = u.path ?: return uri
        val r = apply(p)
        return if (r == p) uri else android.net.Uri.fromFile(File(r)).toString()
    }

    @Suppress("unused")
    private fun unused(f: FileInputStream) = f
}
