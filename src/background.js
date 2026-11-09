// Service worker: navega pelo site e tira os prints. Fica aqui (e não no popup)
// porque o popup fecha quando perde o foco; o estado vai para chrome.storage e o popup só lê.
import { db, VIEWPORTS, DEFAULTS } from './shared.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms, msg) => Promise.race([p, sleep(ms).then(() => { throw new Error(msg); })]);
const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
const evaluate = async (tabId, expression) => {
  const r = await send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

let state = { status: 'idle', pages: [], current: '', error: '', rev: 0, max: 0 };
let stop = false;
let crawlTab = null;
// O service worker pode ter sido reiniciado: recupera o estado e desfaz um "rodando" órfão
const ready = chrome.storage.local.get('state').then(({ state: s }) => {
  if (s) state = { ...s, status: ['running', 'stopping', 'capturing'].includes(s.status) ? 'stopped' : s.status };
});
const save = () => chrome.storage.local.set({ state });

// ---------- URLs ----------

const ID = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const FILE = /\.(pdf|zip|rar|7z|png|jpe?g|gif|svg|webp|ico|mp[34]|webm|csv|xlsx?|docx?|pptx?|exe|dmg|apk|xml|json|txt)$/i;

// Hash só é mantido quando é rota de SPA (#/rota); âncoras (#secao) são a mesma tela
function norm(href) {
  const u = new URL(href);
  if (!/^#!?\/./.test(u.hash)) u.hash = '';
  return u.href;
}

// Chave de deduplicação: duas URLs com a mesma chave são consideradas a mesma tela
function key(href, cfg) {
  const u = new URL(href);
  let path = u.pathname.replace(/\/+$/, '');
  if (cfg.groupDynamic) path = path.split('/').map(s => (ID.test(s) ? ':id' : s)).join('/');
  return u.origin + path + (cfg.ignoreQuery ? '' : u.search) + u.hash;
}

const terms = cfg => cfg.exclude.toLowerCase().split(/[,\n]/).map(s => s.trim()).filter(Boolean);
const excluded = (href, cfg) => FILE.test(new URL(href).pathname) || terms(cfg).some(t => href.toLowerCase().includes(t));

// ---------- Captura ----------

async function attach(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  await send(tabId, 'Page.enable');
  // sem a barra de rolagem do Windows aparecendo nos prints (comando experimental: se faltar, segue sem)
  await send(tabId, 'Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {});
}
// Diálogos nativos travariam o mapeamento. alert e beforeunload são aceitos; confirm e prompt são
// sempre recusados, para um clique de teste nunca confirmar uma exclusão.
chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === 'Page.javascriptDialogOpening')
    send(tabId, 'Page.handleJavaScriptDialog', { accept: params.type !== 'confirm' && params.type !== 'prompt' }).catch(() => {});
});
// Usuário fechou a aba ou cancelou no aviso de depuração
chrome.debugger.onDetach.addListener(({ tabId }) => { if (tabId === crawlTab) stop = true; });

const metrics = (tabId, vp, height = vp.height) =>
  send(tabId, 'Emulation.setDeviceMetricsOverride', { width: vp.width, height, deviceScaleFactor: vp.dpr, mobile: vp.mobile });

async function waitLoad(tabId, ms = 20000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(150)) {
    // evaluate falha enquanto a navegação troca de documento; é só tentar de novo
    if ((await evaluate(tabId, 'document.readyState').catch(() => '')) === 'complete') return;
  }
}

