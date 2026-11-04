@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.intelligentcompression

import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.ArrayList

/**
 * 디스코드 변환기 대신 쓰는 영상 인코더 (설정에서 고른다).
 *  - H.264 High 프로필 / H.265(HEVC) Main, VBR, 키프레임 10초
 *  - 해상도 줄이기는 GPU 로 (디코더 → SurfaceTexture → GLES 로 원하는 크기에 그리기 → 인코더 입력 Surface)
 *  - 프레임 수 줄이기는 그릴 프레임만 골라서
 *  - 소리는 Audio 로 다시 인코딩하거나 그대로 복사
 * Android CTS 의 ExtractDecodeEditEncodeMuxTest 와 같은 구조.
 */
internal object Encoder {
    const val AVC = "video/avc"
    const val HEVC = "video/hevc"
    private const val TIMEOUT_US = 10_000L

    class Plan(
        val width: Int,
        val height: Int,
        val fps: Double,
        val bitrate: Int,
        /** 0 이하 = 소리 그대로 */
        val audioBitrate: Int,
        val mime: String,
    )

    /** 이 기기에 그 코덱 인코더가 있는지 (있으면 그 인코더 이름) */
    fun encoderFor(mime: String): MediaCodecInfo? {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
        var fallback: MediaCodecInfo? = null
        var i = 0
        while (i < list.size) {
            val c = list[i++]
            if (!c.isEncoder) continue
            val types = c.supportedTypes
            var j = 0
            while (j < types.size) {
                if ((types[j] as java.lang.String).equalsIgnoreCase(mime)) {
                    // 하드웨어 인코더 우선 (빠르다)
                    val n = (c.name as java.lang.String).toLowerCase(java.util.Locale.ROOT) as java.lang.String
                    val software = n.startsWith("omx.google.") || n.startsWith("c2.android.")
                    if (!software) return c
                    if (fallback == null) fallback = c
                }
                j++
            }
        }
        return fallback
    }

    /** 인코더가 못 하는 크기면 맞는 크기로 (비율 유지, 16의 배수) */
    fun fit(info: MediaCodecInfo, mime: String, w: Int, h: Int): IntArray {
        try {
            val caps = info.getCapabilitiesForType(mime).videoCapabilities
            var cw = w
            var ch = h
            var guard = 0
            while (!caps.isSizeSupported(cw, ch) && guard++ < 40) {
                cw = Math.max(16, ((cw * 0.9) / 16).toInt() * 16)
                ch = Math.max(16, ((ch * 0.9) / 16).toInt() * 16)
            }
            return intArrayOf(cw, ch)
        } catch (_: Throwable) {
            return intArrayOf(w, h)
        }
    }

