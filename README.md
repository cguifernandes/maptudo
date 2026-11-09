# MapTudo

Extensão para Chrome que mapeia todas as telas de um site e tira prints de página inteira em desktop, tablet e celular. Exporta em ZIP ou PDF com o mapa de rotas, pronto para usar em redesign com IA.

## O que ela faz

- **Mapeia o site**: a partir de um endereço, segue os links internos e tira um print de página inteira de cada tela, no tamanho de desktop, tablet e celular.
- **Modais e telas atrás de botões**: opcionalmente clica nos botões de cada tela e captura o que aparece: modais, telas que só abrem por um botão e trechos liberados na mesma tela.
- **Captura manual**: `Alt+Shift+S` tira o print da tela aberta no estado em que está (modal aberta, aba selecionada), sem passar pelo mapeamento.
- **Layouts de painel**: quando a página é fixa e só uma área interna rola, o print estica até mostrar o conteúdo todo. O mesmo vale para modais altas.
- **Telas repetidas**: `/produto/1` e `/produto/2` contam como uma tela só, assim como `?page=2`. Dá para desligar.
- **Exporta**: ZIP com os prints e um `mapa.md` ligando cada arquivo à sua rota, ou um PDF com uma página por print. Prints longos podem ser divididos em partes, que IAs leem melhor.
- **Mapa de rotas**: árvore mostrando de qual tela cada rota foi descoberta, com cópia em Markdown.

## Instalação

```bash
npm install
npm run build
```

Depois, no Chrome:

1. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
2. Clique em **Carregar sem compactação** e escolha a pasta `dist/`.

Sempre que rodar `npm run build` de novo, clique em recarregar na extensão.

## Como usar

1. Abra o site que quer mapear e entre na sua conta, se precisar.
2. Clique no ícone da extensão. O endereço da aba já vem preenchido.
3. Ajuste os quatro passos (abaixo) e clique em **Mapear site**.
4. Acompanhe pela aba **Telas**. Quando terminar, baixe o ZIP ou o PDF.

Durante a captura o Chrome mostra uma faixa dizendo que a extensão está depurando a aba. É esperado: é o que permite o print de página inteira. Clicar em Cancelar nessa faixa interrompe o mapeamento.

Para uma tela que o mapeamento não alcança (um passo de formulário, uma modal com estado específico), abra a tela na mão e use **Capturar esta tela** no popup ou `Alt+Shift+S`. As capturas manuais ficam guardadas até você usar **Limpar tudo**; um novo mapeamento substitui só as capturas automáticas.

### Os quatro passos

| Passo | O que define |
|---|---|
| **Onde começar** | Endereço inicial. O mapeamento fica dentro desse domínio. |
| **Tamanho da tela** | Desktop (1440), Tablet (768) e Celular (390, em 2x). Um print de cada por tela. |
| **Captura** | Máximo de telas, espera depois de cada carregamento (para SPAs e animações), PNG ou JPEG, e se rola a página antes do print para carregar imagens sob demanda. |
| **Regras de navegação** | Botões e modais, agrupamento de telas repetidas, e os endereços que não devem ser visitados. |

### Botões e modais

| Opção | Comportamento |
|---|---|
| **Não clicar** | Só as telas que têm link. Nenhum botão é clicado. |
| **Só modais** | Clica só nos botões que o código indica que abrem uma modal: `<dialog>`, atributos como `aria-haspopup="dialog"` e `data-bs-toggle="modal"`, e handlers `onClick` do React que mencionam abrir uma modal (funciona em build de desenvolvimento; em produção os nomes somem). |
| **Testar botões** | Clica em todo botão da tela, inclusive links para fora do site (sem sair dele), e captura modais, telas abertas pelo clique e trechos liberados na mesma tela. |

**"Testar botões" é para ambiente de teste.** Ele pula botões com nomes como excluir, salvar, enviar e pagar, ignora formulários e sempre recusa caixas de confirmação do navegador, mas um botão com nome inocente que chama uma API vai ser clicado. O campo **Não visitar endereços que contenham** vale tanto para links quanto para botões.

## Exportação

- **ZIP**: um arquivo por print, nomeado por ordem, rota e tamanho (`007_pedidos_modal-filtros_desktop.png`), mais um `mapa.md` com a tabela de telas e a árvore de rotas.
- **PDF**: uma página por print, com título, endereço e tamanho no topo.
- **Dividir telas longas em partes**: ligado por padrão. Prints muito altos viram pedaços de cerca de 1,6x a largura, porque modelos de IA reduzem imagens altas até o texto ficar ilegível. Desligue para ter cada tela em uma imagem só.

## Limitações

- Só descobre telas por `<a href>` e, no modo "Testar botões", por cliques. Menus suspensos e selects não são capturados.
- A detecção de "trecho liberado" é por texto: um clique precisa fazer aparecer 150+ caracteres novos para contar. Mudanças só visuais não são percebidas.
- Vai um nível só: os botões dentro de uma tela aberta por botão não são testados. Limite de 30 botões por tela.
- Telas com mais de cerca de 16.000 px de altura são cortadas nesse ponto.
- A aba precisa ficar visível durante o mapeamento.

## Desenvolvimento

```
src/
  popup.jsx       interface (React + Radix Themes)
  popup.css
  background.js   service worker: navega, clica, tira os prints
  export.js       ZIP, PDF e mapa em Markdown
  shared.js       tamanhos de tela, padrões e IndexedDB
public/
  manifest.json
  icons/
```

- `npm run build` gera `dist/`; `npm run dev` fica observando mudanças.
- Os prints ficam em IndexedDB; o estado do mapeamento, em `chrome.storage.local`. O popup só lê o estado: quem trabalha é o service worker, por isso fechar o popup não interrompe nada.
- `map.js` é um script Node avulso, anterior à extensão, que faz um mapeamento simples com Playwright. Não é usado pela extensão.
