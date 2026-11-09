// Compartilhado entre o service worker (background.js) e o popup

export const VIEWPORTS = {
  desktop: { label: 'Desktop', width: 1440, height: 900, dpr: 1, mobile: false },
  tablet: { label: 'Tablet', width: 768, height: 1024, dpr: 1, mobile: true },
  mobile: { label: 'Celular', width: 390, height: 844, dpr: 2, mobile: true },
};

export const DEFAULTS = {
  url: '',
  viewports: ['desktop'],
  maxPages: 50,
  delay: 800, // ms de espera depois do load, para SPA/animações terminarem
  format: 'png',
  groupDynamic: true, // /produto/1 e /produto/2 contam como a mesma tela
  ignoreQuery: true, // ?page=2 conta como a mesma tela
  lazyScroll: true, // rola a página antes do print para carregar imagens lazy
  // modais: 'off' | 'code' (só gatilhos que o HTML/código indicam) | 'all' (testa todo botão)
  modals: 'off',
  split: true, // exportação: divide prints longos em partes
  exclude: 'logout, signout, sign-out, sair, delete, excluir',
};

// IndexedDB: os prints são grandes demais para o chrome.storage
let dbp;
const open = () =>
  (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('maptudo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('shots', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
const tx = async (mode, fn) => {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction('shots', mode);
    const q = fn(t.objectStore('shots'));
    t.oncomplete = () => res(q.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
};
export const db = {
  add: shot => tx('readwrite', s => s.add(shot)),
  all: () => tx('readonly', s => s.getAll()),
  get: id => tx('readonly', s => s.get(id)),
  del: id => tx('readwrite', s => s.delete(id)),
  clear: () => tx('readwrite', s => s.clear()),
};