    fun encode(uri: String, plan: Plan): String {
        val info = encoderFor(plan.mime) ?: throw IllegalStateException("no " + plan.mime + " encoder")
        val size = fit(info, plan.mime, plan.width, plan.height)

        // 트랙 찾기
        val probe = Audio.extractor(uri)
        var videoIdx = -1
        var audioIdx = -1
        var i = 0
        while (i < probe.trackCount) {
            val m = (probe.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: "") as java.lang.String
            if (m.startsWith("video/") && videoIdx < 0) videoIdx = i
            if (m.startsWith("audio/") && audioIdx < 0) audioIdx = i
            i++
        }
        if (videoIdx < 0) {
            probe.release()
            throw IllegalStateException("no video track")
        }
        val srcVideo = probe.getTrackFormat(videoIdx)
        val srcAudio = if (audioIdx >= 0) probe.getTrackFormat(audioIdx) else null
        probe.release()
        var rotation = 0
        if (srcVideo.containsKey("rotation-degrees")) rotation = srcVideo.getInteger("rotation-degrees")
        if (rotation == 0) {
            try {
                val r = android.media.MediaMetadataRetriever()
                val u = Uri.parse(uri)
                if (u.scheme == null || u.scheme == "file") r.setDataSource(u.path ?: uri) else r.setDataSource(Ctx.context, u)
                val s = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
                if (s != null) rotation = java.lang.Integer.parseInt((s as java.lang.String).trim())
                r.release()
            } catch (_: Throwable) {
            }
        }

        // 1. 소리 (먼저 메모리에: 목표 비트레이트라 작다)
        val audioSamples = ArrayList<Audio.Sample>()
        var audioFormat: MediaFormat? = null
        if (srcAudio != null) {
            // MP4 에 그대로 못 넣는 소리(AAC·Opus 가 아닌 것)는 다시 인코딩
            val am = srcAudio.getString(MediaFormat.KEY_MIME) ?: ""
            val audioBitrate = if (plan.audioBitrate > 0) plan.audioBitrate else if (am != "audio/mp4a-latm" && am != "audio/opus") 128_000 else 0
            if (audioBitrate > 0) {
                try {
                    audioFormat = Audio.transcodeAudio(uri, audioIdx, srcAudio, audioBitrate, audioSamples)
                } catch (_: Throwable) {
                    audioSamples.clear()
                    audioFormat = null
                }
            }
            if (audioFormat == null) {
                audioFormat = srcAudio
                copySamples(uri, audioIdx, srcAudio, audioSamples)
            }
        }

        // 2. 영상
        val ctx = Ctx.context ?: throw IllegalStateException("no context")
        val dir = File(File(ctx.cacheDir, "intelligent-compression"), "" + System.currentTimeMillis())
        dir.mkdirs()
        var base = Files.name(uri) ?: "video"
        val dot = (base as java.lang.String).lastIndexOf('.'.code)
        if (dot > 0) base = base.substring(0, dot)
        val file = File(dir, base + ".mp4")

        val format = MediaFormat.createVideoFormat(plan.mime, size[0], size[1])
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        format.setInteger(MediaFormat.KEY_BIT_RATE, plan.bitrate)
        format.setInteger(MediaFormat.KEY_FRAME_RATE, Math.max(1, Math.round(plan.fps).toInt()))
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
        try {
            val caps = info.getCapabilitiesForType(plan.mime)
            val enc = caps.encoderCapabilities
            if (enc.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)) {
                format.setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
            }
            // 가장 좋은 프로필: H.264 High / HEVC Main
            val want = if (plan.mime == AVC) MediaCodecInfo.CodecProfileLevel.AVCProfileHigh else MediaCodecInfo.CodecProfileLevel.HEVCProfileMain
            val pls = caps.profileLevels
            var k = 0
            while (k < pls.size) {
                if (pls[k].profile == want) {
                    format.setInteger(MediaFormat.KEY_PROFILE, want)
                    if (android.os.Build.VERSION.SDK_INT >= 23) format.setInteger(MediaFormat.KEY_LEVEL, pls[k].level)
                    break
                }
                k++
            }
        } catch (_: Throwable) {
        }

        val encoder = MediaCodec.createByCodecName(info.name)
        var configured = false
        try {
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            configured = true
        } catch (_: Throwable) {
        }
        if (!configured) {
            // 프로필·레벨을 못 받는 인코더면 빼고 다시
            format.removeKeySafe(MediaFormat.KEY_PROFILE)
            format.removeKeySafe(MediaFormat.KEY_LEVEL)
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }
        val input = InputSurface(encoder.createInputSurface())
        encoder.start()
        input.makeCurrent()
        val output = OutputSurface()

        val ex = Audio.extractor(uri)
        ex.selectTrack(videoIdx)
        val decoder = MediaCodec.createDecoderByType(srcVideo.getString(MediaFormat.KEY_MIME)!!)
        decoder.configure(srcVideo, output.surface, null, 0)
        decoder.start()

