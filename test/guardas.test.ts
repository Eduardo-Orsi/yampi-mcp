import { describe, expect, it } from "vitest";
import { recusarSeVedado } from "../src/tools/escrita";
import { resolverLoja } from "../src/tools/comum";
import { idDaConcessao } from "../src/authorize";
import type { Loja } from "../src/yampi";

describe("Ação Vedada por status", () => {
  // Cancelar na Yampi é uma mudança de status. Sem este guard, a ausência da
  // tool de cancelamento não valeria nada: o cancelamento entraria por aqui.
  it.each(["cancelled", "refused", "CANCELLED", " refused "])("recusa %j", (alias) => {
    expect(recusarSeVedado(alias)).toMatch(/não move pedidos|irreversíveis/);
  });

  it.each(["paid", "invoiced", "delivered", "on_carriage", "ready_for_shipping"])(
    "deixa passar %j",
    (alias) => {
      expect(recusarSeVedado(alias)).toBeNull();
    },
  );
});

describe("resolução da loja", () => {
  const quatro: Loja[] = [
    { id: 1, alias: "loja-a", name: "Loja A" },
    { id: 2, alias: "loja-b", name: "Loja B" },
    { id: 3, alias: "loja-c", name: "Loja C" },
    { id: 4, alias: "loja-a", name: "Loja A" },
  ];
  const uma: Loja[] = [quatro[0]];

  it("exige escolha explícita quando há mais de uma loja", () => {
    expect(() => resolverLoja(quatro)).toThrow(/Informe em qual loja/);
  });

  it("assume a única loja quando só há uma", () => {
    expect(resolverLoja(uma)).toBe("loja-a");
  });

  it("recusa alias fora da credencial em vez de tentar mesmo assim", () => {
    expect(() => resolverLoja(quatro, "loja-de-outra-pessoa")).toThrow(/não pertence a esta credencial/);
  });

  it("aceita alias válido", () => {
    expect(resolverLoja(quatro, "loja-b")).toBe("loja-b");
  });
});

describe("id da Concessão", () => {
  // A lib recorta o código de autorização em `userId:grantId:segredo`. Um `:`
  // no userId quebra a troca de token inteira — e o erro só aparece no fim do
  // fluxo, como "Invalid authorization code format".
  it("nunca contém dois-pontos", () => {
    const id = idDaConcessao([
      { id: 100, alias: "loja-a", name: "Loja A" },
      { id: 101, alias: "loja-a", name: "Loja A" },
    ]);
    expect(id).not.toContain(":");
    expect(`${id}:grant123:segredo`.split(":")).toHaveLength(3);
  });
});
