// Copia o APK do app Android para a pasta publicada, para o celular baixar direto do servidor
// (https://.../concord.apk). Roda depois do build da versão web, que esvazia a pasta.
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const apk = join(root, '../android/app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apk)) {
  console.warn('APK não encontrado; rode android/build-apk.sh antes para publicar o app Android.');
} else {
  copyFileSync(apk, join(root, 'public/concord.apk'));
  console.log(`APK copiado (${(statSync(apk).size / 1e6).toFixed(1)} MB)`);
}