        val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        if (rotation != 0) muxer.setOrientationHint(rotation)
        var videoTrack = -1
        var audioTrack = -1
        var muxing = false
        var ai = 0
        val info2 = MediaCodec.BufferInfo()
        val audioInfo = MediaCodec.BufferInfo()
        val encInfo = MediaCodec.BufferInfo()
        val frameUs = 1_000_000.0 / Math.max(1.0, plan.fps)
        var nextUs = -1.0
        var inputDone = false
        var decodeDone = false
        var encodeDone = false
        try {
            var guard = 0L
            // 멈춤 방지: 30초 동안 아무 진전이 없으면 포기 (디스코드 변환기로 넘어간다)
            var progress = System.currentTimeMillis()
            while (!encodeDone && guard++ < 100_000_000L) {
                if (System.currentTimeMillis() - progress > 30_000) throw IllegalStateException("encoder stalled")
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
                if (!decodeDone) {
                    val ob = decoder.dequeueOutputBuffer(info2, TIMEOUT_US)
                    if (ob >= 0) {
                        progress = System.currentTimeMillis()
                        val pts = info2.presentationTimeUs
                        // 프레임 수 줄이기: 다음 차례가 된 프레임만 그린다
                        var render = info2.size > 0
                        if (render) {
                            if (nextUs < 0) nextUs = pts.toDouble()
                            if (pts + 1000 < nextUs) render = false else nextUs += frameUs
                            if (nextUs < pts) nextUs = pts + frameUs
                        }
                        decoder.releaseOutputBuffer(ob, render)
                        if (render) {
                            output.awaitNewImage()
                            output.drawImage()
                            input.setPresentationTime(pts * 1000)
                            input.swapBuffers()
                        }
                        if ((info2.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            encoder.signalEndOfInputStream()
                            decodeDone = true
                        }
                    }
                }
                // 인코더 출력 꺼내기
                var draining = true
                while (draining) {
                    val eb = encoder.dequeueOutputBuffer(encInfo, if (decodeDone) TIMEOUT_US else 0)
                    if (eb == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        draining = false
                    } else if (eb == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        videoTrack = muxer.addTrack(encoder.outputFormat)
                        if (audioFormat != null) audioTrack = muxer.addTrack(audioFormat)
                        muxer.start()
                        muxing = true
                    } else if (eb >= 0) {
                        progress = System.currentTimeMillis()
                        val buf = encoder.getOutputBuffer(eb)!!
                        if ((encInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) encInfo.size = 0
                        if (encInfo.size > 0 && muxing) {
                            // 소리를 시간 순서로 섞어 넣는다
                            while (audioTrack >= 0 && ai < audioSamples.size && audioSamples[ai].pts <= encInfo.presentationTimeUs) {
                                Audio.writeAudio(muxer, audioTrack, audioSamples[ai++], audioInfo)
                            }
                            buf.position(encInfo.offset)
                            buf.limit(encInfo.offset + encInfo.size)
                            muxer.writeSampleData(videoTrack, buf, encInfo)
                        }
                        encoder.releaseOutputBuffer(eb, false)
                        if ((encInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            encodeDone = true
                            draining = false
                        }
                    }
                }
            }
            if (muxing) {
                while (audioTrack >= 0 && ai < audioSamples.size) Audio.writeAudio(muxer, audioTrack, audioSamples[ai++], audioInfo)
                muxer.stop()
            } else {
                throw IllegalStateException("encoder produced nothing")
            }
        } finally {
            try {
                decoder.stop()
            } catch (_: Throwable) {
            }
            try {
                decoder.release()
            } catch (_: Throwable) {
            }
            try {
                encoder.stop()
            } catch (_: Throwable) {
            }
            try {
                encoder.release()
            } catch (_: Throwable) {
            }
            try {
                muxer.release()
            } catch (_: Throwable) {
            }
            try {
                ex.release()
            } catch (_: Throwable) {
            }
            output.release()
            input.release()
        }
        // 디스코드가 만든 영상처럼 목차(moov)를 앞으로
        return FastStart.applyUri(Uri.fromFile(file).toString())
    }

    /** 소리 그대로 복사용으로 압축된 샘플을 메모리에 */
    private fun copySamples(uri: String, idx: Int, f: MediaFormat, out: ArrayList<Audio.Sample>) {
        val ex = Audio.extractor(uri)
        ex.selectTrack(idx)
        var size = 1 shl 16
        if (f.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) size = Math.max(size, f.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
        val buf = ByteBuffer.allocate(size)
        while (true) {
            buf.clear()
            val n = ex.readSampleData(buf, 0)
            if (n < 0) break
            val data = ByteArray(n)
            buf.position(0)
            buf.get(data, 0, n)
            out.add(Audio.Sample(data, ex.sampleTime, 0))
            ex.advance()
        }
        ex.release()
    }

    private fun MediaFormat.removeKeySafe(key: String) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 29) this.removeKey(key)
        } catch (_: Throwable) {
        }
    }
}

