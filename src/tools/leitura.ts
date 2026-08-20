import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { campoLoja, campoPagina, erro, resolverLoja, resultado, type Contexto } from "./comum";

/** Tools de Leitura: apenas consultam a Loja. Sempre disponíveis. */
export function registrarLeitura(server: McpServer, ctx: Contexto) {
  const loja = campoLoja(ctx.lojas);
  const em = (l?: string) => resolverLoja(ctx.lojas, l);

  server.registerTool(
    "descrever_loja",
    {
      title: "Descrever loja",
      description:
        "Mapa da loja: lojas disponíveis nesta credencial, status de pedido (com alias), categorias e marcas. " +
        "Chame antes de filtrar por status ou categoria em vez de adivinhar identificadores.",
      inputSchema: z.object({ loja: loja }),
    },
    async ({ loja: l }) => {
      const alias = em(l);
      const [statuses, categorias, marcas] = await Promise.all([
        ctx.client.requisitar<any>(alias, "/checkout/statuses", { query: { limit: 50 } }),
        ctx.client.requisitar<any>(alias, "/catalog/categories", { query: { limit: 50 } }),
        ctx.client.requisitar<any>(alias, "/catalog/brands", { query: { limit: 50 } }),
      ]);
      return resultado(ctx, `/${alias}/checkout/statuses`, {
        lojas_nesta_credencial: ctx.lojas,
        loja_consultada: alias,
        status_de_pedido: (statuses.data ?? []).map((s: any) => ({
          alias: s.alias,
          nome: s.name,
          id: s.id,
        })),
        categorias: (categorias.data ?? []).map((c: any) => ({ id: c.id, nome: c.name })),
        marcas: (marcas.data ?? []).map((m: any) => ({ id: m.id, nome: m.name })),
      });
    },
  );

  server.registerTool(
    "buscar_pedidos",
    {
      title: "Buscar pedidos",
      description:
        "Lista pedidos com filtros de status, período e texto. Já traz itens, cliente, transações e status " +
        "na mesma chamada. Limite da rota: 120 requisições por minuto.",
      inputSchema: z.object({
        loja: loja,
        status_alias: z
          .array(z.string())
          .optional()
          .describe("Aliases de status, ex.: [\"paid\", \"invoiced\"]. Veja descrever_loja."),
        criado_de: z.string().optional().describe("Data inicial YYYY-MM-DD."),
        criado_ate: z.string().optional().describe("Data final YYYY-MM-DD. Sem ela, filtra só o dia de criado_de."),
        busca: z.string().optional().describe("Texto livre: nome, e-mail ou número do pedido."),
        ...campoPagina,
      }),
    },
    async ({ loja: l, status_alias, criado_de, criado_ate, busca, limit, page }) => {
      const alias = em(l);

      // A Yampi filtra por status_id, mas IDs são dados da loja. O alias é a
      // chave estável, então traduzimos aqui em vez de expor número ao modelo.
      let status_id: number[] | undefined;
      if (status_alias?.length) {
        const statuses = await ctx.client.requisitar<any>(alias, "/checkout/statuses", {
          query: { limit: 50 },
        });
        const porAlias = new Map<string, number>(
          (statuses.data ?? []).map((s: any) => [s.alias, s.id]),
        );
        const desconhecidos = status_alias.filter((a) => !porAlias.has(a));
        if (desconhecidos.length) {
          return erro(
            `Status desconhecido(s): ${desconhecidos.join(", ")}. Válidos: ${[...porAlias.keys()].join(", ")}.`,
          );
        }
        status_id = status_alias.map((a) => porAlias.get(a)!);
      }

      const dados = await ctx.client.requisitar<any>(alias, "/orders", {
        include: ["items", "customer", "transactions", "status"],
        query: {
          limit,
          page,
          q: busca,
          status_id,
          date: criado_de ? `created_at:${criado_de}${criado_ate ? `|${criado_ate}` : ""}` : undefined,
        },
      });
      return resultado(ctx, `/${alias}/orders`, dados);
    },
  );

  server.registerTool(
    "detalhar_pedido",
    {
      title: "Detalhar pedido",
      description: "Um pedido completo, com itens, cliente, pagamentos, endereço e histórico de status.",
      inputSchema: z.object({ loja: loja, pedido_id: z.union([z.number(), z.string()]) }),
    },
    async ({ loja: l, pedido_id }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, `/orders/${pedido_id}`, {
        include: ["items", "customer", "transactions", "status", "shipping_address", "comments"],
      });
      return resultado(ctx, `/${alias}/orders`, dados);
    },
  );

  server.registerTool(
    "buscar_produtos",
    {
      title: "Buscar produtos",
      description:
        "Lista produtos do catálogo com SKUs, preços e imagens. " +
        "Limite da rota: 30 requisições por minuto — prefira filtrar a paginar.",
      inputSchema: z.object({
        loja: loja,
        busca: z.string().optional().describe("Texto no nome ou SKU."),
        ativo: z.boolean().optional(),
        ...campoPagina,
      }),
    },
    async ({ loja: l, busca, ativo, limit, page }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, "/catalog/products", {
        include: ["skus", "images", "brand"],
        // `active=0` é ignorado pela Yampi; `active[]=0` filtra. Daí o array.
        query: { limit, page, q: busca, active: ativo === undefined ? undefined : [ativo ? 1 : 0] },
      });
      return resultado(ctx, `/${alias}/catalog/products`, dados);
    },
  );

  server.registerTool(
    "detalhar_produto",
    {
      title: "Detalhar produto",
      description: "Um produto completo: SKUs, preços, estoque, variações, imagens, marca e categorias.",
      inputSchema: z.object({ loja: loja, produto_id: z.union([z.number(), z.string()]) }),
    },
    async ({ loja: l, produto_id }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, `/catalog/products/${produto_id}`, {
        include: ["skus", "skus.variations", "images", "brand", "categories"],
      });
      return resultado(ctx, `/${alias}/catalog/products`, dados);
    },
  );

  server.registerTool(
    "buscar_clientes",
    {
      title: "Buscar clientes",
      description: "Lista clientes com endereços. Limite da rota: 60 requisições por minuto.",
      inputSchema: z.object({
        loja: loja,
        busca: z.string().optional().describe("Nome, e-mail, CPF/CNPJ ou telefone."),
        ...campoPagina,
      }),
    },
    async ({ loja: l, busca, limit, page }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, "/customers", {
        include: ["addresses"],
        query: { limit, page, q: busca },
      });
      return resultado(ctx, `/${alias}/customers`, dados);
    },
  );

  server.registerTool(
    "historico_cliente",
    {
      title: "Histórico do cliente",
      description: "Um cliente e seus pedidos, em uma resposta só. Use para checar recorrência ou atender suporte.",
      inputSchema: z.object({ loja: loja, cliente_id: z.union([z.number(), z.string()]) }),
    },
    async ({ loja: l, cliente_id }) => {
      const alias = em(l);
      const [cliente, pedidos] = await Promise.all([
        ctx.client.requisitar<any>(alias, `/customers/${cliente_id}`, { include: ["addresses"] }),
        ctx.client.requisitar<any>(alias, "/orders", {
          include: ["items", "status"],
          query: { "customer_id": String(cliente_id), limit: 30 },
        }),
      ]);
      return resultado(ctx, `/${alias}/customers`, { cliente: cliente.data, pedidos: pedidos.data });
    },
  );

  server.registerTool(
    "carrinhos_abandonados",
    {
      title: "Carrinhos abandonados",
      description: "Carrinhos que não viraram pedido, com itens e cliente. Base para recuperação.",
      inputSchema: z.object({ loja: loja, ...campoPagina }),
    },
    async ({ loja: l, limit, page }) => {
      const alias = em(l);
      const dados = await ctx.client.requisitar<any>(alias, "/checkout/carts", {
        include: ["items", "customer"],
        query: { limit, page },
      });
      return resultado(ctx, `/${alias}/checkout/carts`, dados);
    },
  );
}
