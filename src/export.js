// Exportação: ZIP com os prints + mapa em Markdown, ou um PDF único
import { zipSync, strToU8 } from 'fflate';
import { VIEWPORTS } from './shared.js';

export const pathOf = url => {
  const u = new URL(url);
  return u.pathname + u.search + u.hash;
};
const clean = text => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
const slug = url => clean(pathOf(url)) || 'home';
const pad = n => String(n).padStart(3, '0');
// Nome de uma tela para leitura: "Pedidos" ou "Pedidos (modal: Filtros)"
export const nameOf = s => {
  if (s.modal) return `${s.title || pathOf(s.url)} (modal: ${s.modal})`;
  if (s.via) return `${s.title || pathOf(s.url)} (após clicar em "${s.via}")`;
  return s.title || '';
};
const suffix = s => (s.modal ? `_modal-${clean(s.modal).slice(0, 30)}` : s.via ? `_apos-${clean(s.via).slice(0, 30)}` : '');
export const fileName = (s, i, part = 0, type = s.blob.type) =>
  `${pad(i + 1)}_${slug(s.url)}${suffix(s)}_${s.vp}${part ? `_parte${part}` : ''}.${type === 'image/jpeg' ? 'jpg' : 'png'}`;

export function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Rotas na ordem de árvore (cada rota seguida das que foram descobertas a partir dela)
export function orderTree(pages) {
  const kids = pages.map(() => []);
  pages.forEach((p, i) => p.from >= 0 && kids[p.from].push(i));
  const out = [];
  const walk = i => { out.push(pages[i]); kids[i].forEach(walk); };
  pages.forEach((p, i) => p.from < 0 && walk(i));
  return out;
}

const WHY = { queued: 'não visitada', skipped: 'pulada', error: 'erro', loading: 'não visitada' };

export function sitemapMd(pages, shots = [], names = {}) {
  const any = pages[0] || shots[0];
  const out = [`# Mapa de telas${any ? ` de ${new URL(any.url).origin}` : ''}`, ''];
  if (shots.length) {
    out.push('## Telas capturadas', '', '| Arquivo | Tela | Endereço | Tamanho |', '|---|---|---|---|');
    shots.forEach((s, i) => out.push(
      `| ${(names[s.id] || [fileName(s, i)]).join('<br>')} | ${nameOf(s).replace(/\|/g, '\\|')} | ${pathOf(s.url)} | ${VIEWPORTS[s.vp].label} ${s.width}×${s.height} |`,
    ));
    out.push('');
  }
  if (pages.length) {
    out.push('## Rotas encontradas', '');
    for (const p of orderTree(pages)) {
      const why = WHY[p.status] && ` (${WHY[p.status]}${p.note ? `: ${p.note}` : ''})`;
      const modals = (p.via ? ` (aberta pelo botão "${p.via}")` : '') + (p.modals ? ` (+${p.modals} ${p.modals === 1 ? 'modal' : 'modais'})` : '')
        + (p.states ? ` (+${p.states} após clique)` : '');
      out.push(`${'  '.repeat(p.depth)}- ${pathOf(p.url)}${p.title ? ` — ${p.title}` : ''}${modals}${why || ''}`);
    }
  }
  return out.join('\n');
}

// Devolve o print em uma ou mais partes. Com `split`, prints longos viram pedaços de ~1,6x a
// largura: IAs reduzem imagens muito altas até o texto ficar ilegível, então em partes elas leem melhor.
async function render(shot, split, type) {
  const n = split ? Math.max(1, Math.round(shot.height / (shot.width * 1.6))) : 1;
  if (n === 1 && shot.blob.type === type) return [{ blob: shot.blob, w: shot.width, h: shot.height }];
  const bmp = await createImageBitmap(shot.blob);
  const step = Math.ceil(bmp.height / n);
  const out = [];
  for (let y = 0; y < bmp.height; y += step) {
    const h = Math.min(step, bmp.height - y);
    const canvas = new OffscreenCanvas(bmp.width, h);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // JPEG não tem transparência
    g.fillRect(0, 0, bmp.width, h);
    g.drawImage(bmp, 0, -y);
    out.push({ blob: await canvas.convertToBlob({ type, quality: 0.88 }), w: bmp.width, h });
  }
  bmp.close();
  return out;
}

// ponytail: monta o ZIP inteiro em memória; para centenas de telas, trocar por fflate.Zip (streaming)
export async function exportZip(shots, pages, split) {
  const files = {}, names = {};
  for (const [i, s] of shots.entries()) {
    const parts = await render(s, split, s.blob.type);
    names[s.id] = [];
    for (const [j, p] of parts.entries()) {
      const name = fileName(s, i, parts.length > 1 ? j + 1 : 0);
      names[s.id].push(name);
      files[name] = new Uint8Array(await p.blob.arrayBuffer());
    }
  }
  files['mapa.md'] = strToU8(sitemapMd(pages, shots, names));
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }); // imagens já são comprimidas
}

export async function exportPdf(shots, split) {
  const { jsPDF } = await import('jspdf');
  const HEAD = 26; // faixa com título e endereço no topo de cada página
  let doc;
  for (const [i, s] of shots.entries()) {
    const parts = await render(s, split, 'image/jpeg');
    for (const [j, p] of parts.entries()) {
      // PDF aceita no máximo 14400pt por lado
      const k = Math.min(0.75, 14000 / p.h, 14000 / p.w);
      const W = p.w * k, H = p.h * k + HEAD;
      const size = [[W, H], W > H ? 'l' : 'p']; // sem a orientação certa o jsPDF troca largura/altura
      if (doc) doc.addPage(...size);
      else doc = new jsPDF({ unit: 'pt', format: size[0], orientation: size[1], compress: true });
      const label = `${nameOf(s) || pathOf(s.url)}  |  ${s.url}  |  ${VIEWPORTS[s.vp].label}${parts.length > 1 ? `  |  parte ${j + 1} de ${parts.length}` : ''}`;
      doc.setFontSize(9).setTextColor(90);
      // as fontes padrão do PDF só cobrem Latin-1
      doc.text(doc.splitTextToSize(label.replace(/[^\x20-\xff]/g, ''), W - 20)[0], 10, 17);
      doc.addImage(new Uint8Array(await p.blob.arrayBuffer()), 'JPEG', 0, HEAD, W, p.h * k, `s${i}_${j}`, 'FAST');
    }
  }
  return doc.output('blob');
}