// Rola até o fim e volta, para disparar imagens e blocos carregados sob demanda
const SCROLL = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let y = 0, i = 0; y < document.scrollingElement.scrollHeight && i < 40; y += innerHeight, i++) { scrollTo(0, y); await wait(80); }
  scrollTo(0, 0); await wait(150);
})()`;

// Layout de app (página fixa em 100vh com uma área que rola por dentro): devolve quantos px
// estão escondidos nessa área, para esticar o viewport e o conteúdo todo aparecer no print.
// ponytail: heurística — só o maior container rolável; rolagens aninhadas ou listas
// virtualizadas não entram. Se faltar conteúdo num print, é aqui que se ajusta.
const INNER = `(() => {
  let extra = 0;
  if (document.scrollingElement.scrollHeight > innerHeight + 40) return { extra, width: document.documentElement.clientWidth };
  for (const el of document.querySelectorAll('body *')) {
    const d = el.scrollHeight - el.clientHeight;
    if (d < 40 || d <= extra || el.clientHeight < innerHeight * 0.5 || el.clientWidth < innerWidth * 0.4) continue;
    if (/auto|scroll/.test(getComputedStyle(el).overflowY)) extra = d;
  }
  return { extra, width: document.documentElement.clientWidth };
})()`;

// Página mobile sem <meta viewport> é desenhada em 980px e encolhida, como num celular de verdade:
// o recorte é na largura do layout e a escala traz de volta para a largura do aparelho.
// No desktop a largura do layout desconta a barra de rolagem, então vale a do viewport.
const layoutOf = (vp, layoutWidth) => {
  const width = vp.mobile ? layoutWidth : vp.width;
  return { width, zoom: vp.width / width };
};
// ponytail: o Chrome não renderiza além de ~16384px; telas mais altas são cortadas aí
const maxHeight = vp => Math.floor(16000 / vp.dpr);

// Tira o print do retângulo (em px do layout) e guarda junto com a miniatura
async function store(tabId, vpName, cfg, rect, beyond, thumbRatio, meta) {
  const vp = VIEWPORTS[vpName];
  const shoot = (format, height, scale) => timeout(send(tabId, 'Page.captureScreenshot', {
    format, ...(format === 'jpeg' && { quality: 88 }), captureBeyondViewport: beyond,
    clip: { x: rect.x, y: rect.y, width: rect.width, height, scale },
  }), 30000, 'A captura não respondeu. Deixe a aba visível durante o mapeamento.');
  const full = await shoot(cfg.format, rect.height, rect.zoom);
  const thumb = await shoot('jpeg', Math.min(rect.height, Math.round(rect.width * thumbRatio)), 480 / (rect.width * vp.dpr));
  const blob = await (await fetch(`data:image/${cfg.format};base64,${full.data}`)).blob();
  await db.add({
    ...meta, vp: vpName, width: vp.width * vp.dpr, height: Math.round(rect.height * rect.zoom * vp.dpr),
    blob, thumb: `data:image/jpeg;base64,${thumb.data}`, ts: Date.now(),
  });
  state.rev++;
}

async function capture(tabId, vpName, cfg, meta) {
  const vp = VIEWPORTS[vpName];
  if (cfg.lazyScroll) await evaluate(tabId, SCROLL);
  const inner = await evaluate(tabId, INNER);
  const { width, zoom } = layoutOf(vp, inner.width);
  if (inner.extra) { await metrics(tabId, vp, Math.min(vp.height + Math.ceil(inner.extra * zoom), maxHeight(vp))); await sleep(350); }
  const { cssContentSize } = await send(tabId, 'Page.getLayoutMetrics');
  const height = Math.min(Math.ceil(cssContentSize.height), Math.floor(maxHeight(vp) / zoom));
  await store(tabId, vpName, cfg, { x: 0, y: 0, width, height, zoom }, true, 0.66, meta);
  if (inner.extra) await metrics(tabId, vp);
}

async function captureAll(tabId, cfg, meta) {
  for (const [i, v] of cfg.viewports.entries()) {
    // ponytail: troca de tamanho sem recarregar a página; se um layout só se decide no load, recarregar aqui
    if (i || meta.manual) { await metrics(tabId, VIEWPORTS[v]); await sleep(Math.max(400, cfg.delay / 2)); }
    await capture(tabId, v, cfg, meta);
  }
}

async function go(tabId, url, cfg, reload) {
  await metrics(tabId, VIEWPORTS[cfg.viewports[0]]);
  if (reload) {
    await send(tabId, 'Page.reload');
    await sleep(300); // dá tempo de o documento antigo sair antes de esperar o novo
  } else {
    const nav = await send(tabId, 'Page.navigate', { url });
    if (nav.errorText) throw new Error(nav.errorText);
  }
  await waitLoad(tabId);
  await sleep(cfg.delay);
}

// ---------- Modais ----------

// Roda dentro da página (vai como texto pelo Runtime.evaluate): não pode usar nada de fora da função.
function pageLib() {
  if (window.__maptudo) return;
  const MARKED = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true], .modal.show, .modal.is-active, .modal.open, [popover]:popover-open';
  // Atributos com que as bibliotecas declaram "este botão abre uma modal"
  const DECLARED = '[aria-haspopup=dialog], [data-bs-toggle=modal], [data-bs-toggle=offcanvas], [data-toggle=modal], [data-modal-target], [data-modal-toggle], [data-drawer-target], [data-hs-overlay], [data-micromodal-trigger], [data-open-modal], [data-dialog-target], [popovertarget], [commandfor], [onclick*=showModal], [onclick*=modal i], [onclick*=dialog i]';
  const CLICKABLE = 'button, [role=button], input[type=button], a:not([href]), [onclick]';
  // No código do clique: o que sugere abrir uma modal, e o que sugere mexer em dados ou sair da tela
  const OPENS = /modal|dialog|drawer|popup|popover|lightbox|sheet|set\w*(open|show|visible)|on(open|show)|toggle/i;
  const RISKY_CODE = /fetch\(|axios|mutat|\.(post|put|patch|delete)\(|submit|remove|delete/i;
  const RISKY_LABEL = /exclu|apag|delet|remov|sair|log ?out|sign ?out|salvar|save|enviar|send|submit|pagar|pay|comprar|buy|confirm|finaliz|checkout|publi|aprov|rejeit|desativ|bloque|cancel|imprim|print|baixar|download|export/i;
  let before = new Set();
  let beforeText = '';

  const clean = s => (s || '').trim().replace(/\s+/g, ' ');
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const label = el => clean(el.getAttribute('aria-label') || el.innerText || el.title || el.value).slice(0, 60);
  // Código do clique: o atributo onclick ou, em apps React, a função passada em onClick
  const handler = el => {
    const k = Object.keys(el).find(k => k.startsWith('__reactProps$'));
    const fn = k && el[k].onClick;
    return (el.getAttribute('onclick') || '') + (typeof fn === 'function' ? fn : '');
  };

  // Modais abertas agora: as marcadas no HTML mais qualquer camada fixa que cubra a tela (modais sem marcação)
  const open = () => {
    const found = new Set([...document.querySelectorAll(MARKED)].filter(visible));
    for (const el of document.querySelectorAll('body *')) {
      if (el.clientWidth < innerWidth * 0.9 || el.clientHeight < innerHeight * 0.9) continue;
      const s = getComputedStyle(el);
      if (s.position === 'fixed' && s.pointerEvents !== 'none' && visible(el)) found.add(el);
    }
    return [...found];
  };
  // O que abriu depois do último clique (uma faixa de cookies que já estava lá não conta)
  const fresh = () => {
    const all = open().filter(el => !before.has(el));
    return all.filter(el => !all.some(o => o !== el && o.contains(el)));
  };

  // Escolhe o próximo gatilho ainda não testado e aciona
  const next = ({ mode, scope, tried, exclude }) => {
    const list = [];
    // <dialog> já está no HTML: dá para abrir direto, sem depender de achar o botão
    for (const el of document.querySelectorAll('dialog:not([open])'))
      list.push({ el, sig: `dialog|${el.id}|${clean(el.textContent).slice(0, 40)}`, act: () => el.showModal() });
    for (const el of document.querySelectorAll(`${DECLARED}, ${CLICKABLE}, a[href]`)) {
      const text = label(el);
      if (!visible(el) || el.disabled || el.closest('[aria-disabled=true]') || exclude.some(x => text.toLowerCase().includes(x))) continue;
      const code = handler(el);
      const safe = !RISKY_LABEL.test(text) && !RISKY_CODE.test(code) && !(el.type === 'submit' && el.form);
      // "code": só o que o HTML ou o código do clique indicam; "all": todo botão que não pareça perigoso
      if (!(el.matches(DECLARED) || (safe && (mode === 'all' || OPENS.test(code))))) continue;
      let act = () => el.click();
      if (el.matches('a[href]')) {
        // Link para fora do site, que abre outra aba ou "javascript:": pode ser o gatilho de um passo
        // ("siga no X para liberar"), então clica sem sair da página. Link interno fica para o mapeamento.
        let outside = el.target === '_blank' || /^(javascript:|#$)/i.test(el.getAttribute('href'));
        try { outside ||= new URL(el.href).origin !== location.origin; } catch {}
        if (!outside || !el.matches(DECLARED) && mode !== 'all') continue;
        act = () => { el.addEventListener('click', e => e.preventDefault(), { once: true }); el.click(); };
      }
      // botões de cabeçalho/menu se repetem em toda página: testa uma vez só no site inteiro
      const global = el.closest('header, nav, aside, footer, [role=banner], [role=navigation]');
      list.push({ el, sig: `${global ? '' : scope}|${el.tagName}|${text}|${el.getAttribute('class') || ''}`, act });
    }
    const pick = list.find(c => !tried.includes(c.sig));
    if (!pick) return null;
    before = new Set(open());
    beforeText = clean(document.body.innerText);
    window.open = () => null; // um clique de teste não deve abrir outra aba
    pick.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    try { pick.act(); } catch {}
    return { sig: pick.sig, label: label(pick.el) };
  };

  const info = () => {
    const top = fresh();
    if (!top.length) return null;
    const outer = top.find(el => el.matches(MARKED)) || top[0];
    const box = outer.matches(MARKED) ? outer : outer.querySelector(MARKED) || outer;
    const by = box.getAttribute('aria-labelledby');
    const title = clean(box.getAttribute('aria-label') || (by && document.getElementById(by.split(' ')[0])?.innerText)
      || box.querySelector('h1, h2, h3, h4, h5, [class*=title i]')?.innerText).slice(0, 80);
    // conteúdo que rola dentro da modal: quantos px ainda estão escondidos
    let extra = 0;
    for (const el of [outer, ...outer.querySelectorAll('*')]) {
      const d = el.scrollHeight - el.clientHeight;
      if (d > 40 && d > extra && el.clientWidth > box.clientWidth * 0.5 && /auto|scroll/.test(getComputedStyle(el).overflowY)) extra = d;
    }
    return {
      sig: `${box.id}|${title}|${clean(box.innerText).slice(0, 200)}`, title, extra,
      x: scrollX, y: scrollY, width: document.documentElement.clientWidth, height: innerHeight,
    };
  };

  // Quanto texto novo apareceu na tela desde o clique: o trecho do meio que ficou diferente
  const changed = () => {
    const now = clean(document.body.innerText);
    let p = 0, s = 0;
    while (p < now.length && now[p] === beforeText[p]) p++;
    while (s < now.length - p && s < beforeText.length - p && now[now.length - 1 - s] === beforeText[beforeText.length - 1 - s]) s++;
    return { added: now.length - p - s, sig: now.slice(p, now.length - s).slice(0, 200) };
  };

  window.__maptudo = { next, info, changed, closed: () => !fresh().length };
}
const inPage = (tabId, call) => evaluate(tabId, `(${pageLib})(); __maptudo.${call}`);
const press = (tabId, type) => send(tabId, 'Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

const PAGE_INFO = `({ href: location.href, title: document.title, links: [...document.querySelectorAll('a[href]')].map(a => a.href) })`;

// Põe na fila os links internos ainda não vistos, como rotas descobertas a partir de state.pages[from]
function enqueue(links, from, cfg, ctx) {
  for (const href of links) {
    let u;
    try { u = norm(href); } catch { continue; }
    if (new URL(u).origin !== ctx.origin || excluded(u, cfg)) continue;
    const k = key(u, cfg);
    // ponytail: teto de 1000 rotas descobertas para o estado não crescer sem limite
    if (ctx.seen.has(k) || state.pages.length >= 1000) continue;
    ctx.seen.add(k);
    state.pages.push({ url: u, depth: state.pages[from].depth + 1, from, status: 'queued' });
  }
}

// Aciona os botões da página um por vez e captura o que cada clique revela:
// uma modal, outra tela (que pode só existir vindo deste clique) ou um trecho novo na mesma tela.
async function clickThrough(tabId, i, cfg, ctx) {
  const page = state.pages[i];
  const first = VIEWPORTS[cfg.viewports[0]];
  const opts = { mode: cfg.modals, scope: key(page.url, cfg), exclude: terms(cfg) };
  state.phase = 'modals';
  save();
  await metrics(tabId, first);
  await sleep(300);
  // ponytail: no máximo 30 gatilhos por página; numa tela com mais botões que isso, sobram modais de fora
  for (let n = 0; n < 30 && !stop; n++) {
    const trigger = await inPage(tabId, `next(${JSON.stringify({ ...opts, tried: [...ctx.triggers] })})`);
    if (!trigger) break;
    ctx.triggers.add(trigger.sig);
    await sleep(500 + cfg.delay / 2); // animação de abertura e conteúdo que chega depois do clique
    const here = await evaluate(tabId, 'location.href').catch(() => '');
    if (!here || norm(here) !== page.url) {
      // O botão levou a outra tela: captura ali mesmo, porque ela pode não abrir direto pelo endereço
      await waitLoad(tabId);
      await sleep(cfg.delay);
      const info = await evaluate(tabId, PAGE_INFO).catch(() => null);
      const url = info && norm(info.href);
      if (url && url !== page.url && new URL(url).origin === ctx.origin && !excluded(url, cfg) && !ctx.seen.has(key(url, cfg))) {
        ctx.seen.add(key(url, cfg));
        await captureAll(tabId, cfg, { url, title: info.title, via: trigger.label });
        state.pages.push({ url, title: info.title, depth: page.depth + 1, from: i, status: 'done', via: trigger.label });
        enqueue(info.links, state.pages.length - 1, cfg, ctx);
        save();
      }
      await go(tabId, page.url, cfg);
      continue;
    }
    const modal = await inPage(tabId, 'info()').catch(() => null);
    if (!modal) {
      // Nem modal nem outra tela: o clique pode ter liberado um trecho na própria tela.
      // ponytail: "liberou" = 150+ caracteres de texto novo. Mudança só visual (imagem, gráfico) não conta;
      // se capturar demais (ordenar tabela, abrir sanfona) ou de menos, o ajuste é este número.
      const diff = await inPage(tabId, 'changed()').catch(() => null);
      const sig = diff && `estado|${opts.scope}|${diff.sig}`;
      if (diff && diff.added >= 150 && !ctx.modals.has(sig)) {
        ctx.modals.add(sig);
        await captureAll(tabId, cfg, { url: page.url, title: page.title, via: trigger.label });
        page.states = (page.states || 0) + 1;
        await go(tabId, page.url, cfg, true); // o próximo botão parte da tela original
        continue;
      }
    }
    if (modal) {
      // a mesma modal aparece em várias páginas (ex.: no cabeçalho): guarda uma vez só
      const sig = modal.sig === '||' ? trigger.sig : modal.sig;
      if (!ctx.modals.has(sig)) {
        ctx.modals.add(sig);
        for (const [i, v] of cfg.viewports.entries()) {
          const vp = VIEWPORTS[v];
          if (i) { await metrics(tabId, vp); await sleep(500); }
          let box = await inPage(tabId, 'info()');
          if (!box) break; // fechou sozinha ao mudar de tamanho
          const { zoom } = layoutOf(vp, box.width);
          // Modal alta: estica o viewport até o conteúdo caber. Repete porque uma modal com
          // max-height: 80vh só cresce 80% do que o viewport cresceu.
          for (let k = 0, h = vp.height; k < 3 && box.extra; k++) {
            h = Math.min(h + Math.ceil(box.extra * zoom), maxHeight(vp));
            await metrics(tabId, vp, h);
            await sleep(350);
            box = (await inPage(tabId, 'info()')) || { ...box, extra: 0 };
          }
          await store(tabId, v, cfg, { x: box.x, y: box.y, height: box.height, ...layoutOf(vp, box.width) }, false, 2.2,
            { url: page.url, title: page.title, modal: modal.title || trigger.label || 'Modal' });
        }
        page.modals = (page.modals || 0) + 1;
        await metrics(tabId, first);
      }
      await press(tabId, 'keyDown');
      await press(tabId, 'keyUp');
      await sleep(350);
    }
    // A modal não fechou com Esc: recarrega para voltar ao estado inicial
    if (!(await inPage(tabId, 'closed()').catch(() => false))) await go(tabId, page.url, cfg, true);
  }
}

// ---------- Mapeamento ----------

async function visit(tabId, i, cfg, ctx) {
  const { origin, seen } = ctx;
  const page = state.pages[i];
  await go(tabId, page.url, cfg);

  const info = await evaluate(tabId, PAGE_INFO);
  const final = norm(info.href);
  if (new URL(final).origin !== origin) return void Object.assign(page, { status: 'skipped', note: 'Redireciona para fora do site' });
  if (final !== page.url) {
    const k = key(final, cfg);
    if (k !== key(page.url, cfg) && seen.has(k))
      return void Object.assign(page, { status: 'skipped', note: `Redireciona para ${new URL(final).pathname}` });
    seen.add(k);
    page.url = final;
  }

  page.title = info.title;
  await captureAll(tabId, cfg, { url: page.url, title: page.title });
  page.status = 'done';
  enqueue(info.links, i, cfg, ctx);
  // Um erro nos cliques não invalida a tela, que já foi capturada
  if (cfg.modals && cfg.modals !== 'off') await clickThrough(tabId, i, cfg, ctx).catch(() => {});
}

async function crawl(cfg, tabId, fromTab) {
  await ready;
  if (['running', 'stopping', 'capturing'].includes(state.status)) return;
  stop = false;
  let own = false, attached = false;
  const done = () => state.pages.filter(p => p.status === 'done').length;
  state = { status: 'running', pages: [], current: '', error: '', rev: state.rev + 1, max: cfg.maxPages };
  try {
    const start = norm(cfg.url);
    const origin = new URL(start).origin;
    const ctx = { origin, seen: new Set([key(start, cfg)]), triggers: new Set(), modals: new Set() };
    state.pages.push({ url: start, depth: 0, from: -1, status: 'queued' });
    await save();

    // Usa a aba atual (já logada e visível); se não for uma página http, abre uma aba própria
    const tab = tabId && (await chrome.tabs.get(tabId).catch(() => null));
    if (tab && /^https?:/.test(tab.url)) await chrome.tabs.update(tabId, { active: true });
    else { tabId = (await chrome.tabs.create({ url: 'about:blank' })).id; own = true; }

    // Cada mapeamento substitui o anterior; capturas manuais ficam até "Limpar tudo"
    for (const s of await db.all()) if (!s.manual) await db.del(s.id);
    await attach(tabId);
    attached = true;
    crawlTab = tabId;
    chrome.action.setBadgeBackgroundColor({ color: '#84cc16' });

    for (let i = 0; i < state.pages.length && done() < cfg.maxPages && !stop; i++) {
      const page = state.pages[i];
      if (page.status !== 'queued') continue; // tela aberta por botão: já foi capturada na hora
      page.status = 'loading';
      state.current = page.url;
      state.phase = '';
      save();
      try {
        await visit(tabId, i, cfg, ctx);
        chrome.action.setBadgeText({ text: String(done()) });
      } catch (e) {
        Object.assign(page, { status: 'error', note: e.message });
      }
      save();
    }
  } catch (e) {
    state.error = e.message;
  } finally {
    crawlTab = null;
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    if (own) chrome.tabs.remove(tabId).catch(() => {});
    else if (attached) chrome.tabs.update(tabId, { url: cfg.url }).catch(() => {});
    if (fromTab) chrome.tabs.update(fromTab, { active: true }).catch(() => {});
    state.status = stop ? 'stopped' : 'done';
    state.current = '';
    save();
  }
}

// Captura só a tela aberta, no estado em que está (modal aberto, aba selecionada...)
async function captureCurrent(cfg, tabId) {
  await ready;
  if (['running', 'stopping', 'capturing'].includes(state.status)) return;
  const before = state.status;
  let attached = false;
  state.error = '';
  try {
    const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!/^https?:/.test(tab?.url)) throw new Error('Abra uma página do seu site para capturar.');
    tabId = tab.id;
    state.status = 'capturing';
    save();
    await attach(tabId);
    attached = true;
    await captureAll(tabId, cfg, { url: norm(tab.url), title: tab.title, manual: true });
  } catch (e) {
    state.error = e.message;
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    state.status = before;
    save();
  }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.cmd === 'start') crawl(m.cfg, m.tabId, sender.tab?.id);
  if (m.cmd === 'capture') captureCurrent(m.cfg, m.tabId);
  if (m.cmd === 'stop' && state.status === 'running') { stop = true; state.status = 'stopping'; save(); }
  if (m.cmd === 'clear') ready.then(async () => {
    await db.clear();
    state = { ...state, status: 'idle', pages: [], error: '', rev: state.rev + 1 };
    chrome.action.setBadgeText({ text: '' });
    save();
  });
  reply();
});

// Atalho de teclado: captura sem abrir o popup (que fecharia menus e tooltips abertos)
chrome.commands.onCommand.addListener(async c => {
  if (c === 'capture-current') captureCurrent({ ...DEFAULTS, ...(await chrome.storage.local.get('cfg')).cfg });
});
