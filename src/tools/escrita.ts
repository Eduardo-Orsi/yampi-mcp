import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { campoLoja, erro, resolverLoja, resultado, type Contexto } from "./comum";

/**
 * Ação Vedada em forma de status: cancelar um pedido na Yampi é uma mudança de
 * status, então a ausência da tool não bastaria — o cancelamento entraria pela
 * porta dos fundos de `avancar_status_pedido`.
 *
 * O guard é por alias, nunca por ID: IDs de status são dados da loja e variam
 * entre contas.
 */
const STATUS_VEDADOS = new Set(["cancelled", "refused"]);

/**
 * Portão único do cancelamento. Função pura de propósito: é o que o teste
 * consegue exercitar. Um guard trancado dentro do handler da tool é um guard
 * que ninguém verifica.
 */
export function recusarSeVedado(statusAlias: string): string | null {
  if (!STATUS_VEDADOS.has(statusAlias.trim().toLowerCase())) return null;
  return (
    `Este servidor não move pedidos para "${statusAlias}". Cancelamento e recusa são irreversíveis ` +
    `e ficam fora do alcance de qualquer agente por design — use o painel da Yampi.`
  );
}

const camposExtras = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Campos adicionais aceitos pela API da Yampi, mesclados ao corpo da requisição.");


/**
 * Estoque na Yampi não é um campo do SKU — `quantity` fica sempre nulo, inclusive
 * nos SKUs reais. Ele vive em `/logistics/stocks` (o depósito) cruzado com o SKU
 * em `/catalog/skus/{id}/stocks`. Estas duas funções escondem isso das tools.
 */
async function estoqueDaLoja(ctx: Contexto, alias: string): Promise<number> {
  const r = await ctx.client.requisitar<any>(alias, "/logistics/stocks", { query: { limit: 10 } });
  const estoques = r.data ?? [];
  if (estoques.length === 0) throw new Error("Esta loja não tem estoque cadastrado na Yampi.");
  return estoques[0].id;
}

async function definirEstoque(ctx: Contexto, alias: string, skuId: number | string, quantidade: number) {
  const stockId = await estoqueDaLoja(ctx, alias);
  const atuais = await ctx.client.requisitar<any>(alias, `/catalog/skus/${skuId}/stocks`);
  const existente = (atuais.data ?? []).find((e: any) => e.stock_id === stockId);
  return existente
    ? ctx.client.requisitar(alias, `/catalog/skus/${skuId}/stocks/${existente.id}`, {
        metodo: "PUT",
        corpo: { stock_id: stockId, quantity: quantidade },
      })
    : ctx.client.requisitar(alias, `/catalog/skus/${skuId}/stocks`, {
        metodo: "POST",
        corpo: { stock_id: stockId, quantity: quantidade },
      });
}

