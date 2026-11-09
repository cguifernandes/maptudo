// uso: node map.js http://localhost:3000 [maxPaginas]
// Abre o Chrome, você faz login se precisar, aperta Enter, e ele visita todos os
// links internos salvando um print de página inteira de cada tela em ./prints
const { chromium } = require('playwright-core');
const fs = require('fs');

const [start, max = 200] = process.argv.slice(2);
if (!start) { console.error('uso: node map.js <url> [maxPaginas]'); process.exit(1); }

const limpa = u => { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); };

(async () => {
  // perfil persistente: o login fica salvo entre execuções
  const ctx = await chromium.launchPersistentContext('.profile', {
    channel: 'chrome', headless: false, viewport: { width: 1440, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(start);

  console.log('Faça login se precisar e aperte Enter aqui para começar...');
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  const origem = new URL(page.url()).origin;
  const fila = [limpa(page.url())];
  const vistos = new Set(fila);
  fs.mkdirSync('prints', { recursive: true });

  for (let n = 1; fila.length && n <= max; n++) {
    const url = fila.shift();
    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const nome = (new URL(url).pathname + new URL(url).search).replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'home';
      await page.screenshot({ path: `prints/${String(n).padStart(3, '0')}_${nome.slice(0, 80)}.png`, fullPage: true });
      console.log(n, url);

      const links = await page.$$eval('a[href]', as => as.map(a => a.href));
      for (const l of links) {
        if (!l.startsWith(origem)) continue;
        if (/logout|signout|sign-out|sair/i.test(l)) continue; // não se deslogar no meio
        const u = limpa(l);
        if (!vistos.has(u)) { vistos.add(u); fila.push(u); }
      }
    } catch (e) { console.log('falhou', url, e.message.split('\n')[0]); }
  }
  // ponytail: só descobre telas via <a href>; telas atrás de botão/modal não entram —
  // se faltar alguma, aceitar uma lista de URLs extra por arquivo.
  await ctx.close();
  console.log(`Pronto: ${vistos.size - fila.length} telas em ./prints`);
})();
