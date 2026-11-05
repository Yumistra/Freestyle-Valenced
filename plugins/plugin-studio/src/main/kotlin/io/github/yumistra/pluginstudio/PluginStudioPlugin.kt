@file:JvmName("PluginStudioPlugin")
@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.pluginstudio

import android.content.ContentValues
import android.content.Context
import android.os.Build as AndroidBuild
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import app.valenced.plugins.PluginBuilder
import app.valenced.plugins.PluginScope
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Plugin Studio 네이티브 부분.
 *  - list(): 깔린 플러그인 목록 (JSON 배열: id, name, version, description, author, icon)
 *  - read(id): 깔린 플러그인 파일 (JSON: manifest 글자, script 경로와 글자, 나머지 파일은 base64)
 *  - save(fileName, entriesJson): zip 을 만들어 다운로드 폴더에 저장. entries = [{path, text} | {path, b64}]. 저장한 곳을 돌려준다
 * (람다 대신 객체로 써서 kotlin 표준 라이브러리 람다 클래스에 기대지 않는다)
 */
internal object Ctx {
    @Volatile
    var context: Context? = null
}

internal object Store {
    fun dist(): File? {
        val ctx = Ctx.context ?: return null
        return File(ctx.applicationInfo.dataDir + "/files/valenced/plugins/dist")
    }

    fun readBytes(f: File): ByteArray {
        val input = FileInputStream(f)
        try {
            val out = ByteArrayOutputStream()
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        } finally {
            input.close()
        }
    }

    fun text(f: File): String = java.lang.String(readBytes(f), "UTF-8").toString()

    fun list(): String {
        val out = JSONArray()
        val root = dist() ?: return out.toString()
        val dirs = root.listFiles() ?: return out.toString()
        var i = 0
        while (i < dirs.size) {
            val d = dirs[i++]
            if (!d.isDirectory) continue
            val mf = File(d, "manifest.json")
            if (!mf.isFile) continue
            try {
                val m = JSONObject(text(mf))
                val o = JSONObject()
                o.put("id", m.optString("id", d.name))
                o.put("name", m.optString("name", d.name))
                o.put("version", m.optString("version", ""))
                o.put("description", m.optString("description", ""))
                o.put("author", m.optString("author", ""))
                o.put("icon", m.optString("icon", ""))
                o.put("dir", d.name)
                out.put(o)
            } catch (_: Throwable) {
            }
        }
        return out.toString()
    }

    private fun collect(base: File, dir: File, prefix: String, skip: String, files: JSONObject) {
        val items = dir.listFiles() ?: return
        var i = 0
        while (i < items.size) {
            val f = items[i++]
            val rel = if (prefix.isEmpty()) f.name else prefix + "/" + f.name
            if (f.isDirectory) collect(base, f, rel, skip, files)
            else if (rel != "manifest.json" && rel != skip) files.put(rel, Base64.encodeToString(readBytes(f), Base64.NO_WRAP))
        }
    }

    fun read(dirName: String): String {
        val o = JSONObject()
        val root = dist() ?: return o.put("error", "no context").toString()
        val d = File(root, dirName)
        val mf = File(d, "manifest.json")
        if (!mf.isFile) return o.put("error", "not installed").toString()
        val manifestText = text(mf)
        val m = JSONObject(manifestText)
        val dist = m.optJSONObject("dist")
        val scriptPath = if (dist != null) dist.optString("script", "index.js") else "index.js"
        val sf = File(d, scriptPath)
        o.put("manifest", manifestText)
        o.put("scriptPath", scriptPath)
        o.put("script", if (sf.isFile) text(sf) else "")
        val files = JSONObject()
        collect(d, d, "", scriptPath, files)
        o.put("files", files)
        return o.toString()
    }

    fun save(fileName: String, entriesJson: String): String {
        val ctx = Ctx.context ?: return JSONObject().put("error", "no context").toString()
        val entries = JSONArray(entriesJson)
        var out: OutputStream? = null
        var where: String
        if (AndroidBuild.VERSION.SDK_INT >= 29) {
            val values = ContentValues()
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip")
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return JSONObject().put("error", "could not create the file").toString()
            out = ctx.contentResolver.openOutputStream(uri)
            where = "Download/" + fileName
        } else {
            val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir
            dir.mkdirs()
            val f = File(dir, fileName)
            out = FileOutputStream(f)
            where = f.absolutePath
        }
        if (out == null) return JSONObject().put("error", "could not open the file").toString()
        val zip = ZipOutputStream(out)
        try {
            var i = 0
            while (i < entries.length()) {
                val e = entries.getJSONObject(i++)
                val entry = ZipEntry(e.getString("path"))
                entry.time = 1577836800000L
                zip.putNextEntry(entry)
                if (e.has("b64")) zip.write(Base64.decode(e.getString("b64"), Base64.DEFAULT))
                else zip.write(java.lang.String(e.optString("text", "")).getBytes("UTF-8"))
                zip.closeEntry()
            }
        } finally {
            zip.close()
        }
        return JSONObject().put("where", where).toString()
    }
}

private object ListM : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = try { Store.list() } catch (t: Throwable) { "[]" }
}

private object ReadM : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = try { Store.read(args[0].toString()) } catch (t: Throwable) { JSONObject().put("error", t.toString()).toString() }
}

private object SaveM : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = try { Store.save(args[0].toString(), args[1].toString()) } catch (t: Throwable) { JSONObject().put("error", t.toString()).toString() }
}

private object KeepContext : Function1<Context, Unit> {
    override fun invoke(ctx: Context) {
        Ctx.context = ctx.applicationContext ?: ctx
    }
}

private object OnStart : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) {
        scope.withAppContext(KeepContext)
        scope.registerNativeMethod("yumistra.plugin-studio.list", ListM)
        scope.registerNativeMethod("yumistra.plugin-studio.read", ReadM)
        scope.registerNativeMethod("yumistra.plugin-studio.save", SaveM)
    }
}

private object Build : Function1<PluginBuilder, Unit> {
    override fun invoke(b: PluginBuilder) {
        b.start(OnStart)
    }
}

@Suppress("UNUSED")
val pluginStudioPlugin = plugin(Build)
