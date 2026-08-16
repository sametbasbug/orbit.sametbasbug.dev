/*
 * Production'a çıkaran şey `main`'e push.
 *
 * Bu betik dağıtım yapmaz; dağıtım komutu arayan kişiyi doğru yola gönderir
 * ve sıfırdan farklı bir kodla çıkar. Yerel `wrangler deploy` gerçekten
 * çalışıyor — tehlikeli olan tam olarak bu, çünkü çalışırken atladıklarını
 * söylemiyor.
 *
 * Bu bir kilit değil, bir tabela: token bu makinede durduğu sürece elle
 * `npx wrangler deploy` yazan biri yine dağıtabilir. Kilit, token'ın yalnız
 * Actions'ta durması olurdu.
 */
const message = `
Orbit production'a push ile çıkar.

  git push origin main

.github/workflows/deploy-production.yml dağıtır. Yerel "wrangler deploy"
kullanma; şunları atlıyor:

  - dört doğrulama işinin bağımsız scope sınıflandırması ve mutabakatı
  - artefaktın SHA256 manifesti ve deploy anında commit kimliği teyidi
  - d1 migrations apply  (yerel yolda göç hiç uygulanmıyor)
  - sırların --secrets-file ile sürüme bağlanması
  - --tag main-<sha>  (etiketsiz sürüm hangi kodun canlıda olduğunu söylemez)
  - dağıtım sonrası canlı sağlık, header ve contract:live doğrulaması

Koşuyu izlemek için:  gh run watch <id> --exit-status

Staging ayrı ve yerel:  npm run staging:deploy && npm run staging:verify
`;

process.stderr.write(`${message.trim()}\n`);
process.exit(1);
