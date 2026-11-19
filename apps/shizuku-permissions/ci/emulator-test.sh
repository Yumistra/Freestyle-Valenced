#!/usr/bin/env bash
# 에뮬레이터에서 도우미 앱을 끝까지 써 본다: Shizuku 켜기, 가짜 디스코드로 열기, Shizuku 허락, 모두 허용, 결과 확인.
# 결과(스크린샷, 화면 구조, 로그, 확인 결과)는 $OUT 에 모은다.
set -u
APP=$1        # 도우미 앱 apk
FAKE=$2       # 가짜 디스코드 apk
SHIZUKU=$3    # Shizuku apk
OUT=$4
MGR=${5:-moe.shizuku.privileged.api}   # Shizuku 관리 앱 패키지 (Shevery: com.hamondev.shevery)
mkdir -p "$OUT"
FAILS=0
log() { echo "== $*" | tee -a "$OUT/steps.txt"; }
check() { # 이름, 명령. 명령이 성공하면 PASS
    if eval "$2" >> "$OUT/steps.txt" 2>&1; then echo "PASS $1" | tee -a "$OUT/result.txt"; else echo "FAIL $1" | tee -a "$OUT/result.txt"; FAILS=$((FAILS + 1)); fi
}
shot() { adb exec-out screencap -p > "$OUT/$1.png"; adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1; adb pull /sdcard/ui.xml "$OUT/$1.xml" > /dev/null 2>&1; }
# 화면 구조에서 글자가 맞는 것을 찾아 누른다
tap() {
    adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
    adb pull /sdcard/ui.xml /tmp/ui.xml > /dev/null 2>&1
    local xy
    xy=$(python3 - "$1" <<'PY'
import re, sys
pat = re.compile(sys.argv[1])
s = open('/tmp/ui.xml', encoding='utf-8').read()
for m in re.finditer(r'<node [^>]*>', s):
    n = m.group(0)
    t = re.search(r' text="([^"]*)"', n)
    if not t or not pat.search(t.group(1)):
        continue
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    x1, y1, x2, y2 = map(int, b.groups())
    print((x1 + x2) // 2, (y1 + y2) // 2)
    break
PY
)
    if [ -z "$xy" ]; then log "tap: '$1' not found"; return 1; fi
    log "tap '$1' at $xy"
    adb shell input tap $xy
}
# 목록을 내리며 글자를 찾는다
find_text() {
    for i in 1 2 3 4 5 6 7 8 9 10; do
        adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
        adb pull /sdcard/ui.xml /tmp/ui.xml > /dev/null 2>&1
        grep -q "$1" /tmp/ui.xml && return 0
        adb shell input swipe $X $Y1 $X $Y2 300
        sleep 1
    done
    return 1
}
# 맨 위로 올린 뒤 찾는다
find_text_top() {
    for i in 1 2 3 4 5 6 7 8 9 10; do adb shell input swipe $X $Y2 $X $Y1 200; done
    find_text "$1"
}
# 글자 다음에 오는 스위치가 켜져 있는지 (/tmp/ui.xml)
switch_on() {
    python3 - "$1" <<'PY'
import re, sys
s = open('/tmp/ui.xml', encoding='utf-8').read()
i = s.find(sys.argv[1])
m = re.search(r'<node [^>]*class="android.widget.Switch"[^>]*>', s[i:]) if i >= 0 else None
raise SystemExit(0 if m and 'checked="true"' in m.group(0) else 1)
PY
}
granted() { adb shell dumpsys package com.discord | grep -E "$1: granted=true" > /dev/null; }

adb logcat -c
# 화면 크기에 맞춰 내리기 좌표
read W H < <(adb shell wm size | tr -d '\r' | sed -n 's/.*: \([0-9]*\)x\([0-9]*\)/\1 \2/p' | tail -1)
X=$((W / 2)); Y1=$((H * 8 / 10)); Y2=$((H * 3 / 10))
echo "screen $W x $H" >> "$OUT/steps.txt"
log "install"
adb install -r -g "$SHIZUKU" | tee -a "$OUT/steps.txt"
adb install -r "$APP" | tee -a "$OUT/steps.txt"
adb install -r "$FAKE" | tee -a "$OUT/steps.txt"

log "start Shizuku"
adb shell monkey -p $MGR -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 6
DIR=$(adb shell pm path $MGR | head -1 | tr -d '\r' | sed 's/^package://; s/base.apk$//')
adb shell ls -R "$DIR" >> "$OUT/steps.txt" 2>&1
STARTER=$(adb shell "ls $DIR/lib/*/lib*.so 2>/dev/null" | tr -d '\r' | grep -iE 'shizuku|shevery|starter' | head -1)
if [ -n "$STARTER" ]; then adb shell "$STARTER" >> "$OUT/steps.txt" 2>&1; else adb shell sh /sdcard/Android/data/$MGR/start.sh >> "$OUT/steps.txt" 2>&1; fi
sleep 6
adb shell ps -A | grep -iE 'shizuku|shevery' >> "$OUT/steps.txt"
check "shizuku server running" "adb shell ps -A | grep -iE 'shizuku_server|shevery_server|shizuku|shevery' | grep -v $MGR\$"
adb shell am force-stop $MGR

log "home screen has no icon"
check "no launcher entry" "! adb shell cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep -q shizukuperms"

log "open from the shell (not Discord)"
adb shell am start -W -a android.intent.action.VIEW -d freestyleperms://open > /dev/null
sleep 3
shot 01-from-shell
check "shell sees only the message" "grep -q 'Open this from the Shizuku Permissions plugin' '$OUT/01-from-shell.xml' && ! grep -q 'Camera' '$OUT/01-from-shell.xml' && ! grep -qi 'text=\"grant all\"' '$OUT/01-from-shell.xml'"
adb shell am force-stop io.github.yumistra.shizukuperms

log "open with a faked referrer"
adb shell am start -W -a android.intent.action.VIEW -d freestyleperms://open --es android.intent.extra.REFERRER_NAME android-app://com.discord > /dev/null
sleep 3
shot 02-fake-referrer
check "faked referrer is ignored" "grep -q 'Open this from the Shizuku Permissions plugin' '$OUT/02-fake-referrer.xml'"
adb shell am force-stop io.github.yumistra.shizukuperms

log "open from fake Discord"
adb shell am start -W -n com.discord/com.discord.main.MainActivity > /dev/null
sleep 4
shot 03-from-discord
check "shows Discord's list" "grep -q 'com.discord' '$OUT/03-from-discord.xml' && grep -q 'Special access' '$OUT/03-from-discord.xml'"

log "allow Shizuku"
tap '(?i)^allow shizuku$'
sleep 3
shot 04-shizuku-dialog
tap '(?i)^(allow all the time|allow|always allow|grant)$'
sleep 4
shot 05-ready
check "Shizuku ready" "grep -q 'Shizuku ready' '$OUT/05-ready.xml'"

log "grant all"
tap '(?i)^grant all$'
sleep 10
shot 06-granted
check "camera granted" "granted android.permission.CAMERA"
check "notifications granted" "granted android.permission.POST_NOTIFICATIONS"
check "read logs (development) granted" "granted android.permission.READ_LOGS"
check "overlay appop allowed" "adb shell appops get com.discord SYSTEM_ALERT_WINDOW | grep -q allow"
check "battery whitelist" "adb shell dumpsys deviceidle whitelist | grep -q com.discord"
check "background allowed" "adb shell appops get com.discord RUN_ANY_IN_BACKGROUND | grep -q allow"
adb shell dumpsys notification | grep -n -i -B2 -A2 "discord" > "$OUT/dnd-dump.txt" 2>&1
check "DND access" "adb shell dumpsys notification | grep -A12 -i 'Allowed condition providers' | grep -q com.discord"
check "DND shown as on" "find_text_top 'Do Not Disturb access' && switch_on 'Do Not Disturb access'"
adb shell dumpsys package com.discord | sed -n '/requested permissions/,/User 0/p' > "$OUT/dumpsys-perms.txt" 2>&1
adb shell appops get com.discord > "$OUT/appops.txt" 2>&1
for op in MANAGE_EXTERNAL_STORAGE WRITE_SETTINGS SCHEDULE_EXACT_ALARM REQUEST_INSTALL_PACKAGES; do echo "$op: $(adb shell appops get com.discord $op | tr -d '\r')" >> "$OUT/appops-special.txt"; done
adb shell settings get secure enabled_notification_policy_access_packages >> "$OUT/appops-special.txt"
adb logcat -d -s ShizukuPerms > "$OUT/commands.txt"

log "all groups are shown"
check "not kept items are explained" "find_text \"didn't keep this\""
for i in 1 2 3 4 5 6 7 8 9 10; do adb shell input swipe $X $Y2 $X $Y1 200; done
check "unknown permission is listed" "find_text 'UNKNOWN_PERMISSION'"
check "signature permission is listed" "find_text 'INSTALL_PACKAGES'"
check "unavailable items are listed" "find_text 'Not available for Discord'"
for i in 1 2 3 4 5 6 7 8 9 10; do adb shell input swipe $X $Y2 $X $Y1 200; done

log "turn camera off with its switch"
find_text 'text="Camera"'
# 카메라 줄의 스위치: 화면 구조에서 Camera 다음의 스위치
adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
adb pull /sdcard/ui.xml /tmp/ui.xml > /dev/null 2>&1
XY=$(python3 - <<'PY'
import re
s = open('/tmp/ui.xml', encoding='utf-8').read()
i = s.find('text="Camera"')
m = re.search(r'class="android.widget.Switch"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', s[i:]) if i >= 0 else None
if m:
    x1, y1, x2, y2 = map(int, m.groups())
    print((x1 + x2) // 2, (y1 + y2) // 2)
PY
)
if [ -n "$XY" ]; then adb shell input tap $XY; sleep 4; fi
shot 07-camera-off
check "camera revoked" "! granted android.permission.CAMERA"

log "back to Discord"
for i in 1 2 3 4 5 6 7 8 9 10; do adb shell input swipe $X $Y2 $X $Y1 200; done
tap '(?i)^back$'
sleep 2
adb shell dumpsys activity activities | grep -E "topResumedActivity|ResumedActivity" >> "$OUT/steps.txt"
check "back returns to Discord" "adb shell dumpsys activity activities | grep 'topResumedActivity' | grep -q com.discord"

adb logcat -d > "$OUT/logcat.txt"
check "no crash" "! grep -E 'FATAL EXCEPTION' -A5 '$OUT/logcat.txt' | grep -q shizukuperms"
echo "fails: $FAILS" | tee -a "$OUT/result.txt"
exit 0
