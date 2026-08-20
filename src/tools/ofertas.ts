import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { campoLoja, campoPagina, erro, resolverLoja, resultado, type Contexto } from "./comum";

/**
 * As quatro ofertas vivem sob /pricing e têm campos bem diferentes entre si, mas
 * o ciclo de vida é idêntico. Uma tool com `tipo` mantém a superfície enxuta;
 * se o `corpo` por tipo virar um emaranhado ilegível, desmembre em quatro.
 */
const ROTAS = {
  cashback: "/pricing/cashbacks",
  order_bump: "/pricing/order-bumps",
  upsell: "/pricing/upsells",
  brinde: "/pricing/freebies",
} as const;

export function registrarOfertas(server: McpServer, ctx: Contexto) {
  const loja = campoLoja(ctx.lojas);

  server.registerTool(
    "gerenciar_ofertas",
    {
      title: "Gerenciar ofertas",
      description:
        "Lista, cria ou atualiza as ofertas da loja: cashback, order bump, upsell e brinde. " +
        "Comece sempre por `listar` para ver o formato dos campos antes de criar.",
      inputSchema: z.object({
        loja: loja,
        tipo: z.enum(["cashback", "order_bump", "upsell", "brinde"]),
        acao: z.enum(["listar", "criar", "atualizar"]).default("listar"),
        oferta_id: z.union([z.number(), z.string()]).optional().describe("Obrigatório ao atualizar."),
        dados: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Corpo da oferta, nos campos que a API da Yampi espera para o tipo escolhido. " +
              "Use `listar` primeiro para descobrir o formato.",
          ),
        ...campoPagina,
      }),
    },
    async ({ loja: l, tipo, acao, oferta_id, dados, limit, page }) => {
      const alias = resolverLoja(ctx.lojas, l);
      const rota = ROTAS[tipo];

      if (acao === "listar") {
        const lista = await ctx.client.requisitar<any>(alias, rota, { query: { limit, page } });
        return resultado(ctx, `/${alias}${rota}`, lista);
      }

      if (!dados || Object.keys(dados).length === 0) {
        return erro("Informe `dados` com o corpo da oferta. Rode `listar` antes para ver os campos esperados.");
      }

      if (acao === "criar") {
        const criada = await ctx.client.requisitar<any>(alias, rota, { metodo: "POST", corpo: dados });
        return resultado(ctx, `/${alias}${rota}`, criada);
      }

      if (oferta_id === undefined) return erro("Informe `oferta_id` para atualizar.");
      const atualizada = await ctx.client.requisitar<any>(alias, `${rota}/${oferta_id}`, {
        metodo: "PUT",
        corpo: dados,
      });
      return resultado(ctx, `/${alias}${rota}`, atualizada);
    },
  );
}
