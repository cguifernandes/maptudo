import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertDialog, Badge, Box, Button, Callout, Card, CheckboxCards, Flex, IconButton, Inset,
  Progress, Spinner, Switch, Tabs, Text, TextField, Theme, Tooltip,
} from '@radix-ui/themes';
import {
  Camera, Check, CircleAlert, CircleDashed, Copy, CornerUpRight, Download, FileArchive, FileText,
  Globe, Images, Maximize2, Minus, Monitor, Play, Plus, Smartphone, Square, Tablet, Trash2,
} from 'lucide-react';
import '@radix-ui/themes/styles.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './popup.css';
import { db, DEFAULTS, VIEWPORTS } from './shared.js';
import { download, exportPdf, exportZip, fileName, nameOf, orderTree, pathOf, sitemapMd } from './export.js';

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

const MODALS_HINT = {
  off: 'Só as telas que têm link. Nenhum botão é clicado.',
  code: 'Clica só nos botões que o código da página indica que abrem uma modal e tira um print de cada uma.',
  all: 'Clica em todo botão da tela, inclusive links para fora do site (sem sair dele), e captura o que aparecer: modais, telas que só abrem por um botão e trechos liberados na mesma tela. Um clique pode alterar dados: use em ambiente de teste.',
};

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

// Abas em pílula: uma faixa com respiro em volta e espaço entre os botões
const Segmented = ({ label, value, onChange, options, disabled, small }) => (
  <div className={small ? 'seg small' : 'seg'} role="radiogroup" aria-label={label}>
    {options.map(([v, text]) => (
      <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabled} onClick={() => onChange(v)}>{text}</button>
    ))}
  </div>
);

// Um passo da configuração: card com o número e o título
const Step = ({ n, title, children }) => (
  <Card size="2" className="step">
    <Flex align="center" gap="2" mb="3">
      <span className="num">{n}</span>
      <Text size="2" weight="bold">{title}</Text>
    </Flex>
    {children}
  </Card>
);

