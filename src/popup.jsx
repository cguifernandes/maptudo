import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertDialog, Badge, Box, Button, Callout, Card, CheckboxCards, Flex, Heading, IconButton, Inset,
  Progress, SegmentedControl, Spinner, Switch, Tabs, Text, TextField, Theme, Tooltip,
} from '@radix-ui/themes';
import {
  Camera, Check, CircleAlert, CircleDashed, Copy, CornerUpRight, Download, FileArchive, FileText,
  Globe, Images, Maximize2, Monitor, Play, Smartphone, Square, Tablet, Trash2,
} from 'lucide-react';
import '@radix-ui/themes/styles.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './popup.css';
import { db, DEFAULTS, VIEWPORTS } from './shared.js';
import { download, exportPdf, exportZip, fileName, orderTree, pathOf, sitemapMd } from './export.js';

const params = new URLSearchParams(location.search);
const isTab = params.has('tab'); // a mesma página serve de popup e de aba cheia
const VP_ICON = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };
const BUSY = ['running', 'stopping', 'capturing'];

const withScheme = url => (/^https?:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`);
const isUrl = url => { try { return !!new URL(url).hostname && !/\s/.test(url); } catch { return false; } };
const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0).replace('.', ',')} MB`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// O service worker é dono do estado; o popup só acompanha pelo chrome.storage
function useLive(key, initial) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    chrome.storage.local.get(key).then(r => r[key] && setValue(r[key]));
    const on = (changes, area) => area === 'local' && changes[key] && setValue(changes[key].newValue ?? initial);
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);
  return value;
}

const Logo = () => (
  <svg width="22" height="22" viewBox="0 0 128 128" aria-hidden="true">
    <rect width="128" height="128" rx="28" fill="var(--accent-9)" />
    <rect x="28" y="34" width="54" height="42" rx="7" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="8" />
    <rect x="46" y="52" width="54" height="42" rx="7" fill="var(--accent-9)" stroke="#fff" strokeWidth="8" />
  </svg>
);

const Empty = ({ icon: Icon, title, children }) => (
  <div className="empty">
    <Icon size={28} strokeWidth={1.5} color="var(--gray-9)" />
    <Text size="3" weight="medium">{title}</Text>
    <Text size="2" color="gray">{children}</Text>
  </div>
);

const Option = ({ title, hint, ...props }) => (
  <label className="option">
    <Box>
      <Text as="div" size="2" weight="medium">{title}</Text>
      <Text as="div" size="1" color="gray">{hint}</Text>
    </Box>
    <Switch size="1" {...props} />
  </label>
);

