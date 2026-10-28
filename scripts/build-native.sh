#!/usr/bin/env bash
# 네이티브(Kotlin) 부분이 있는 플러그인(plugins/<이름>/src/main)을 plugin.jar 로 빌드한다.
# GitHub Actions 에서 돌린다. Valenced API 는 GitHub Packages 에 있어서 토큰이 필요하니,
# 대신 Valenced 소스에서 API(core + android api)를 직접 빌드해 로컬 Maven 에 올린다.
#   결과: plugins/<이름>/build/plugin.jar
set -euo pipefail

VALENCED_REF=706dae437058922a10246a1df0a614328db79a5c   # Valenced/valenced 1.2.1 (api 1.0.0)
TEMPLATE_REF=9a4f9187137a75d86fe552d0e594889a6e6fd7e5   # Valenced/valenced-plugin-template
TEMPLATE_REPO=Valenced/valenced-plugin-template

ROOT=$(pwd)
NATIVES=()
for d in plugins/*/; do
    [ -d "$d/src/main" ] && NATIVES+=("$(basename "$d")")
done
if [ ${#NATIVES[@]} -eq 0 ]; then
    echo "네이티브 플러그인 없음"
    exit 0
fi
echo "네이티브 플러그인: ${NATIVES[*]}"

WORK=${RUNNER_TEMP:-/tmp}/freestyle-native
rm -rf "$WORK" && mkdir -p "$WORK"

fetch() { # <repo> <ref> <dir>
    git init -q "$3"
    git -C "$3" fetch -q --depth 1 "https://github.com/$1" "$2"
    git -C "$3" checkout -q FETCH_HEAD
}

# 1. Valenced API → ~/.m2 (core 와 android api 는 같은 버전으로 같이 올려야 한다)
fetch Valenced/valenced "$VALENCED_REF" "$WORK/valenced"
(cd "$WORK/valenced" && ./gradlew --no-daemon -q :core:publishToMavenLocal :android:api:publishToMavenLocal)

# 2. 템플릿에 플러그인 넣기 (예제는 빼고, GitHub Packages 대신 로컬 Maven 사용)
fetch "$TEMPLATE_REPO" "$TEMPLATE_REF" "$WORK/tpl"
rm -rf "$WORK/tpl/plugins"/* "$WORK/tpl/themes"/*
python3 - "$WORK/tpl/settings.gradle.kts" <<'EOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'\n\s*// The Valenced plugin API is published to GitHub Packages\.\n\s*maven \{\n.*?\n        \}\n', '\n', s, flags=re.S)
s = s.replace('dependencyResolutionManagement {\n    repositories {\n', 'dependencyResolutionManagement {\n    repositories {\n        mavenLocal()\n', 1)
assert 'mavenLocal()' in s and 'maven.pkg.github.com' not in s, s
open(p, 'w').write(s)
EOF
for n in "${NATIVES[@]}"; do
    mkdir -p "$WORK/tpl/plugins/$n"
    cp "plugins/$n/manifest.json" "$WORK/tpl/plugins/$n/"
    cp -r "plugins/$n/src" "$WORK/tpl/plugins/$n/"
done

# 3. DEX 로 컴파일
FAILED=0
cd "$WORK/tpl"
for n in "${NATIVES[@]}"; do
    LOG="$WORK/$n.log"
    if ./gradlew --no-daemon ":plugins:$n:dexJar" >"$LOG" 2>&1; then
        mkdir -p "$ROOT/plugins/$n/build"
        cp "plugins/$n/build/outputs/plugin/plugin.jar" "$ROOT/plugins/$n/build/plugin.jar"
        echo "✓ $n: plugin.jar"
    else
        FAILED=1
        echo "✗ $n: 빌드 실패"
        # 컴파일 오류를 Actions 주석으로 (실행 요약에서 보인다)
        grep -E '^e: ' "$LOG" | head -20 | while IFS= read -r line; do
            echo "::error title=$n::${line#e: }"
        done
        tail -60 "$LOG"
    fi
done
exit $FAILED