/** Tools de Escrita Reversível: alteram a Loja, e o Lojista consegue desfazer pelo painel. */
export function registrarEscrita(server: McpServer, ctx: Contexto) {
  const loja = campoLoja(ctx.lojas);
  const em = (l?: string) => resolverLoja(ctx.lojas, l);

  server.registerTool(
    "criar_produto",
    {
      title: "Criar produto",
      description: "Cadastra um produto com seus SKUs. Reversível: dá para desativar ou excluir pelo painel.",
      inputSchema: z.object({
        loja: loja,
        nome: z.string().min(1),
        descricao: z.string().optional(),
        marca_id: z.number().int().describe("Obrigatório pela Yampi. Use descrever_loja para listar as marcas."),
        ativo: z.boolean().default(true),
        simples: z.boolean().default(true).describe("Produto sem variações. A Yampi exige este campo."),
        skus: z
          .array(
            z.object({
              sku: z.string().describe("Código do SKU."),
              preco_venda: z.number().describe("Preço de venda em reais."),
              preco_custo: z.number().optional(),
              estoque: z.number().int().optional(),
            }),
          )
          .min(1),
        campos_extras: camposExtras,
      }),
    },
    async ({ loja: l, nome, descricao, marca_id, ativo, simples, skus, campos_extras }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, "/catalog/products", {
        metodo: "POST",
        corpo: {
          name: nome,
          description: descricao,
          brand_id: marca_id,
          active: ativo,
          simple: simples,
          skus: skus.map((s) => ({
            sku: s.sku,
            price_sale: s.preco_venda,
            price_cost: s.preco_custo,
            quantity_managed: s.estoque !== undefined,
            quantity: s.estoque,
            blocked_sale: false, // obrigatório pela Yampi; bloquear venda não é o caso de uso desta tool
          })),
          ...(campos_extras ?? {}),
        },
      });

      // Estoque é recurso à parte; só existe depois que o SKU tem id.
      const criados = (dados?.data?.skus?.data ?? []) as any[];
      for (let i = 0; i < criados.length; i++) {
        const q = skus[i]?.estoque;
        if (q !== undefined) await definirEstoque(ctx, alias, criados[i].id, q);
      }
      return resultado(ctx, `/${alias}/catalog/products`, dados);
    },
  );

  server.registerTool(
    "atualizar_produto",
    {
      title: "Atualizar produto",
      description: "Altera campos de um produto existente. Envie apenas o que muda.",
      inputSchema: z.object({
        loja: loja,
        produto_id: z.union([z.number(), z.string()]),
        nome: z.string().optional(),
        descricao: z.string().optional(),
        ativo: z.boolean().optional(),
        marca_id: z.number().int().optional(),
        campos_extras: camposExtras,
      }),
    },
    async ({ loja: l, produto_id, nome, descricao, ativo, marca_id, campos_extras }) => {
      const alias = em(l);
      const corpo: Record<string, unknown> = { ...(campos_extras ?? {}) };
      if (nome !== undefined) corpo.name = nome;
      if (descricao !== undefined) corpo.description = descricao;
      if (ativo !== undefined) corpo.active = ativo;
      if (marca_id !== undefined) corpo.brand_id = marca_id;
      if (Object.keys(corpo).length === 0) return erro("Nada para atualizar: informe ao menos um campo.");

      const dados = await ctx.client.requisitar<any>(alias, `/catalog/products/${produto_id}`, {
        metodo: "PUT",
        corpo,
      });
      return resultado(ctx, `/${alias}/catalog/products`, dados);
    },
  );

  server.registerTool(
    "gerenciar_sku",
    {
      title: "Gerenciar SKU",
      description:
        "Cria um SKU novo ou atualiza preço e estoque de SKUs existentes. " +
        "Use detalhar_produto antes para descobrir os `sku_id`.",
      inputSchema: z.object({
        loja: loja,
        produto_id: z.union([z.number(), z.string()]),
        acao: z.enum(["criar", "atualizar"]),
        skus: z
          .array(
            z.object({
              sku_id: z.union([z.number(), z.string()]).optional().describe("Obrigatório ao atualizar."),
              sku: z.string().optional().describe("Código, obrigatório ao criar."),
              preco_venda: z.number().optional(),
              preco_custo: z.number().optional().describe("A Yampi exige este campo ao atualizar."),
              estoque: z.number().int().optional(),
            }),
          )
          .min(1),
      }),
    },
    async ({ loja: l, produto_id, acao, skus }) => {
      const alias = em(l);
      const feitos: unknown[] = [];

      for (const s of skus) {
        if (acao === "criar") {
          if (!s.sku) return erro("Ao criar SKU, o campo `sku` é obrigatório.");
          const criado = await ctx.client.requisitar<any>(alias, "/catalog/skus", {
            metodo: "POST",
            corpo: {
              product_id: produto_id,
              sku: s.sku,
              price_sale: s.preco_venda,
              price_cost: s.preco_custo,
              blocked_sale: false,
            },
          });
          if (s.estoque !== undefined) await definirEstoque(ctx, alias, criado.data.id, s.estoque);
          feitos.push(criado.data);
          continue;
        }

        if (s.sku_id === undefined) {
          return erro("Ao atualizar SKU, informe `sku_id` em cada item. Use detalhar_produto para descobri-los.");
        }
        // A Yampi exige product_id e price_cost mesmo num update parcial.
        if (s.preco_venda !== undefined || s.preco_custo !== undefined) {
          if (s.preco_custo === undefined) {
            return erro(`A Yampi exige \`preco_custo\` junto de \`preco_venda\` no SKU ${s.sku_id}.`);
          }
          const at = await ctx.client.requisitar<any>(alias, `/catalog/skus/${s.sku_id}`, {
            metodo: "PUT",
            corpo: { product_id: produto_id, price_sale: s.preco_venda, price_cost: s.preco_custo },
          });
          feitos.push(at.data);
        }
        if (s.estoque !== undefined) {
          await definirEstoque(ctx, alias, s.sku_id, s.estoque);
          feitos.push({ sku_id: s.sku_id, estoque: s.estoque });
        }
      }
      return resultado(ctx, `/${alias}/catalog/skus`, feitos);
    },
  );

  server.registerTool(
    "criar_cupom",
    {
      title: "Criar cupom",
      description: "Cria um cupom de desconto. Reversível: dá para desativar pelo painel.",
      inputSchema: z.object({
        loja: loja,
        codigo: z.string().min(1).describe("Código que o cliente digita no checkout."),
        tipo: z.enum(["percentual", "valor"]).describe("percentual = % do pedido; valor = reais de desconto."),
        valor: z.number().positive(),
        valor_minimo: z.number().describe("Valor mínimo do pedido. Obrigatório pela Yampi; use 0 para sem mínimo."),
        quantidade: z.number().int().describe("Limite de usos. Obrigatório pela Yampi."),
        inicia_em: z.string().describe("Início da validade, YYYY-MM-DD. Obrigatório pela Yampi."),
        expira_em: z.string().describe("Fim da validade, YYYY-MM-DD. Obrigatório pela Yampi."),
        campos_extras: camposExtras,
      }),
    },
    async ({ loja: l, codigo, tipo, valor, valor_minimo, quantidade, inicia_em, expira_em, campos_extras }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, "/pricing/promocodes", {
        metodo: "POST",
        corpo: {
          code: codigo,
          discount_type: tipo === "percentual" ? "p" : "v", // a Yampi aceita só "p" ou "v"
          value: valor,
          min_value: valor_minimo,
          quantity: quantidade,
          start_at: `${inicia_em} 00:00:00`, // a Yampi exige Y-m-d H:i:s
          end_at: `${expira_em} 23:59:59`,
          active: true,
          ...(campos_extras ?? {}),
        },
      });
      return resultado(ctx, `/${alias}/pricing/promocodes`, dados);
    },
  );

  server.registerTool(
    "avancar_status_pedido",
    {
      title: "Avançar status do pedido",
      description:
        "Move um pedido para outro status, pelo alias (veja descrever_loja). " +
        "Não cancela nem recusa pedidos — para isso, use o painel da Yampi.",
      inputSchema: z.object({
        loja: loja,
        pedido_id: z.union([z.number(), z.string()]),
        status_alias: z.string().describe("Alias do status de destino, ex.: paid, invoiced, delivered."),
      }),
    },
    async ({ loja: l, pedido_id, status_alias }) => {
      const recusa = recusarSeVedado(status_alias);
      if (recusa) return erro(recusa);
      const alias = em(l);
      const statuses = await ctx.client.requisitar<any>(alias, "/checkout/statuses", { query: { limit: 50 } });
      const destino = (statuses.data ?? []).find((s: any) => s.alias === status_alias);
      if (!destino) {
        const validos = (statuses.data ?? [])
          .map((s: any) => s.alias)
          .filter((a: string) => !STATUS_VEDADOS.has(a))
          .join(", ");
        return erro(`Status "${status_alias}" não existe nesta loja. Válidos: ${validos}.`);
      }
      const dados = await ctx.client.requisitar<any>(alias, `/orders/${pedido_id}`, {
        metodo: "PUT",
        corpo: { status_id: destino.id },
      });
      return resultado(ctx, `/${alias}/orders`, dados);
    },
  );

  server.registerTool(
    "comentar_pedido",
    {
      title: "Comentar pedido",
      description: "Adiciona um comentário interno ao pedido. Útil para registrar o que foi combinado com o cliente.",
      inputSchema: z.object({
        loja: loja,
        pedido_id: z.union([z.number(), z.string()]),
        comentario: z.string().min(1),
        visivel_ao_cliente: z.boolean().default(false),
      }),
    },
    async ({ loja: l, pedido_id, comentario, visivel_ao_cliente }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, `/orders/${pedido_id}/comments`, {
        metodo: "POST",
        corpo: { comment: comentario, notify_customer: visivel_ao_cliente },
      });
      return resultado(ctx, `/${alias}/orders`, dados);
    },
  );
}
