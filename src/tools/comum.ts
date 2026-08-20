import { z } from "zod";
import type { Loja, YampiClient } from "../yampi";

export interface Contexto {
  client: YampiClient;
  lojas: Loja[];
}

/**
 * O parâmetro `loja` é obrigatório sempre que a credencial alcança mais de uma
 * loja: escrever na loja errada em silêncio é a falha que este projeto se recusa
 * a permitir. Quem tem uma loja só não paga pelo problema de quem tem quatro.
 */
export function campoLoja(lojas: Loja[]) {
  const aliases = lojas.map((l) => l.alias) as [string, ...string[]];
  const descricao = `Alias da loja. Disponíveis: ${lojas.map((l) => `${l.alias} (${l.name})`).join(", ")}`;
  const base = z.enum(aliases).describe(descricao);
  return lojas.length === 1 ? base.optional() : base;
}

export function resolverLoja(lojas: Loja[], loja?: string): string {
  const disponiveis = lojas.map((l) => l.alias).join(", ");
  if (loja) {
    if (!lojas.some((l) => l.alias === loja)) {
      throw new Error(`A loja "${loja}" não pertence a esta credencial. Disponíveis: ${disponiveis}.`);
    }
    return loja;
  }
  if (lojas.length === 1) return lojas[0].alias;
  throw new Error(`Informe em qual loja agir. Disponíveis: ${disponiveis}.`);
}

export const campoPagina = {
  limit: z.number().int().min(1).max(50).default(10).describe("Itens por página. Máximo 50."),
  page: z.number().int().min(1).default(1).describe("Página, a partir de 1."),
};

/** Resposta padrão: os dados mais o aviso de cota, quando a rota está perto do limite. */
export function resultado(ctx: Contexto, caminho: string, dados: unknown) {
  const aviso = ctx.client.avisoDeCota(caminho);
  const texto = JSON.stringify(dados, null, 1);
  return {
    content: [{ type: "text" as const, text: aviso ? `${texto}\n\n${aviso}` : texto }],
  };
}

export function erro(mensagem: string) {
  return { content: [{ type: "text" as const, text: mensagem }], isError: true };
}
