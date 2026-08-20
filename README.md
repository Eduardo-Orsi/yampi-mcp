# yampi-mcp

Servidor MCP que deixa você conversar com sua loja [Yampi](https://www.yampi.com.br) pelo
Claude — consultar pedidos, criar produtos, ajustar estoque, montar cupons e ofertas.

Cada lojista hospeda a própria cópia na Cloudflare. **Este projeto não é um serviço:
ninguém guarda as suas credenciais além de você.** Não é oficial nem tem vínculo com a Yampi.

## Como funciona

Uma credencial da Yampi é do **usuário**, não da loja: se você tem quatro lojas no mesmo
login, as quatro aparecem automaticamente. Você conecta uma vez e escolhe a loja em cada
comando.

## Instalação

Você precisa de uma conta na Cloudflare (o plano grátis basta) e do Node instalado.

```bash
git clone https://github.com/<seu-usuario>/yampi-mcp && cd yampi-mcp
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # cole o id devolvido em wrangler.jsonc
npx wrangler deploy
```

No cliente Claude (claude.ai, Desktop ou Code), adicione um conector personalizado apontando
para `https://yampi-mcp.<seu-subdominio>.workers.dev/mcp`.

Ao conectar, abre uma tela pedindo seu **User-Token** e **User-Secret-Key**. Você os encontra
no painel da Yampi em `Perfil › Credenciais de API`. É só isso — não há senha para criar.

## Como se usa

Depois de conectar, é conversa normal:

> *"Quantos pedidos pagos entraram na loja X entre 1 e 15 de junho?"*
> *"Cria um produto chamado Camiseta Preta, marca Acme, SKU CAM-PRETA-M, R$ 79,90, 20 em estoque."*
> *"O SKU CAM-PRETA-M está com preço errado, muda para R$ 89,90 e baixa o estoque para 5."*
> *"Quais carrinhos foram abandonados essa semana e quanto somam?"*
> *"Cria um cupom de 15% válido até o fim do mês, mínimo de R$ 100, 50 usos."*

Com mais de uma loja na conta, diga qual — as tools exigem isso explicitamente para não
escrever na loja errada.

## O que ele faz

| Tool | O que faz |
|---|---|
| `descrever_loja` | Lojas, status de pedido, categorias e marcas — o mapa, para não adivinhar identificadores |
| `buscar_pedidos` | Pedidos com filtro de status, período e texto livre |
| `detalhar_pedido` | Um pedido com itens, cliente, pagamentos, endereço e histórico |
| `buscar_produtos` | Catálogo com SKUs, preços e imagens |
| `detalhar_produto` | Um produto com variações, estoque, marca e categorias |
| `buscar_clientes` | Clientes e endereços |
| `historico_cliente` | Um cliente e todos os pedidos dele |
| `carrinhos_abandonados` | Carrinhos que não viraram pedido |
| `criar_produto` | Cadastra produto com SKUs |
| `atualizar_produto` | Altera campos de um produto |
| `gerenciar_sku` | Cria SKU ou atualiza preço e estoque em lote |
| `criar_cupom` | Cupom de desconto |
| `avancar_status_pedido` ⚠️ | Move o pedido para outro status |
| `comentar_pedido` ⚠️ | Comentário interno no pedido |
| `gerenciar_ofertas` | Cashback, order bump, upsell e brinde |

⚠️ **Não validadas contra a API real.** As outras treze foram executadas ponta a ponta numa
loja de verdade — criando produto, alterando preço, gravando estoque, emitindo cupom — e os
nomes de campo saíram corrigidos desse processo. Estas duas exigem um pedido existente, e a
loja de testes disponível não tinha nenhum. Os endpoints estão certos; o corpo da requisição
vem da documentação, que nas outras cinco escritas se mostrou incompleta em pelo menos um
campo obrigatório cada. Espere um 422 na primeira chamada — a mensagem dirá qual campo falta.

## O que ele deliberadamente não faz

**Não cancela pedido, não estorna compra e não troca gateway de pagamento.** Não é uma
funcionalidade desligada por variável de ambiente: o código não existe. São as operações
irreversíveis da API, e o Claude Desktop e o claude.ai não suportam `elicitation` — ou seja,
o servidor não teria como pedir confirmação de verdade. A ausência é a única garantia que não
depende de alguém estar prestando atenção.

O veto é aplicado em dois pontos, ambos testados: no alias do status
([`tools/escrita.ts`](src/tools/escrita.ts)) e na costura por onde toda requisição passa
([`yampi.ts`](src/yampi.ts)). Detalhes em [`docs/adr/0002`](docs/adr/0002-acao-vedada-ausente-do-codigo.md).

Também ficou de fora o **rastreio de pedido**: a Yampi limita essa rota a 3 requisições por
hora, o que torna a tool inutilizável na prática — duas chamadas e o agente trava por 20 minutos.

## Suas credenciais

- Ficam **cifradas** (AES-GCM) nas props da concessão OAuth, dentro do **seu** KV.
- A chave que as cifra é envelopada por uma chave derivada do token de acesso, e o KV guarda
  apenas o *hash* do token. **Um vazamento do KV sozinho não abre as credenciais.**
- O Claude nunca as recebe: ele só vê um token opaco.
- Revogar é apagar a concessão — as outras conexões continuam funcionando.

O `/authorize` é público e valida credenciais, então é tecnicamente um oráculo para testar
chaves roubadas. Por isso há limite de 5 tentativas por IP por minuto.

Para restringir a instância a lojas específicas:

```bash
npx wrangler secret put LOJAS_PERMITIDAS   # ex.: minha-loja,outra-loja
```

## Limites da API

A Yampi limita por rota e por minuto: 30 req/min em produtos e SKUs, 120 em leitura de
pedidos, 30 em escrita, 60 no geral. O servidor usa `include=` para trazer relacionamentos
numa chamada só em vez de N+1, lê o `X-RateLimit-Remaining` de cada resposta e avisa o modelo
quando a cota está acabando — em vez de deixá-lo descobrir com um 429.

## Quando algo dá errado

**403 em tudo, inclusive leitura.** A loja está com `active: false` no painel da Yampi. Loja
inativa recusa qualquer rota. Reative no painel e reconecte o conector.

**422 numa escrita.** A mensagem traz o campo exato que a Yampi recusou — o servidor repassa
o objeto `errors` inteiro. Normalmente o Claude se corrige sozinho na tentativa seguinte.

**"Concessão sem credencial".** O grant perdeu as props. Remova o conector e adicione de novo.

**Trocar de credencial.** Basta reconectar: uma nova concessão substitui a anterior. Para
cortar o acesso sem reconectar, apague o namespace KV.

**Uma loja não aparece na lista.** Ou está inativa, ou a credencial não a alcança. Rode
`descrever_loja` para ver o que o servidor enxerga.

## Peculiaridades da API da Yampi

Descobertas testando contra a API real, todas com potencial de queimar horas de quem for
integrar. Ficam aqui porque não estão claras na documentação:

- **Filtros exigem sintaxe de array.** `?status_id=4` é **ignorado em silêncio** e devolve a
  base inteira; `?status_id[]=4` filtra. Vale também para `active[]`. Um filtro que não filtra
  é pior que nenhum filtro: o agente resume 55 mil pedidos acreditando que viu os de julho.
- **Datas usam um formato próprio**: `?date=created_at:2026-06-01|2026-06-30`. Qualquer outra
  variação devolve 500 ou é ignorada.
- **`filters[...]` não filtra.** Ele só troca a resposta para paginação por `scroll_id`.
- **`/auth/me` é POST**, não GET, e devolve todas as lojas da credencial — porque a credencial
  é do usuário, não da loja.
- **`include` de pedidos tem enum fechado**: `items`, `customer`, `marketplace`, `status`,
  `statuses`, `shipping_address`, `promocode`, `transactions`, `comments`, `files`,
  `discounts`, `seller`, `labels`. `payments` não existe.
- **GET é cacheado por 30 minutos** do lado da Yampi. Num contexto de agente isso mente:
  criar um produto e pedir para relê-lo devolve o estado anterior. Este servidor manda
  `?skipCache=true` em toda leitura.
- **Estoque não é campo do SKU.** `quantity` no SKU fica sempre nulo — inclusive nos SKUs
  reais de uma loja em produção. O estoque vive em `/logistics/stocks` (o depósito) cruzado
  com o SKU em `/catalog/skus/{id}/stocks`. E `stock_id` **não** é o id de
  `/logistics/warehouses`, que é outro recurso.
- **`discount_type` de cupom aceita só `p` ou `v`**, não `percentage`/`fixed`.
- **Datas de cupom exigem `Y-m-d H:i:s`.** Só a data devolve 422.
- **`PUT /catalog/skus/{id}` exige `product_id` e `price_cost`** mesmo num update parcial.
- **Criar produto exige `simple`, `brand_id` e `skus.*.blocked_sale`**, nenhum deles óbvio.
- **Loja com `active: false` devolve 403 em tudo**, leitura inclusive. Este servidor filtra
  essas lojas na hora de conectar, para não oferecer ao modelo uma opção que só sabe falhar.
- **Erros 422 trazem um objeto `errors`** com o campo exato que falhou. Vale a pena repassar
  ao modelo em vez de mostrar só o código — é o que o deixa se corrigir sozinho.
- **Rastreio é limitado a 3 requisições por hora**, o que inviabiliza expô-lo como tool.

## Desenvolvimento

```bash
npm test              # 32 testes de unidade, sem rede
npm run typecheck
npm run dev           # wrangler dev
```

### Testar contra a sua loja

A suíte de unidade usa um `fetch` falso e prova a lógica do servidor. Ela não percebe se a
Yampi mudar um endpoint, um nome de campo ou a sintaxe de um filtro — e isso já aconteceu
durante o desenvolvimento deste projeto. Para essa metade existe um teste de integração
contra a API real, **somente leitura**, que não cria nem altera nada:

```bash
cp .env.example .env    # preencha com o alias e as credenciais da SUA loja
npm run test:integracao
```

Ele verifica que a descoberta de lojas funciona, que os aliases de status existem, que o
filtro por status realmente filtra, que o formato de data é aceito, que `include` expande
relacionamentos e que os headers de cota chegam. Se algum falhar, a API mudou e o servidor
vai mentir antes de quebrar.

A arquitetura tem uma regra: **nenhuma tool fala HTTP**. Tudo passa por `src/yampi.ts`. É o
que torna auditável a promessa de que o servidor não alcança as rotas vedadas — a superfície
inteira cabe em um arquivo.

Vocabulário do projeto em [`CONTEXT.md`](CONTEXT.md). Decisões em [`docs/adr/`](docs/adr/).

## Limitações conhecidas

- Não gerencia rastreio de pedido (limite de 3 req/h na Yampi inviabiliza).
- Não mexe em banners, frete grátis, descontos progressivos nem combos.
- `avancar_status_pedido` e `comentar_pedido` nunca foram executadas contra a API real.
- Estoque é escrito no primeiro estoque cadastrado da loja. Quem usa vários depósitos precisa
  ajustar `estoqueDaLoja()` em `src/tools/escrita.ts`.

## Licença

MIT — veja [LICENSE](LICENSE).
