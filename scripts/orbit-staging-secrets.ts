import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/* Staging provalarının ihtiyaç duyduğu üç pepper'ın tek okuma yolu.
 *
 * Yerelde Samet'in macOS Keychain'inde duruyorlar ve orada kalmalı:
 * dosyaya yazılan bir sır er ya da geç commit'lenir. Ama gecelik
 * regresyon Linux runner'da çalışıyor ve orada Keychain yok — bu yüzden
 * önce ortam değişkenine bakıyoruz.
 *
 * Sıra bilerek bu yönde: CI ortamı değişkeni verir, yerel makine
 * vermez ve Keychain'e düşer. Tersi olsaydı, yerelde yanlışlıkla tanımlı
 * kalmış bir değişken sessizce Keychain'in önüne geçerdi. */
export const STAGING_KEYCHAIN_SERVICE = 'staging.orbit.sametbasbug';

export function readStagingSecret(binding: string): string {
  const fromEnvironment = process.env[binding];
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment;

  const result = spawnSync('security', [
    'find-generic-password',
    '-s', STAGING_KEYCHAIN_SERVICE,
    '-a', binding,
    '-w',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  /* Hata mesajı iki yolu da söylemeli: CI'da düşen biri Keychain'i
   * aramaya kalkmasın, yerelde düşen biri secret arayıp durmasın. */
  assert.equal(
    result.status,
    0,
    `Missing staging secret ${binding}: set it as an environment variable, `
      + `or store it in the "${STAGING_KEYCHAIN_SERVICE}" Keychain service.`,
  );
  return result.stdout.trim();
}
