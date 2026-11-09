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

function excluded(href, cfg) {
  const terms = cfg.exclude.toLowerCase().split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  return FILE.test(new URL(href).pathname) || terms.some(t => href.toLowerCase().includes(t));
}

// ---------- Captura ----------

async function attach(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  await send(tabId, 'Page.enable');
}
// alert/confirm/beforeunload travariam o mapeamento
chrome.debugger.onEvent.addListener(({ tabId }, method) => {
  if (method === 'Page.javascriptDialogOpening') send(tabId, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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

async function capture(tabId, vpName, cfg, meta) {
  const vp = VIEWPORTS[vpName];
  // ponytail: o Chrome não renderiza além de ~16384px; telas mais altas são cortadas aí
  const maxH = Math.floor(16000 / vp.dpr);
  if (cfg.lazyScroll) await evaluate(tabId, SCROLL);
  const layout = await evaluate(tabId, INNER);
  const { extra } = layout;
  // Página mobile sem <meta viewport> é desenhada em 980px e encolhida, como num celular de verdade:
  // o recorte é na largura do layout e a escala traz de volta para a largura do aparelho.
  // No desktop a largura do layout desconta a barra de rolagem, então vale a do viewport.
  const width = vp.mobile ? layout.width : vp.width;
  const zoom = vp.width / width;
  if (extra) { await metrics(tabId, vp, Math.min(vp.height + Math.ceil(extra * zoom), maxH)); await sleep(350); }

  const { cssContentSize } = await send(tabId, 'Page.getLayoutMetrics');
  const height = Math.min(Math.ceil(cssContentSize.height), Math.floor(maxH / zoom));
  const shoot = (format, h, scale) => timeout(send(tabId, 'Page.captureScreenshot', {
    format, ...(format === 'jpeg' && { quality: 88 }), captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: h, scale },
  }), 30000, 'A captura não respondeu. Deixe a aba visível durante o mapeamento.');
  const full = await shoot(cfg.format, height, zoom);
  const thumb = await shoot('jpeg', Math.min(height, Math.round(width * 0.66)), 480 / (width * vp.dpr));
  if (extra) await metrics(tabId, vp);

  const blob = await (await fetch(`data:image/${cfg.format};base64,${full.data}`)).blob();
  await db.add({
    ...meta, vp: vpName, width: vp.width * vp.dpr, height: Math.round(height * zoom * vp.dpr),
    blob, thumb: `data:image/jpeg;base64,${thumb.data}`, ts: Date.now(),
  });
  state.rev++;
}

async function captureAll(tabId, cfg, meta) {
  for (const [i, v] of cfg.viewports.entries()) {
    // ponytail: troca de tamanho sem recarregar a página; se um layout só se decide no load, recarregar aqui
    if (i || meta.manual) { await metrics(tabId, VIEWPORTS[v]); await sleep(Math.max(400, cfg.delay / 2)); }
    await capture(tabId, v, cfg, meta);
  }
}

// ---------- Mapeamento ----------

async function visit(tabId, i, cfg, origin, seen) {
  const page = state.pages[i];
  await metrics(tabId, VIEWPORTS[cfg.viewports[0]]);
  const nav = await send(tabId, 'Page.navigate', { url: page.url });
  if (nav.errorText) throw new Error(nav.errorText);
  await waitLoad(tabId);
  await sleep(cfg.delay);

  const info = await evaluate(tabId, `({ href: location.href, title: document.title,
    links: [...document.querySelectorAll('a[href]')].map(a => a.href) })`);
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

  for (const href of info.links) {
    let u;
    try { u = norm(href); } catch { continue; }
    if (new URL(u).origin !== origin || excluded(u, cfg)) continue;
    const k = key(u, cfg);
    // ponytail: teto de 1000 rotas descobertas para o estado não crescer sem limite
    if (seen.has(k) || state.pages.length >= 1000) continue;
    seen.add(k);
    state.pages.push({ url: u, depth: page.depth + 1, from: i, status: 'queued' });
  }
}

async function crawl(cfg, tabId, fromTab) {
  await ready;
  if (['running', 'stopping', 'capturing'].includes(state.status)) return;
  stop = false;
  let own = false, attached = false, done = 0;
  state = { status: 'running', pages: [], current: '', error: '', rev: state.rev + 1, max: cfg.maxPages };
  try {
    const start = norm(cfg.url);
    const origin = new URL(start).origin;
    const seen = new Set([key(start, cfg)]);
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
    chrome.action.setBadgeBackgroundColor({ color: '#29a383' });

    for (let i = 0; i < state.pages.length && done < cfg.maxPages && !stop; i++) {
      const page = state.pages[i];
      page.status = 'loading';
      state.current = page.url;
      save();
      try {
        await visit(tabId, i, cfg, origin, seen);
        if (page.status === 'done') chrome.action.setBadgeText({ text: String(++done) });
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
