/**
 * Teste de integração contra a API real da Yampi.
 *
 * Os outros testes usam um `fetch` falso e provam a lógica do servidor. Este aqui
 * prova a outra metade: que os endpoints, os nomes de campo e a sintaxe de filtro
 * ainda são os que este código assume. A API da Yampi muda sem avisar, e uma
 * suíte que só testa mocks não percebe.
 *
 * É pulado por padrão. Para rodar contra a sua loja:
 *
 *   cp .env.example .env    # preencha alias, token e secret
 *   npm run test:integracao
 *
 * Só faz leitura. Nada é criado, alterado ou apagado.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { YampiClient } from "../src/yampi";

const alias = process.env.YAMPI_ALIAS;
const userToken = process.env.YAMPI_USER_TOKEN;
const secretKey = process.env.YAMPI_USER_SECRET_KEY;
const configurado = Boolean(alias && userToken && secretKey);

describe.skipIf(!configurado)("API da Yampi (rede real, somente leitura)", () => {
  let client: YampiClient;
  beforeAll(() => {
    client = new YampiClient({ userToken: userToken!, secretKey: secretKey! });
  });

  it("descobre as lojas da credencial e inclui a informada", async () => {
    const lojas = await client.lojas();
    expect(lojas.length).toBeGreaterThan(0);
    expect(lojas.map((l) => l.alias)).toContain(alias);
  });

  it("lista status de pedido com alias utilizável", async () => {
    const r = await client.requisitar<any>(alias!, "/checkout/statuses", { query: { limit: 50 } });
    const aliases = (r.data ?? []).map((s: any) => s.alias);
    expect(aliases).toContain("paid");
    expect(aliases).toContain("cancelled"); // existe na API, mas é Ação Vedada aqui
  });

  it("filtra pedidos por status de verdade", async () => {
    // O ponto do teste: `status_id=4` é ignorado em silêncio pela Yampi e devolve
    // a base inteira. Só `status_id[]=4` filtra. Se a API voltar a aceitar a forma
    // escalar, ou parar de aceitar o array, é aqui que se descobre.
    const statuses = await client.requisitar<any>(alias!, "/checkout/statuses", { query: { limit: 50 } });
    const pago = (statuses.data ?? []).find((s: any) => s.alias === "paid");
    const r = await client.requisitar<any>(alias!, "/orders", {
      include: ["status"],
      query: { limit: 5, status_id: [pago.id] },
    });
    const encontrados = (r.data ?? []).map((o: any) => o.status?.data?.alias);
    for (const s of encontrados) expect(s).toBe("paid");
  });

  it("aceita o formato de data que a Yampi exige", async () => {
    const r = await client.requisitar<any>(alias!, "/orders", {
      query: { limit: 1, date: "created_at:2020-01-01|2020-01-02" },
    });
    expect(Array.isArray(r.data)).toBe(true); // formato errado devolveria 400/500
  });

  it("expande relacionamentos de produto via include", async () => {
    const r = await client.requisitar<any>(alias!, "/catalog/products", {
      include: ["skus", "images"],
      query: { limit: 1 },
    });
    if ((r.data ?? []).length > 0) expect(r.data[0]).toHaveProperty("skus");
  });

  it("expõe a cota da rota nos headers", async () => {
    await client.requisitar(alias!, "/catalog/brands", { query: { limit: 1 } });
    // Sem o header o aviso de cota nunca dispara e o modelo só descobre o limite no 429.
    expect(client.avisoDeCota(`/${alias}/catalog/brands`)).not.toBeUndefined();
  });
});

describe.skipIf(configurado)("integração", () => {
  it("pulada: defina YAMPI_ALIAS, YAMPI_USER_TOKEN e YAMPI_USER_SECRET_KEY para rodar", () => {
    expect(configurado).toBe(false);
  });
});