function Capture({ cfg, setCfg, state, tabId, last, onSee }) {
  const busy = BUSY.includes(state.status);
  const crawling = state.status === 'running' || state.status === 'stopping';
  const url = withScheme(cfg.url);
  const run = cmd => chrome.runtime.sendMessage({
    cmd, tabId,
    cfg: { ...cfg, url, maxPages: Math.max(1, cfg.maxPages || 1), delay: Math.max(0, cfg.delay || 0) },
  });
  const done = state.pages.filter(p => p.status === 'done').length;
  const pending = state.pages.filter(p => p.status === 'queued' || p.status === 'loading').length;
  const total = Math.max(1, Math.min(done + pending, state.max || Infinity));

  return (
    <>
      <div className="scroll">
        <label className="field">
          <Text size="2" weight="medium">Onde começar</Text>
          <TextField.Root placeholder="localhost:3000" value={cfg.url} disabled={busy} onChange={e => setCfg({ url: e.target.value })}>
            <TextField.Slot><Globe size={15} /></TextField.Slot>
          </TextField.Root>
          <Text size="1" color="gray">Entre na sua conta antes, se o site pedir. O mapeamento segue os links internos a partir daqui.</Text>
        </label>

        <div className="field">
          <Text size="2" weight="medium">Tamanhos de tela</Text>
          <CheckboxCards.Root
            size="1" columns="3" gap="2" value={cfg.viewports}
            onValueChange={v => v.length && setCfg({ viewports: Object.keys(VIEWPORTS).filter(k => v.includes(k)) })}
          >
            {Object.entries(VIEWPORTS).map(([k, v]) => {
              const Icon = VP_ICON[k];
              return (
                <CheckboxCards.Item key={k} value={k} disabled={busy}>
                  <Flex direction="column" gap="1">
                    <Icon size={16} />
                    <Text size="2" weight="medium">{v.label}</Text>
                    <Text size="1" color="gray">{v.width} × {v.height}</Text>
                  </Flex>
                </CheckboxCards.Item>
              );
            })}
          </CheckboxCards.Root>
        </div>

        <Flex gap="3">
          <label className="field" style={{ flex: 1 }}>
            <Text size="2" weight="medium">Máximo de telas</Text>
            <TextField.Root type="number" min="1" value={cfg.maxPages} disabled={busy} onChange={e => setCfg({ maxPages: +e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <Text size="2" weight="medium">Espera por tela</Text>
            <TextField.Root type="number" min="0" step="100" value={cfg.delay} disabled={busy} onChange={e => setCfg({ delay: +e.target.value })}>
              <TextField.Slot side="right">ms</TextField.Slot>
            </TextField.Root>
          </label>
        </Flex>

        <div className="field">
          <Text size="2" weight="medium">Formato do print</Text>
          <SegmentedControl.Root value={cfg.format} disabled={busy} onValueChange={format => setCfg({ format })}>
            <SegmentedControl.Item value="png">PNG, sem perda</SegmentedControl.Item>
            <SegmentedControl.Item value="jpeg">JPEG, mais leve</SegmentedControl.Item>
          </SegmentedControl.Root>
        </div>

        <div>
          <Option title="Agrupar telas repetidas" hint="/produto/1 e /produto/2 viram uma tela só" disabled={busy} checked={cfg.groupDynamic} onCheckedChange={groupDynamic => setCfg({ groupDynamic })} />
          <Option title="Ignorar filtros e paginação" hint="?page=2 conta como a mesma tela" disabled={busy} checked={cfg.ignoreQuery} onCheckedChange={ignoreQuery => setCfg({ ignoreQuery })} />
          <Option title="Rolar a página antes do print" hint="Carrega imagens que só aparecem ao rolar" disabled={busy} checked={cfg.lazyScroll} onCheckedChange={lazyScroll => setCfg({ lazyScroll })} />
        </div>

        <label className="field" style={{ marginTop: 16, marginBottom: 0 }}>
          <Text size="2" weight="medium">Não visitar endereços que contenham</Text>
          <TextField.Root value={cfg.exclude} disabled={busy} onChange={e => setCfg({ exclude: e.target.value })} />
          <Text size="1" color="gray">O mapeamento abre todo link que encontra. Deixe aqui os que mudam alguma coisa, como sair ou excluir.</Text>
        </label>
      </div>

      <div className="bar">
        {state.error && (
          <Callout.Root color="red" size="1" mb="3">
            <Callout.Icon><CircleAlert size={14} /></Callout.Icon>
            <Callout.Text>{state.error}</Callout.Text>
          </Callout.Root>
        )}
        {crawling ? (
          <div className="live">
            {last ? <img src={last.thumb} alt="" /> : <div className="blank" />}
            <Box flexGrow="1" minWidth="0">
              <Text as="div" size="2" weight="medium">Mapeando tela {Math.min(done + 1, total)} de {total}</Text>
              <Text as="div" size="1" color="gray" truncate>{state.current ? pathOf(state.current) : 'Preparando'}</Text>
              <Progress size="1" mt="2" value={(done / total) * 100} />
            </Box>
            <Button color="gray" variant="soft" disabled={state.status === 'stopping'} onClick={() => chrome.runtime.sendMessage({ cmd: 'stop' })}>
              <Square size={12} /> {state.status === 'stopping' ? 'Parando' : 'Parar'}
            </Button>
          </div>
        ) : (
          <>
            {done > 0 && (
              <Flex justify="between" align="center" mb="3">
                <Text size="2">
                  {state.status === 'stopped' ? 'Mapeamento interrompido com ' : 'Mapeamento concluído com '}
                  <Text weight="medium">{plural(done, 'tela', 'telas')}</Text>
                </Text>
                <Button size="1" variant="ghost" onClick={onSee}>Ver telas</Button>
              </Flex>
            )}
            <Flex gap="2">
              <Button size="3" style={{ flex: 1 }} disabled={busy || !isUrl(url)} onClick={() => run('start')}>
                <Play size={15} /> Mapear site
              </Button>
              {tabId && (
                <Button size="3" variant="soft" loading={state.status === 'capturing'} onClick={() => run('capture')}>
                  <Camera size={15} /> Capturar esta tela
                </Button>
              )}
            </Flex>
            <Text as="div" size="1" color="gray" mt="2">
              Enquanto captura, o Chrome avisa que a extensão está depurando a aba. É esperado.
              {tabId && ' Alt+Shift+S captura a tela atual sem abrir esta janela.'}
            </Text>
          </>
        )}
      </div>
    </>
  );
}

function ShotCard({ shot, index, onDelete }) {
  return (
    <Card size="1" className="shot">
      <Inset side="top" clip="padding-box" pb="current">
        <a href={`popup.html?view=${shot.id}`} target="_blank" rel="noreferrer" title="Abrir em tamanho real">
          <img className="thumb" src={shot.thumb} alt="" />
        </a>
      </Inset>
      <Text as="div" size="2" weight="medium" truncate>{shot.title || pathOf(shot.url)}</Text>
      <Text as="div" size="1" color="gray" truncate>{pathOf(shot.url)}</Text>
      <Flex justify="between" align="center" mt="2">
        <Flex gap="1">
          <Badge color="gray">{VIEWPORTS[shot.vp].label}</Badge>
          {shot.manual && <Badge color="amber">manual</Badge>}
        </Flex>
        <Flex gap="3" className="actions">
          <Tooltip content="Baixar">
            <IconButton size="1" variant="ghost" color="gray" aria-label="Baixar" onClick={() => download(shot.blob, fileName(shot, index))}>
              <Download size={14} />
            </IconButton>
          </Tooltip>
          <Tooltip content="Remover">
            <IconButton size="1" variant="ghost" color="gray" aria-label="Remover" onClick={onDelete}>
              <Trash2 size={14} />
            </IconButton>
          </Tooltip>
        </Flex>
      </Flex>
    </Card>
  );
}

function Shots({ shots, pages, cfg, setCfg, reload }) {
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const sizes = Object.keys(VIEWPORTS).filter(k => shots.some(s => s.vp === k));
  const active = sizes.includes(filter) ? filter : 'all';
  const list = active === 'all' ? shots : shots.filter(s => s.vp === active);

  if (!shots.length) {
    return <Empty icon={Images} title="Nenhuma tela ainda">Mapeie o site ou capture a tela aberta. Os prints aparecem aqui.</Empty>;
  }

  // Exporta o que está na lista (respeita o filtro de tamanho)
  const save = async kind => {
    setBusy(kind);
    setError('');
    try {
      const blob = kind === 'zip' ? await exportZip(list, pages, cfg.split) : await exportPdf(list, cfg.split);
      download(blob, `maptudo_${new URL(list[0].url).host.replace(/[^\w.-]/g, '_')}.${kind}`);
    } catch (e) {
      setError(`Não deu para gerar o ${kind.toUpperCase()}: ${e.message}`);
    }
    setBusy('');
  };

  return (
    <>
      <div className="scroll">
        <Flex justify="between" align="center" mb="3" gap="3">
          <Text size="2" color="gray">{plural(list.length, 'tela', 'telas')}, {mb(list.reduce((n, s) => n + s.blob.size, 0))}</Text>
          {sizes.length > 1 && (
            <SegmentedControl.Root size="1" value={active} onValueChange={setFilter}>
              <SegmentedControl.Item value="all">Todas</SegmentedControl.Item>
              {sizes.map(k => <SegmentedControl.Item key={k} value={k}>{VIEWPORTS[k].label}</SegmentedControl.Item>)}
            </SegmentedControl.Root>
          )}
        </Flex>
        <div className="grid">
          {list.map(s => <ShotCard key={s.id} shot={s} index={shots.indexOf(s)} onDelete={() => db.del(s.id).then(reload)} />)}
        </div>
      </div>

      <div className="bar">
        {error && (
          <Callout.Root color="red" size="1" mb="3">
            <Callout.Icon><CircleAlert size={14} /></Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        <Option title="Dividir telas longas em partes" hint="IAs leem melhor imagens que não são muito altas" checked={cfg.split} onCheckedChange={split => setCfg({ split })} />
        <Flex gap="2" mt="1">
          <Button style={{ flex: 1 }} loading={busy === 'zip'} disabled={!!busy} onClick={() => save('zip')}>
            <FileArchive size={15} /> Baixar ZIP
          </Button>
          <Button style={{ flex: 1 }} variant="soft" loading={busy === 'pdf'} disabled={!!busy} onClick={() => save('pdf')}>
            <FileText size={15} /> Baixar PDF
          </Button>
          <AlertDialog.Root>
            <Tooltip content="Limpar tudo">
              <AlertDialog.Trigger>
                <IconButton color="red" variant="soft" aria-label="Limpar tudo"><Trash2 size={15} /></IconButton>
              </AlertDialog.Trigger>
            </Tooltip>
            <AlertDialog.Content maxWidth="340px" size="2">
              <AlertDialog.Title size="3">Limpar tudo?</AlertDialog.Title>
              <AlertDialog.Description size="2">
                Remove {plural(shots.length, 'tela capturada', 'telas capturadas')} e o mapa de rotas. Não dá para desfazer.
              </AlertDialog.Description>
              <Flex gap="2" mt="4" justify="end">
                <AlertDialog.Cancel><Button variant="soft" color="gray">Cancelar</Button></AlertDialog.Cancel>
                <AlertDialog.Action>
                  <Button color="red" onClick={() => chrome.runtime.sendMessage({ cmd: 'clear' })}>Limpar tudo</Button>
                </AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Flex>
      </div>
    </>
  );
}

const STATUS = {
  done: <Check size={14} color="var(--accent-11)" />,
  loading: <Spinner size="1" />,
  queued: <CircleDashed size={14} color="var(--gray-8)" />,
  skipped: <CornerUpRight size={14} color="var(--gray-9)" />,
  error: <CircleAlert size={14} color="var(--red-10)" />,
};

function RouteMap({ pages }) {
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => orderTree(pages), [pages]);
  const count = status => pages.filter(p => p.status === status).length;
  if (!rows.length) {
    return <Empty icon={Globe} title="Nenhuma rota ainda">O mapa mostra cada endereço encontrado e de qual tela ele saiu.</Empty>;
  }
  const summary = [
    [count('done'), 'capturada', 'capturadas'], [count('queued') + count('loading'), 'na fila', 'na fila'],
    [count('skipped'), 'pulada', 'puladas'], [count('error'), 'com erro', 'com erro'],
  ].filter(([n]) => n).map(([n, one, many]) => plural(n, one, many)).join(', ');
  const copy = async () => {
    await navigator.clipboard.writeText(sitemapMd(pages));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="scroll">
      <Flex justify="between" align="center" mb="3" gap="3">
        <Text size="2" color="gray">{summary}</Text>
        <Button size="1" variant="soft" onClick={copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Mapa copiado' : 'Copiar mapa'}
        </Button>
      </Flex>
      <div className="tree">
        {rows.map((p, i) => (
          <a key={i} className="row" data-status={p.status} href={p.url} target="_blank" rel="noreferrer" title={p.note || p.url}>
            {Array.from({ length: p.depth }, (_, d) => <span key={d} className="guide" />)}
            {STATUS[p.status]}
            <span className="path">{pathOf(p.url)}</span>
            <span className="rest">{p.note || p.title}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function App() {
  const state = useLive('state', { status: 'idle', pages: [], rev: 0 });
  const [cfg, setCfgState] = useState(DEFAULTS);
  const [tabId, setTabId] = useState();
  const [shots, setShots] = useState([]);
  const [tab, setTab] = useState('capture');

  useEffect(() => {
    (async () => {
      const next = { ...DEFAULTS, ...(await chrome.storage.local.get('cfg')).cfg };
      if (!isTab) {
        // No popup, parte da aba aberta (já logada)
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (/^https?:/.test(t?.url)) { next.url = t.url; setTabId(t.id); }
      }
      setCfgState(next);
    })();
  }, []);
  const setCfg = patch => {
    const next = { ...cfg, ...patch };
    setCfgState(next);
    chrome.storage.local.set({ cfg: next });
  };

  const reload = () => db.all().then(setShots);
  useEffect(() => { reload(); }, [state.rev]);

  return (
    <div className="app">
      <header className="top">
        <Flex align="center" gap="2">
          <Logo />
          <Heading size="3" weight="medium">MapTudo</Heading>
        </Flex>
        {!isTab && (
          <Tooltip content="Abrir em uma aba">
            <IconButton variant="ghost" color="gray" aria-label="Abrir em uma aba" onClick={() => chrome.tabs.create({ url: 'popup.html?tab' })}>
              <Maximize2 size={15} />
            </IconButton>
          </Tooltip>
        )}
      </header>
      <Tabs.Root className="tabs" value={tab} onValueChange={setTab}>
        <Tabs.List>
          <Tabs.Trigger value="capture">Capturar</Tabs.Trigger>
          <Tabs.Trigger value="shots">Telas{shots.length > 0 && ` (${shots.length})`}</Tabs.Trigger>
          <Tabs.Trigger value="map">Mapa</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content className="pane" value="capture">
          <Capture cfg={cfg} setCfg={setCfg} state={state} tabId={tabId} last={shots.at(-1)} onSee={() => setTab('shots')} />
        </Tabs.Content>
        <Tabs.Content className="pane" value="shots">
          <Shots shots={shots} pages={state.pages} cfg={cfg} setCfg={setCfg} reload={reload} />
        </Tabs.Content>
        <Tabs.Content className="pane" value="map">
          <RouteMap pages={state.pages} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function Viewer({ id }) {
  const [shot, setShot] = useState();
  const src = useMemo(() => shot && URL.createObjectURL(shot.blob), [shot]);
  useEffect(() => { db.get(id).then(s => setShot(s ?? null)); }, [id]);
  if (shot === null) return <Empty icon={Images} title="Esta tela foi removida">Volte à extensão e capture de novo.</Empty>;
  if (!shot) return null;
  const vp = VIEWPORTS[shot.vp];
  return (
    <div className="viewer">
      <header>
        <Box flexGrow="1" minWidth="0">
          <Text as="div" size="2" weight="medium" truncate>{shot.title || pathOf(shot.url)}</Text>
          <Text as="div" size="1" color="gray" truncate>{shot.url}</Text>
        </Box>
        <Badge color="gray">{vp.label} {shot.width} × {shot.height}</Badge>
        <Button variant="soft" onClick={() => download(shot.blob, fileName(shot, shot.id - 1))}>
          <Download size={14} /> Baixar
        </Button>
      </header>
      <img src={src} style={{ width: shot.width / vp.dpr }} alt={shot.title} />
    </div>
  );
}

if (isTab || params.has('view')) document.body.classList.add('tab');
createRoot(document.getElementById('root')).render(
  <Theme accentColor="jade" grayColor="sage" radius="medium" appearance={matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}>
    {params.has('view') ? <Viewer id={+params.get('view')} /> : <App />}
  </Theme>,
);
