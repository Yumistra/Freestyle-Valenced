@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.intelligentcompression

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.util.ArrayList
import java.util.concurrent.ConcurrentHashMap

/**
 * 디스코드 변환기는 영상만 다시 인코딩하고 소리는 그대로 옮긴다.
 * 그래서 변환이 끝난 파일의 소리만 AAC 로 다시 인코딩해서(목표 비트레이트), 영상은 그대로 복사해 새 MP4 로 묶는다.
 *  - 소리 트랙이 없으면 그대로 돌려준다
 *  - 낮은 비트레이트(56kbps 이하)면 모노로 합친다
 */
internal object Audio {
    private val jobs = ConcurrentHashMap<String, String>()
    private var seq = 0
    private const val TIMEOUT_US = 10_000L
    private const val AAC = "audio/mp4a-latm"

    fun start(uri: String, bitrate: Int): String {
        val id = synchronized(this) { "a" + (++seq) }
        jobs[id] = state("running", null, 0, null)
        val t = Thread(Worker(id, uri, bitrate), "intelligent-compression-audio")
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

    private class Worker(private val id: String, private val uri: String, private val bitrate: Int) : Runnable {
        override fun run() {
            try {
                val out = reencode(uri, bitrate)
                jobs[id] = state("done", out, Files.size(out), null)
            } catch (t: Throwable) {
                jobs[id] = state("error", null, 0, t.toString())
            }
        }
    }

    internal class Sample(val data: ByteArray, val pts: Long, val flags: Int)

    internal fun extractor(uri: String): MediaExtractor {
        val ex = MediaExtractor()
        val u = Uri.parse(uri)
        val scheme = u.scheme
        if (scheme == null || scheme == "file") ex.setDataSource(u.path ?: uri)
        else ex.setDataSource(Ctx.context ?: throw IllegalStateException("no context"), u, null)
        return ex
    }

    private fun mimeOf(f: MediaFormat): String = f.getString(MediaFormat.KEY_MIME) ?: ""

    fun reencode(uri: String, bitrate: Int): String {
        val probe = extractor(uri)
        var audioIdx = -1
        var videoIdx = -1
        var i = 0
        while (i < probe.trackCount) {
            val m = mimeOf(probe.getTrackFormat(i)) as java.lang.String
            if (m.startsWith("audio/") && audioIdx < 0) audioIdx = i
            if (m.startsWith("video/") && videoIdx < 0) videoIdx = i
            i++
        }
        if (audioIdx < 0) {
            probe.release()
            return uri
        }
        val audioFormat = probe.getTrackFormat(audioIdx)
        val videoFormat = if (videoIdx >= 0) probe.getTrackFormat(videoIdx) else null
        probe.release()

        // 1. 소리: 풀어서(PCM) 다시 AAC 로. 결과는 메모리에 모아 둔다 (목표 비트레이트라 작다)
        val encoded = ArrayList<Sample>()
        val outFormat = transcodeAudio(uri, audioIdx, audioFormat, bitrate, encoded)

        // 2. 묶기: 영상 그대로 + 새 소리
        val ctx = Ctx.context ?: throw IllegalStateException("no context")
        val dir = File(File(ctx.cacheDir, "intelligent-compression"), "" + System.currentTimeMillis())
        dir.mkdirs()
        var base = Files.name(uri) ?: "video"
        val dot = (base as java.lang.String).lastIndexOf('.'.code)
        if (dot > 0) base = base.substring(0, dot)
        val file = File(dir, base + ".mp4")
        val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        try {
            var vTrack = -1
            if (videoFormat != null) {
                if (videoFormat.containsKey("rotation-degrees")) {
                    try {
                        muxer.setOrientationHint(videoFormat.getInteger("rotation-degrees"))
                    } catch (_: Throwable) {
                    }
                }
                vTrack = muxer.addTrack(videoFormat)
            }
            val aTrack = muxer.addTrack(outFormat)
            muxer.start()
            val info = MediaCodec.BufferInfo()
            // 영상과 소리를 시간 순서로 섞어서 쓴다 (재생기가 처음부터 읽기 좋게)
            var ai = 0
            if (vTrack >= 0) {
                val ex = extractor(uri)
                ex.selectTrack(videoIdx)
                var size = 1 shl 20
                if (videoFormat!!.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) size = Math.max(size, videoFormat.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
                val buf = ByteBuffer.allocate(size)
                while (true) {
                    buf.clear()
                    val n = ex.readSampleData(buf, 0)
                    if (n < 0) break
                    val pts = ex.sampleTime
                    while (ai < encoded.size && encoded[ai].pts <= pts) {
                        writeAudio(muxer, aTrack, encoded[ai++], info)
                    }
                    info.set(0, n, pts, if ((ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                    muxer.writeSampleData(vTrack, buf, info)
                    ex.advance()
                }
                ex.release()
            }
            while (ai < encoded.size) writeAudio(muxer, aTrack, encoded[ai++], info)
            muxer.stop()
        } finally {
            try {
                muxer.release()
            } catch (_: Throwable) {
            }
        }
        return FastStart.applyUri(Uri.fromFile(file).toString())
    }

    internal fun writeAudio(muxer: MediaMuxer, track: Int, s: Sample, info: MediaCodec.BufferInfo) {
        info.set(0, s.data.size, s.pts, s.flags)
        muxer.writeSampleData(track, ByteBuffer.wrap(s.data), info)
    }

    internal fun transcodeAudio(uri: String, idx: Int, src: MediaFormat, bitrate: Int, out: ArrayList<Sample>): MediaFormat {
        val ex = extractor(uri)
        ex.selectTrack(idx)
        val decoder = MediaCodec.createDecoderByType(mimeOf(src))
        decoder.configure(src, null, null, 0)
        decoder.start()
        var encoder: MediaCodec? = null
        var encFormat: MediaFormat? = null
        var sampleRate = if (src.containsKey(MediaFormat.KEY_SAMPLE_RATE)) src.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100
        var inChannels = if (src.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) src.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 2
        var outChannels = 0
        val info = MediaCodec.BufferInfo()
        val encInfo = MediaCodec.BufferInfo()
        var inputDone = false
        var decodeDone = false
        var encodeDone = false
        // 인코더에 넣을 PCM (디코더 출력 크기와 인코더 입력 크기가 달라서 모아 두고 나눠 넣는다)
        var pending: ByteArray = ByteArray(0)
        var pendingOff = 0
        var framesIn = 0L
        var eosQueued = false
        try {
            var guard = 0L
            while (!encodeDone && guard++ < 50_000_000L) {
                // 디코더에 압축된 소리 넣기
                if (!inputDone) {
                    val ib = decoder.dequeueInputBuffer(TIMEOUT_US)
                    if (ib >= 0) {
                        val buf = decoder.getInputBuffer(ib)!!
                        val n = ex.readSampleData(buf, 0)
                        if (n < 0) {
                            decoder.queueInputBuffer(ib, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            decoder.queueInputBuffer(ib, 0, n, ex.sampleTime, 0)
                            ex.advance()
                        }
                    }
                }
                // 디코더에서 PCM 꺼내기 (인코더가 다 받아 갔을 때만)
                if (!decodeDone && pendingOff >= pending.size) {
                    val ob = decoder.dequeueOutputBuffer(info, TIMEOUT_US)
                    if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        val f = decoder.outputFormat
                        if (f.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        if (f.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) inChannels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    } else if (ob >= 0) {
                        if (encoder == null) {
                            outChannels = if (bitrate <= 56_000) 1 else Math.min(inChannels, 2)
                            val f = MediaFormat.createAudioFormat(AAC, sampleRate, outChannels)
                            f.setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                            f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                            f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1 shl 16)
                            val e = MediaCodec.createEncoderByType(AAC)
                            e.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                            e.start()
                            encoder = e
                        }
                        val buf = decoder.getOutputBuffer(ob)!!
                        val raw = ByteArray(info.size)
                        buf.position(info.offset)
                        buf.get(raw, 0, info.size)
                        pending = mix(raw, inChannels, outChannels)
                        pendingOff = 0
                        decoder.releaseOutputBuffer(ob, false)
                        if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) decodeDone = true
                    }
                }
                val enc = encoder
                if (enc == null) {
                    if (decodeDone) throw IllegalStateException("no audio decoded")
                    continue
                }
                // 인코더에 PCM 넣기
                if (!eosQueued && (pendingOff < pending.size || decodeDone)) {
                    val ib = enc.dequeueInputBuffer(TIMEOUT_US)
                    if (ib >= 0) {
                        val buf = enc.getInputBuffer(ib)!!
                        buf.clear()
                        val n = Math.min(buf.remaining(), pending.size - pendingOff)
                        val pts = framesIn * 1_000_000L / sampleRate
                        if (n > 0) {
                            buf.put(pending, pendingOff, n)
                            pendingOff += n
                            framesIn += (n / (2 * outChannels)).toLong()
                        }
                        val last = decodeDone && pendingOff >= pending.size
                        enc.queueInputBuffer(ib, 0, n, pts, if (last) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                        if (last) eosQueued = true
                    }
                }
                // 인코더에서 AAC 꺼내기
                val ob = enc.dequeueOutputBuffer(encInfo, TIMEOUT_US)
                if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    encFormat = enc.outputFormat
                } else if (ob >= 0) {
                    if ((encInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && encInfo.size > 0) {
                        val buf = enc.getOutputBuffer(ob)!!
                        val data = ByteArray(encInfo.size)
                        buf.position(encInfo.offset)
                        buf.get(data, 0, encInfo.size)
                        out.add(Sample(data, encInfo.presentationTimeUs, 0))
                    }
                    enc.releaseOutputBuffer(ob, false)
                    if ((encInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) encodeDone = true
                }
            }
        } finally {
            try {
                decoder.stop()
                decoder.release()
            } catch (_: Throwable) {
            }
            try {
                encoder?.stop()
                encoder?.release()
            } catch (_: Throwable) {
            }
            ex.release()
        }
        return encFormat ?: throw IllegalStateException("audio encoder gave no format")
    }

    /** 16비트 PCM 채널 맞추기 (모노로 합치기) */
    private fun mix(raw: ByteArray, inCh: Int, outCh: Int): ByteArray {
        if (inCh == outCh || inCh <= 0) return raw
        val frames = raw.size / (2 * inCh)
        val out = ByteArray(frames * 2 * outCh)
        var f = 0
        while (f < frames) {
            var c = 0
            while (c < outCh) {
                // outCh 가 1 이면 전부 평균, 2 면 앞 두 채널
                var sum = 0
                var n = 0
                var k = if (outCh == 1) 0 else c
                val end = if (outCh == 1) inCh else c + 1
                while (k < end) {
                    val p = (f * inCh + k) * 2
                    sum += ((raw[p + 1].toInt() shl 8) or (raw[p].toInt() and 0xff)).toShort().toInt()
                    n++
                    k++
                }
                val v = sum / Math.max(1, n)
                val q = (f * outCh + c) * 2
                out[q] = (v and 0xff).toByte()
                out[q + 1] = ((v shr 8) and 0xff).toByte()
                c++
            }
            f++
        }
        return out
    }
}