// Campo numérico com − à esquerda e + à direita. Os botões andam de `step` em `step`
// (50 → 60 → 70); digitando, vale qualquer número a partir de `min`.
function Stepper({ label, value, onChange, step, min, unit, disabled }) {
  const move = dir => onChange(Math.max(min, (dir > 0 ? Math.floor(value / step) + 1 : Math.ceil(value / step) - 1) * step));
  return (
    <div className="field" style={{ flex: 1 }}>
      <Text size="2" weight="medium">{label}</Text>
      <TextField.Root
        size="3" className="stepper" inputMode="numeric" aria-label={label} value={value} disabled={disabled}
        onChange={e => onChange(+e.target.value.replace(/\D/g, ''))} onBlur={() => value < min && onChange(min)}
      >
        <TextField.Slot side="left">
          <IconButton size="2" variant="soft" color="gray" aria-label={`Diminuir ${label.toLowerCase()}`} disabled={disabled || value <= min} onClick={() => move(-1)}>
            <Minus size={15} />
          </IconButton>
        </TextField.Slot>
        <TextField.Slot side="right">
          {unit && <Text size="1" color="gray">{unit}</Text>}
          <IconButton size="2" variant="soft" color="gray" aria-label={`Aumentar ${label.toLowerCase()}`} disabled={disabled} onClick={() => move(1)}>
            <Plus size={15} />
          </IconButton>
        </TextField.Slot>
      </TextField.Root>
    </div>
  );
}

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
      <div className="scroll steps">
        <Step n={1} title="Onde começar">
          <div className="field">
            <TextField.Root aria-label="Onde começar" placeholder="localhost:3000" value={cfg.url} disabled={busy} onChange={e => setCfg({ url: e.target.value })}>
              <TextField.Slot><Globe size={15} /></TextField.Slot>
            </TextField.Root>
            <Text size="1" color="gray">Entre na sua conta antes, se o site pedir. O mapeamento segue os links internos a partir daqui.</Text>
          </div>
        </Step>

        <Step n={2} title="Tamanho da tela">
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
                    <Text size="1" color="gray" wrap="nowrap">{v.width} × {v.height}</Text>
                  </Flex>
                </CheckboxCards.Item>
              );
            })}
          </CheckboxCards.Root>
        </Step>

        <Step n={3} title="Captura">
          <Flex gap="3">
            <Stepper label="Máximo de telas" value={cfg.maxPages} step={10} min={1} disabled={busy} onChange={maxPages => setCfg({ maxPages })} />
            <Stepper label="Espera por tela" value={cfg.delay} step={100} min={0} unit="ms" disabled={busy} onChange={delay => setCfg({ delay })} />
          </Flex>
          <div className="field">
            <Text size="2" weight="medium">Formato do print</Text>
            <Segmented
              label="Formato do print" value={cfg.format} disabled={busy} onChange={format => setCfg({ format })}
              options={[['png', 'PNG, sem perda'], ['jpeg', 'JPEG, mais leve']]}
            />
          </div>
          <div>
            <Option title="Rolar a página antes do print" hint="Carrega imagens que só aparecem ao rolar" disabled={busy} checked={cfg.lazyScroll} onCheckedChange={lazyScroll => setCfg({ lazyScroll })} />
          </div>
        </Step>

        <Step n={4} title="Regras de navegação">
          <div className="field">
            <Text size="2" weight="medium">Botões e modais</Text>
            <Segmented
              label="Botões e modais" value={cfg.modals} disabled={busy} onChange={modals => setCfg({ modals })}
              options={[['off', 'Não clicar'], ['code', 'Só modais'], ['all', 'Testar botões']]}
            />
            <Text size="1" color={cfg.modals === 'all' ? 'amber' : 'gray'}>{MODALS_HINT[cfg.modals]}</Text>
          </div>
          <div>
            <Option title="Agrupar telas repetidas" hint="/produto/1 e /produto/2 viram uma tela só" disabled={busy} checked={cfg.groupDynamic} onCheckedChange={groupDynamic => setCfg({ groupDynamic })} />
            <Option title="Ignorar filtros e paginação" hint="?page=2 conta como a mesma tela" disabled={busy} checked={cfg.ignoreQuery} onCheckedChange={ignoreQuery => setCfg({ ignoreQuery })} />
          </div>
          <label className="field" style={{ marginTop: 12 }}>
            <Text size="2" weight="medium">Não visitar endereços que contenham</Text>
            <TextField.Root value={cfg.exclude} disabled={busy} onChange={e => setCfg({ exclude: e.target.value })} />
          </label>
        </Step>
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
              <Text as="div" size="1" color="gray" truncate>
                {!state.current ? 'Preparando' : state.phase === 'modals' ? `Abrindo modais em ${pathOf(state.current)}` : pathOf(state.current)}
              </Text>
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
          <img className="thumb" src={shot.thumb} alt="" style={shot.modal ? { objectPosition: 'center' } : undefined} />
        </a>
      </Inset>
      <Text as="div" size="2" weight="medium" truncate>{shot.modal || shot.title || pathOf(shot.url)}</Text>
      <Text as="div" size="1" color="gray" truncate>{shot.via ? `Após clicar em "${shot.via}"` : pathOf(shot.url)}</Text>
      <Flex justify="between" align="center" mt="2">
        <Flex gap="1">
          <Badge color="gray">{VIEWPORTS[shot.vp].label}</Badge>
          {shot.modal && <Badge>modal</Badge>}
          {shot.via && <Badge>botão</Badge>}
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
            <Segmented small label="Tamanho" value={active} onChange={setFilter} options={[['all', 'Todas'], ...sizes.map(k => [k, VIEWPORTS[k].label])]} />
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
            <span className="rest">{p.note || p.title}{p.via && `, pelo botão "${p.via}"`}{p.modals > 0 && `, ${plural(p.modals, 'modal', 'modais')}`}{p.states > 0 && `, ${p.states} após clique`}</span>
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
      {!isTab && (
        <Tooltip content="Abrir em uma aba">
          <IconButton className="expand" variant="ghost" color="gray" aria-label="Abrir em uma aba" onClick={() => chrome.tabs.create({ url: 'popup.html?tab' })}>
            <Maximize2 size={15} />
          </IconButton>
        </Tooltip>
      )}
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
          <Text as="div" size="2" weight="medium" truncate>{nameOf(shot) || pathOf(shot.url)}</Text>
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
  <Theme accentColor="lime" grayColor="olive" radius="medium" panelBackground="solid" appearance={matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}>
    {params.has('view') ? <Viewer id={+params.get('view')} /> : <App />}
  </Theme>,
);
