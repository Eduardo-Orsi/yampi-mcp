/**
 * Client da API Yampi. Costura única do servidor: nenhuma tool fala HTTP
 * diretamente, tudo passa por aqui. É o que torna a Ação Vedada auditável —
 * a superfície inteira que este servidor consegue tocar cabe neste arquivo.
 */

const BASE = "https://api.dooki.com.br/v2";

/**
 * Ação Vedada, aplicada na costura. As tools correspondentes não existem, mas
 * um erro futuro não deve conseguir alcançar estas rotas por outro caminho.
 * Só vale para métodos que alteram estado: ler a configuração de gateway é
 * legítimo, trocá-la não.
 */
const ROTAS_VEDADAS: RegExp[] = [
  /\/orders\/[^/]+\/cancel/i,
  /\/refunds?\b/i,
  /\/transactions\/[^/]+\/(refund|estorno)/i,
  /\/payments?\/gateways/i,
  /\/payment[-_]?configurations/i,
];

export class YampiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "YampiError";
  }
}

export class LimiteExcedidoError extends YampiError {
  constructor(readonly rota: string) {
    super(
      `A Yampi recusou por excesso de requisições em ${rota}. O limite é por rota e por minuto; ` +
        `aguarde o próximo minuto ou reduza o escopo da consulta (menos itens por página, filtro mais estreito).`,
      429,
    );
  }
}

export class AcaoVedadaError extends YampiError {
  constructor(rota: string) {
    super(
      `Rota vedada por design: ${rota}. Este servidor não cancela pedidos, não estorna compras ` +
        `e não troca gateway de pagamento. Use o painel da Yampi.`,
      403,
    );
  }
}

export interface Loja {
  id: number;
  alias: string;
  name: string;
}

export interface Credencial {
  userToken: string;
  secretKey: string;
}

export interface OpcoesRequisicao {
  metodo?: "GET" | "POST" | "PUT" | "DELETE";
  /** Relacionamentos a expandir. Colapsa N+1 numa chamada só. */
  include?: string[];
  /**
   * Parâmetros de query. Arrays viram `chave[]=a&chave[]=b` — sem os colchetes a
   * Yampi ignora o filtro em silêncio e devolve a base inteira.
   */
  query?: Record<string, string | number | boolean | undefined | Array<string | number>>;
  corpo?: unknown;
}

/** Sobra de cota vista na última resposta de cada rota. Best-effort: o isolate morre e o Map vai junto. */
type Cota = { restante: number; limite: number };

export class YampiClient {
  #cotas = new Map<string, Cota>();

  constructor(
    private readonly credencial: Credencial,
    // bind explícito: `fetch` nativo perde o `this` ao virar campo de classe.
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  /**
   * Lojas que esta credencial alcança. Uma credencial Yampi é do usuário, não da
   * loja.
   *
   * Lojas inativas ficam de fora: a Yampi responde 403 em toda rota delas,
   * leitura inclusive. Oferecê-las ao modelo seria oferecer uma opção que só
   * sabe falhar, e o 403 não diz que a causa é a loja estar desativada.
   */
  async lojas(): Promise<Loja[]> {
    const dados = await this.#bruto("/auth/me", { metodo: "POST" });
    const merchants = (dados as any)?.data?.merchants ?? (dados as any)?.merchants;
    const itens = merchants?.data ?? merchants ?? [];
    return itens
      .filter((m: any) => m.active !== false)
      .map((m: any) => ({ id: m.id, alias: m.alias, name: m.name }));
  }

  async requisitar<T = unknown>(
    alias: string,
    caminho: string,
    opcoes: OpcoesRequisicao = {},
  ): Promise<T> {
    return this.#bruto(`/${alias}${caminho}`, opcoes) as Promise<T>;
  }

  /**
   * Aviso de cota para anexar à resposta da tool. Sem isto o modelo só descobre
   * o limite quando toma 429, e aí já travou a rota pelo minuto inteiro.
   */
  avisoDeCota(caminho: string): string | null {
    const cota = this.#cotas.get(this.#chaveDeRota(caminho));
    if (!cota || cota.restante > 5) return null;
    return `Atenção: restam ${cota.restante} de ${cota.limite} requisições nesta rota neste minuto.`;
  }

  async #bruto(caminho: string, opcoes: OpcoesRequisicao): Promise<unknown> {
    const metodo = opcoes.metodo ?? "GET";

    if (metodo !== "GET" && ROTAS_VEDADAS.some((r) => r.test(caminho))) {
      throw new AcaoVedadaError(caminho);
    }

    const url = new URL(BASE + caminho);

    // A Yampi cacheia GET por 30 minutos. Num contexto de agente isso mente:
    // criar um produto e relê-lo devolveria o estado anterior. Sempre pular.
    if (metodo === "GET") url.searchParams.set("skipCache", "true");

    if (opcoes.include?.length) url.searchParams.set("include", opcoes.include.join(","));
    for (const [chave, valor] of Object.entries(opcoes.query ?? {})) {
      if (valor === undefined || valor === "") continue;
      if (Array.isArray(valor)) {
        for (const item of valor) url.searchParams.append(`${chave}[]`, String(item));
      } else {
        url.searchParams.set(chave, String(valor));
      }
    }

    const resposta = await this.fetchImpl(url.toString(), {
      method: metodo,
      // A API da Yampi fica atrás da Cloudflare e cacheia GET por 30 minutos. Uma
      // subrequest de Worker pode ser servida do cache de borda, cuja chave é a
      // URL — sem os headers de autenticação. Resultado: resposta de outra
      // credencial. Nunca cachear chamada autenticada.
      cache: "no-store",
      headers: {
        "User-Token": this.credencial.userToken,
        "User-Secret-Key": this.credencial.secretKey,
        "Content-Type": "application/json",
      },
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
    });

    this.#registrarCota(caminho, resposta.headers);

    if (resposta.status === 429) throw new LimiteExcedidoError(caminho);

    const texto = await resposta.text();
    let corpo: unknown = null;
    try {
      corpo = texto ? JSON.parse(texto) : null;
    } catch {
      throw new YampiError(
        `Resposta ilegível da Yampi em ${caminho}: ${texto.slice(0, 200)}`,
        resposta.status,
      );
    }

    if (!resposta.ok) {
      const msg = (corpo as any)?.message ?? resposta.statusText;
      // Em 422 a Yampi diz exatamente qual campo falhou, dentro de `errors`.
      // Descartar isso deixa o modelo tentando de novo às cegas; repassar deixa
      // ele se corrigir sozinho na chamada seguinte.
      const erros = (corpo as any)?.errors;
      const detalhe =
        erros && typeof erros === "object"
          ? " Campos: " +
            Object.entries(erros)
              .map(([campo, msgs]) => `${campo} (${[msgs].flat().join("; ")})`)
              .join(", ")
          : "";
      throw new YampiError(
        `Yampi respondeu ${resposta.status} em ${caminho}: ${msg}.${detalhe}`,
        resposta.status,
      );
    }
    return corpo;
  }

  #registrarCota(caminho: string, headers: Headers) {
    const restante = Number(headers.get("X-RateLimit-Remaining"));
    const limite = Number(headers.get("X-RateLimit-Limit"));
    if (Number.isFinite(restante) && Number.isFinite(limite) && limite > 0) {
      this.#cotas.set(this.#chaveDeRota(caminho), { restante, limite });
    }
  }

  /** O limite da Yampi é por rota, não por caminho exato: /orders/123 e /orders dividem a mesma cota. */
  #chaveDeRota(caminho: string): string {
    return caminho.split("/").filter(Boolean).slice(1, 3).join("/");
  }
}
