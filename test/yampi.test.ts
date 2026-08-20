import { describe, expect, it } from "vitest";
import { AcaoVedadaError, LimiteExcedidoError, YampiClient } from "../src/yampi";

const credencial = { userToken: "t", secretKey: "s" };

/** fetch falso: registra as chamadas e devolve o que o teste mandar. */
function fakeFetch(
  resposta: { status?: number; corpo?: unknown; headers?: Record<string, string> } = {},
) {
  const chamadas: { url: string; metodo: string }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), metodo: init?.method ?? "GET" });
    return new Response(JSON.stringify(resposta.corpo ?? {}), {
      status: resposta.status ?? 200,
      headers: resposta.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { impl, chamadas };
}

describe("Ação Vedada na costura", () => {
  // A garantia central do projeto: cancelar, estornar e trocar gateway não têm
  // tool — e mesmo que um bug futuro tente, a costura recusa antes da rede.
  const vedadas = [
    "/orders/123/cancel",
    "/refunds",
    "/transactions/abc/refund",
    "/payments/gateways",
    "/payment-configurations/9",
  ];

  it.each(vedadas)("recusa %s em método que altera estado", async (caminho) => {
    const { impl, chamadas } = fakeFetch();
    const client = new YampiClient(credencial, impl);
    await expect(client.requisitar("loja-a", caminho, { metodo: "POST" })).rejects.toThrow(
      AcaoVedadaError,
    );
    expect(chamadas).toHaveLength(0); // nem chegou a sair da máquina
  });

  it("permite GET nas mesmas rotas: ler configuração de gateway é legítimo", async () => {
    const { impl, chamadas } = fakeFetch({ corpo: { data: [] } });
    const client = new YampiClient(credencial, impl);
    await client.requisitar("loja-a", "/payments/gateways");
    expect(chamadas).toHaveLength(1);
  });
});

describe("limite de requisições", () => {
  it("transforma 429 em erro que diz ao modelo o que fazer", async () => {
    const { impl } = fakeFetch({ status: 429, corpo: { message: "Too Many Requests" } });
    const client = new YampiClient(credencial, impl);
    const erro: any = await client.requisitar("loja-a", "/orders").catch((e) => e);
    expect(erro).toBeInstanceOf(LimiteExcedidoError);
    expect(erro.message).toMatch(/aguarde o próximo minuto|reduza o escopo/);
  });

  it("avisa quando a cota da rota está acabando", async () => {
    const { impl } = fakeFetch({
      corpo: { data: [] },
      headers: { "X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "3" },
    });
    const client = new YampiClient(credencial, impl);
    await client.requisitar("loja-a", "/catalog/products");
    expect(client.avisoDeCota("/loja-a/catalog/products")).toMatch(/restam 3 de 30/);
  });

  it("cala a boca enquanto há cota sobrando", async () => {
    const { impl } = fakeFetch({
      corpo: { data: [] },
      headers: { "X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "25" },
    });
    const client = new YampiClient(credencial, impl);
    await client.requisitar("loja-a", "/catalog/products");
    expect(client.avisoDeCota("/loja-a/catalog/products")).toBeNull();
  });

  it("compartilha a cota entre caminhos da mesma rota", async () => {
    // A Yampi limita por rota: /catalog/products e /catalog/products/1 dividem a mesma cota.
    const { impl } = fakeFetch({
      corpo: { data: {} },
      headers: { "X-RateLimit-Limit": "30", "X-RateLimit-Remaining": "1" },
    });
    const client = new YampiClient(credencial, impl);
    await client.requisitar("loja-a", "/catalog/products/1");
    expect(client.avisoDeCota("/loja-a/catalog/products")).toMatch(/restam 1 de 30/);
  });
});

describe("descoberta de lojas", () => {
  it("lê merchants.data do /auth/me", async () => {
    const { impl, chamadas } = fakeFetch({
      corpo: {
        data: {
          merchants: {
            data: [
              { id: 101, alias: "loja-a", name: "Loja A" },
              { id: 102, alias: "loja-b", name: "Loja B" },
            ],
          },
        },
      },
    });
    const client = new YampiClient(credencial, impl);
    const lojas = await client.lojas();
    expect(lojas.map((l) => l.alias)).toEqual(["loja-a", "loja-b"]);
    expect(chamadas[0].metodo).toBe("POST"); // /auth/me recusa GET com 405
  });
});

describe("montagem da URL", () => {
  it("colapsa relacionamentos com include em vez de N+1", async () => {
    const { impl, chamadas } = fakeFetch({ corpo: { data: [] } });
    const client = new YampiClient(credencial, impl);
    await client.requisitar("loja-a", "/orders", {
      include: ["items", "customer"],
      query: { limit: 5, vazio: undefined },
    });
    expect(chamadas[0].url).toContain("include=items%2Ccustomer");
    expect(chamadas[0].url).toContain("limit=5");
    expect(chamadas[0].url).not.toContain("vazio");
  });
});

describe("serialização de filtros", () => {
  // A Yampi ignora `status_id=4` em silêncio e devolve a base inteira; só
  // `status_id[]=4` filtra. Um filtro que não filtra é pior que nenhum filtro:
  // o modelo resume 55 mil pedidos achando que viu os de julho.
  it("serializa array como chave[]=v repetida", async () => {
    const { impl, chamadas } = fakeFetch({ corpo: { data: [] } });
    const client = new YampiClient(credencial, impl);
    await client.requisitar("loja-a", "/orders", { query: { status_id: [4, 10] } });
    const url = decodeURIComponent(chamadas[0].url);
    expect(url).toContain("status_id[]=4");
    expect(url).toContain("status_id[]=10");
    expect(url).not.toMatch(/status_id=4/);
  });

  it("mantém escalares sem colchetes", async () => {
    const { impl, chamadas } = fakeFetch({ corpo: { data: [] } });
    const client = new YampiClient(credencial, impl);
    await client.requisitar("loja-a", "/orders", {
      query: { date: "created_at:2026-06-01|2026-06-05" },
    });
    const url = decodeURIComponent(chamadas[0].url);
    expect(url).toContain("date=created_at:2026-06-01|2026-06-05");
  });
});

describe("cache da Yampi", () => {
  it("pula o cache em toda leitura", async () => {
    const { impl, chamadas } = fakeFetch({ corpo: { data: [] } });
    await new YampiClient(credencial, impl).requisitar("loja-a", "/orders");
    expect(chamadas[0].url).toContain("skipCache=true");
  });

  it("não polui escrita com skipCache", async () => {
    const { impl, chamadas } = fakeFetch({ corpo: { data: {} } });
    await new YampiClient(credencial, impl).requisitar("loja-a", "/catalog/products", {
      metodo: "POST",
      corpo: { name: "x" },
    });
    expect(chamadas[0].url).not.toContain("skipCache");
  });
});

describe("lojas inativas", () => {
  it("não oferece loja desativada: a Yampi devolve 403 em tudo nelas", async () => {
    const { impl } = fakeFetch({
      corpo: {
        data: {
          merchants: {
            data: [
              { id: 1, alias: "ativa", name: "Ativa", active: true },
              { id: 2, alias: "desativada", name: "Desativada", active: false },
              { id: 3, alias: "sem-campo", name: "Sem campo" },
            ],
          },
        },
      },
    });
    const lojas = await new YampiClient(credencial, impl).lojas();
    expect(lojas.map((l) => l.alias)).toEqual(["ativa", "sem-campo"]);
  });
});

describe("erro de validação", () => {
  it("repassa quais campos a Yampi recusou, não só o código", async () => {
    const { impl } = fakeFetch({
      status: 422,
      corpo: {
        message: "422 Unprocessable Entity",
        errors: { brand_id: ["Campo obrigatório."], simple: ["Campo obrigatório."] },
      },
    });
    const client = new YampiClient(credencial, impl);
    const e: any = await client
      .requisitar("loja-a", "/catalog/products", { metodo: "POST", corpo: {} })
      .catch((x) => x);
    expect(e.message).toContain("brand_id");
    expect(e.message).toContain("simple");
    expect(e.message).toContain("Campo obrigatório");
  });
});