/** 인코더 입력 Surface 에 그리기 위한 EGL (녹화용 설정) */
private class InputSurface(private val surface: Surface) {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE

    init {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        if (!EGL14.eglInitialize(display, version, 0, version, 1)) throw IllegalStateException("eglInitialize failed")
        val attribs = intArrayOf(
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            0x3142, 1, // EGL_RECORDABLE_ANDROID
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val num = IntArray(1)
        EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, num, 0)
        val config = configs[0] ?: throw IllegalStateException("no EGL config")
        context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        eglSurface = EGL14.eglCreateWindowSurface(display, config, surface, intArrayOf(EGL14.EGL_NONE), 0)
        if (eglSurface == EGL14.EGL_NO_SURFACE) throw IllegalStateException("eglCreateWindowSurface failed")
    }

    fun makeCurrent() {
        if (!EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) throw IllegalStateException("eglMakeCurrent failed")
    }

    fun swapBuffers() {
        EGL14.eglSwapBuffers(display, eglSurface)
    }

    fun setPresentationTime(ns: Long) {
        EGLExt.eglPresentationTimeANDROID(display, eglSurface, ns)
    }

    fun release() {
        try {
            if (display != EGL14.EGL_NO_DISPLAY) {
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                EGL14.eglDestroySurface(display, eglSurface)
                EGL14.eglDestroyContext(display, context)
                EGL14.eglReleaseThread()
                EGL14.eglTerminate(display)
            }
            surface.release()
        } catch (_: Throwable) {
        }
        display = EGL14.EGL_NO_DISPLAY
    }
}

/** 디코더가 그리는 SurfaceTexture. 새 프레임을 기다렸다가 인코더 크기에 맞게 그린다 */
private class OutputSurface : SurfaceTexture.OnFrameAvailableListener {
    private val thread = HandlerThread("intelligent-compression-frames")
    private val texture: SurfaceTexture
    val surface: Surface
    private val lock = Object()
    private var available = false
    private val render = TextureRender()

    init {
        thread.start()
        render.setup()
        texture = SurfaceTexture(render.textureId)
        if (android.os.Build.VERSION.SDK_INT >= 21) texture.setOnFrameAvailableListener(this, Handler(thread.looper))
        else texture.setOnFrameAvailableListener(this)
        surface = Surface(texture)
    }

    override fun onFrameAvailable(st: SurfaceTexture) {
        synchronized(lock) {
            available = true
            lock.notifyAll()
        }
    }

    fun awaitNewImage() {
        synchronized(lock) {
            val until = System.currentTimeMillis() + 5000
            while (!available) {
                val left = until - System.currentTimeMillis()
                if (left <= 0) throw IllegalStateException("frame wait timed out")
                lock.wait(left)
            }
            available = false
        }
        texture.updateTexImage()
    }

    fun drawImage() {
        render.draw(texture)
    }

