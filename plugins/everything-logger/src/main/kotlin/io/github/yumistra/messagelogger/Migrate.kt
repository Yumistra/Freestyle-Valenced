package io.github.yumistra.messagelogger

import java.io.File

/**
 * Message Logger(예전 ID yumistra.message-logger)에서 옮겨 오기.
 * Valenced 저장 위치: files/valenced/plugins/storage/<슬롯>/<플러그인 ID>/
 * 같은 슬롯, 다른 슬롯 순서로 예전 플러그인 폴더를 찾아
 *  - 네이티브 파일(알림 기록, 알림 앱 기록)은 이쪽 폴더로 옮기고
 *  - JS 저장 파일(.json, 로그와 설정)의 내용을 돌려준다 (JS 가 합친다)
 */
internal object Migrate {
    const val OLD = "yumistra.message-logger"

    @Volatile
    var dir: File? = null

    fun run(): String {
        val mine = dir ?: return ""
        val slot = mine.parentFile ?: return ""
        val cands = ArrayList<File>()
        cands.add(File(slot, OLD))
        val slots = slot.parentFile?.listFiles()
        if (slots != null) {
            var i = 0
            while (i < slots.size) {
                val s = slots[i++]
                if (s.isDirectory && s != slot) cands.add(File(s, OLD))
            }
        }
        var i = 0
        while (i < cands.size) {
            val d = cands[i++]
            if (!d.isDirectory) continue
            moveNative(d, mine)
            val text = findJson(d, 0)
            if (text.isNotEmpty()) return text
        }
        return ""
    }

    private fun moveNative(from: File, to: File) {
        val names = arrayOf("pushed.jsonl", "companion.jsonl")
        var i = 0
        while (i < names.size) {
            val f = File(from, names[i++])
            if (!f.isFile) continue
            try {
                to.mkdirs()
                File(to, f.name).appendText(f.readText(Charsets.UTF_8), Charsets.UTF_8)
                f.delete()
            } catch (_: Throwable) {
            }
        }
    }

    /** 로그나 설정이 든 JSON 파일 (가장 큰 것) */
    private fun findJson(d: File, depth: Int): String {
        val files = d.listFiles() ?: return ""
        var best = ""
        var i = 0
        while (i < files.size) {
            val f = files[i++]
            val t = if (f.isDirectory && depth < 2) findJson(f, depth + 1) else if (f.isFile && f.name.endsWith(".json") && f.length() < 64L * 1024 * 1024) {
                try {
                    f.readText(Charsets.UTF_8)
                } catch (_: Throwable) {
                    ""
                }
            } else ""
            val js = t as java.lang.String
            if ((js.indexOf("\"logs\"") >= 0 || js.indexOf("\"settings\"") >= 0) && t.length > best.length) best = t
        }
        return best
    }
}

internal object RunMigrate : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = try {
        Migrate.run()
    } catch (t: Throwable) {
        "error: $t"
    }
}
