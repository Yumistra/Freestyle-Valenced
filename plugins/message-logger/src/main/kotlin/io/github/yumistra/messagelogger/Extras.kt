package io.github.yumistra.messagelogger

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore

/**
 * JS 가 부르는 것들:
 *  - notify: 지운 메시지 휴대폰 알림 (누르면 디스코드의 그 메시지로)
 *  - export: 로그 JSON 을 Download/MessageLogger 에 저장
 *  - takeCompanion: 알림 앱(디스코드가 꺼져 있을 때 기록하는 앱)이 보내 둔 기록 가져오기
 */
internal object Extras {
    const val CHANNEL = "message-logger-deleted"
    const val COMPANION_PACKAGE = "io.github.yumistra.discordwatch"
    const val COMPANION_ACTION = "io.github.yumistra.discordwatch.LOGS"

    @Volatile
    var companionFile: java.io.File? = null

    @Volatile
    var receiver: BroadcastReceiver? = null

    private var nextId = 0x4d4c0000

    fun notify(args: List<Any?>): Any? {
        val ctx = Tray.context ?: return "error: no context"
        val title = args.getOrNull(0)?.toString() ?: "Message deleted"
        val text = args.getOrNull(1)?.toString() ?: ""
        val url = args.getOrNull(2)?.toString() ?: ""
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Deleted messages", NotificationManager.IMPORTANCE_HIGH))
        }
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        val id = nextId++
        val pi = PendingIntent.getActivity(ctx, id, open, flags)
        val icon = ctx.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(ctx, CHANNEL) else android.app.Notification.Builder(ctx)
        b.setSmallIcon(icon).setContentTitle(title).setContentText(text).setStyle(android.app.Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(pi)
        return try {
            nm.notify("message-logger", id, b.build())
            "ok"
        } catch (t: Throwable) {
            "error: $t"
        }
    }

    fun export(args: List<Any?>): Any? {
        val ctx = Tray.context ?: return "error: no context"
        val name = args.getOrNull(0)?.toString() ?: "message-logger.json"
        val json = args.getOrNull(1)?.toString() ?: return "error: empty"
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues()
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MessageLogger")
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return "error: could not create the file"
            val out = ctx.contentResolver.openOutputStream(uri) ?: return "error: could not write the file"
            try {
                out.write(json.toByteArray(Charsets.UTF_8))
            } finally {
                out.close()
            }
            return "Download/MessageLogger/$name"
        }
        @Suppress("DEPRECATION")
        val dir = java.io.File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "MessageLogger")
        dir.mkdirs()
        val f = java.io.File(dir, name)
        f.writeText(json, Charsets.UTF_8)
        return f.absolutePath
    }

    /** 메시지 링크를 이 디스코드에서 연다 (알림을 눌렀을 때와 같이, 디스코드가 그 메시지로 간다) */
    fun openLink(args: List<Any?>): Any? {
        val ctx = Tray.context ?: return "error: no context"
        val url = args.getOrNull(0)?.toString() ?: return "error: no url"
        if (!url.startsWith("https://discord.com/channels/")) return "error: not a message link"
        return try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(ctx.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            "ok"
        } catch (t: Throwable) {
            "error: $t"
        }
    }

    fun takeCompanion(): Any? {
        val f = companionFile ?: return ""
        synchronized(this) {
            if (!f.exists()) return ""
            val text = f.readText(Charsets.UTF_8)
            f.delete()
            return text
        }
    }

    /** 알림 앱이 보낸 기록을 파일에 이어 쓴다 (JS 가 나중에 가져간다) */
    fun append(lines: String) {
        val f = companionFile ?: return
        synchronized(this) {
            f.appendText(if (lines.endsWith("\n")) lines else lines + "\n", Charsets.UTF_8)
        }
    }

    fun register(ctx: Context) {
        if (receiver != null) return
        val r = CompanionReceiver()
        val filter = IntentFilter(COMPANION_ACTION)
        filter.addAction(Companion.ACTION_STATUS)
        try {
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, filter, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(r, filter)
            receiver = r
        } catch (t: Throwable) {
            Diag.error = t.toString()
        }
    }

    fun unregister(ctx: Context?) {
        val r = receiver ?: return
        receiver = null
        try {
            ctx?.unregisterReceiver(r)
        } catch (_: Throwable) {
        }
    }
}

/** 알림 앱만 받는다 (안드로이드 14 부터는 보낸 앱을 확인할 수 있다) */
internal class CompanionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Build.VERSION.SDK_INT >= 34) {
            val from = sentFromPackage
            if (from != null && from != Extras.COMPANION_PACKAGE) return
        }
        if (intent.action == Companion.ACTION_STATUS) {
            val json = intent.getStringExtra("json") ?: return
            if (json.length < 100_000) Companion.status = json
            return
        }
        val lines = intent.getStringExtra("lines") ?: return
        if (lines.length > 4_000_000) return
        Extras.append(lines)
    }
}

internal object Notify : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Extras.notify(args)
}

internal object Export : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Extras.export(args)
}

internal object OpenLink : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Extras.openLink(args)
}

internal object TakeCompanion : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Extras.takeCompanion()
}