    fun release() {
        try {
            surface.release()
            texture.release()
        } catch (_: Throwable) {
        }
        try {
            thread.quitSafely()
        } catch (_: Throwable) {
        }
    }
}

/** 외부 텍스처(디코더 프레임)를 화면 전체에 그리는 셰이더 */
private class TextureRender {
    var textureId = -1
    private var program = 0
    private var aPosition = 0
    private var aTexCoord = 0
    private var uMvp = 0
    private var uSt = 0
    private val st = FloatArray(16)
    private val mvp = FloatArray(16)
    private val vertices: FloatBuffer

    init {
        val data = floatArrayOf(
            // x, y, z, u, v
            -1f, -1f, 0f, 0f, 0f,
            1f, -1f, 0f, 1f, 0f,
            -1f, 1f, 0f, 0f, 1f,
            1f, 1f, 0f, 1f, 1f,
        )
        vertices = ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        vertices.put(data).position(0)
        android.opengl.Matrix.setIdentityM(mvp, 0)
        android.opengl.Matrix.setIdentityM(st, 0)
    }

    fun setup() {
        val vs = "uniform mat4 uMVPMatrix;\nuniform mat4 uSTMatrix;\nattribute vec4 aPosition;\nattribute vec4 aTextureCoord;\nvarying vec2 vTextureCoord;\nvoid main() {\n  gl_Position = uMVPMatrix * aPosition;\n  vTextureCoord = (uSTMatrix * aTextureCoord).xy;\n}\n"
        val fs = "#extension GL_OES_EGL_image_external : require\nprecision mediump float;\nvarying vec2 vTextureCoord;\nuniform samplerExternalOES sTexture;\nvoid main() {\n  gl_FragColor = texture2D(sTexture, vTextureCoord);\n}\n"
        program = link(vs, fs)
        aPosition = GLES20.glGetAttribLocation(program, "aPosition")
        aTexCoord = GLES20.glGetAttribLocation(program, "aTextureCoord")
        uMvp = GLES20.glGetUniformLocation(program, "uMVPMatrix")
        uSt = GLES20.glGetUniformLocation(program, "uSTMatrix")
        val tex = IntArray(1)
        GLES20.glGenTextures(1, tex, 0)
        textureId = tex[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR.toFloat())
        GLES20.glTexParameterf(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR.toFloat())
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    fun draw(texture: SurfaceTexture) {
        texture.getTransformMatrix(st)
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
        vertices.position(0)
        GLES20.glVertexAttribPointer(aPosition, 3, GLES20.GL_FLOAT, false, 20, vertices)
        GLES20.glEnableVertexAttribArray(aPosition)
        vertices.position(3)
        GLES20.glVertexAttribPointer(aTexCoord, 2, GLES20.GL_FLOAT, false, 20, vertices)
        GLES20.glEnableVertexAttribArray(aTexCoord)
        GLES20.glUniformMatrix4fv(uMvp, 1, false, mvp, 0)
        GLES20.glUniformMatrix4fv(uSt, 1, false, st, 0)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glFinish()
    }

    private fun compile(type: Int, src: String): Int {
        val s = GLES20.glCreateShader(type)
        GLES20.glShaderSource(s, src)
        GLES20.glCompileShader(s)
        val ok = IntArray(1)
        GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
        if (ok[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(s)
            GLES20.glDeleteShader(s)
            throw IllegalStateException("shader: " + log)
        }
        return s
    }

    private fun link(vs: String, fs: String): Int {
        val v = compile(GLES20.GL_VERTEX_SHADER, vs)
        val f = compile(GLES20.GL_FRAGMENT_SHADER, fs)
        val p = GLES20.glCreateProgram()
        GLES20.glAttachShader(p, v)
        GLES20.glAttachShader(p, f)
        GLES20.glLinkProgram(p)
        val ok = IntArray(1)
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
        if (ok[0] == 0) throw IllegalStateException("link: " + GLES20.glGetProgramInfoLog(p))
        return p
    }
}
