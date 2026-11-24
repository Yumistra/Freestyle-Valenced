package io.github.yumistra.messagelogger

import android.app.ActivityOptions
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/**
 * 알림 앱(Discord Watch) 다루기. 앱은 화면이 없어서, 투명한 Activity 를 열어 명령을 보낸다
 * (디스코드가 앱을 볼 수 없어도 Activity 는 열 수 있다). 앱은 상태를 방송으로 돌려준다 (CompanionReceiver).
 *  companion(cmd, json): cmd = status | setup | deliver | clearToken | battery | uninstall | appInfo(앱 정보 화면, 여기서 연다), json = {"token","enabled","notify"} 중 보낼 것만
 *  돌려주는 값: "ok" | "missing"(앱 없음) | "error: ..."
 *  companionStatus(): 앱이 마지막으로 보낸 상태 JSON (없으면 "")
 */
internal object Companion {
    const val ACTIVITY = "io.github.yumistra.discordwatch.ControlActivity"
    const val ACTION_STATUS = "io.github.yumistra.discordwatch.STATUS"
    const val DELIVER = "io.github.yumistra.discordwatch.DELIVER"

    @Volatile
    var status: String = ""

    fun send(args: List<Any?>): Any? {
        val ctx = Tray.context ?: return "error: no context"
        val cmd = args.getOrNull(0)?.toString() ?: "status"
        // 디스코드가 화면 뒤로 가면 받기를 멈춘다.
        // 안드로이드는 화면 뒤에서 얼어 있는(frozen) 앱에 방송을 못 보내면 그 앱을 강제로 끈다
        // ("Can't deliver broadcast"). 앱이 몇 초마다 보내는 기록, 상태 때문에 디스코드가 꺼졌다
        if (cmd == "mute") {
            Extras.unregister(ctx)
            return "ok"
        }
        if (cmd == "listen") {
            Extras.register(ctx)
            // 그동안 쌓인 기록을 보내 달라고 한다 (1.1.5 부터. 화면을 띄우지 않는 방송)
            try {
                ctx.sendBroadcast(Intent(DELIVER).setPackage(Extras.COMPANION_PACKAGE))
            } catch (_: Throwable) {
            }
            return "ok"
        }
        // 앱 정보 화면 (예전 앱을 지울 때: 디스코드가 직접 지우기 창을 열 권한은 없다)
        if (cmd == "appInfo") {
            return try {
                ctx.startActivity(
                    Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:${Extras.COMPANION_PACKAGE}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                "ok"
            } catch (t: Throwable) {
                "error: $t"
            }
        }
        val i = Intent()
            .setClassName(Extras.COMPANION_PACKAGE, ACTIVITY)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            .putExtra("cmd", cmd)
        val raw = args.getOrNull(1)?.toString()
        if (!raw.isNullOrBlank()) {
            try {
                val o = JSONObject(raw)
                if (o.has("token")) i.putExtra("token", o.optString("token"))
                if (o.has("enabled")) i.putExtra("enabled", o.optBoolean("enabled"))
                if (o.has("notify")) i.putExtra("notify", o.optBoolean("notify"))
            } catch (t: Throwable) {
                return "error: $t"
            }
        }
        return try {
            // 앱이 연 쪽이 이 디스코드인지 확인할 수 있게 (안드로이드 14 부터)
            if (Build.VERSION.SDK_INT >= 34) ctx.startActivity(i, ActivityOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
            else ctx.startActivity(i)
            "ok"
        } catch (_: ActivityNotFoundException) {
            if (installed(ctx)) "outdated" else "missing"
        } catch (t: Throwable) {
            "error: $t"
        }
    }
}

/** 앱이 깔려 있는지 (디스코드가 볼 수 없으면 false 가 나올 수 있다) */
private fun installed(ctx: android.content.Context): Boolean = try {
    ctx.packageManager.getPackageInfo(Extras.COMPANION_PACKAGE, 0)
    true
} catch (_: Throwable) {
    false
}

internal object CompanionSend : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Companion.send(args)
}

internal object CompanionRead : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Companion.status
}
