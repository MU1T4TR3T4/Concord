#!/usr/bin/env bash
# Compila o APK do Concord. Uso (Git Bash): ./build-apk.sh [tarefa do gradle]
# Sem argumento gera o APK de distribuição em app/build/outputs/apk/release/.
set -e
cd "$(dirname "$0")"
export JAVA_HOME="$(ls -d "/c/Program Files/Eclipse Adoptium/"jdk-17* | head -1)"
export PATH="$JAVA_HOME/bin:$PATH"
# O Java no Windows falha ("Unable to establish loopback connection") quando a pasta
# temporária tem caminho longo ou abreviado (ADMINI~1); esta pasta curta resolve.
mkdir -p "$HOME/.concord-tmp"
export JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=$(cygpath -m "$HOME/.concord-tmp")"
./gradlew "${@:-assembleRelease}" --console=plain
