# Cancelar, estornar e trocar gateway não existem no código

Este servidor não expõe tool para cancelar pedido, estornar compra ou trocar gateway de
pagamento — e não como funcionalidade desligada por flag, e sim como código que nunca foi
escrito. São as três operações irreversíveis da API da Yampi, e a única defesa que não
depende de configuração correta nem de atenção humana é a ausência.

## Considered Options

- **Atrás de `YAMPI_ALLOW_DESTRUCTIVE=true`.** Mais flexível, e alguém liga "só pra testar"
  numa loja de produção. Pesou contra um fato apurado durante o desenho: o Claude Desktop e o
  claude.ai **não suportam `elicitation`**, então o servidor não tem como pedir confirmação.
  O único obstáculo seria o diálogo de aprovar tool do cliente, que o usuário clica no
  automático depois da terceira vez.

## Consequences

Cancelar um pedido na Yampi é uma mudança de status, então a ausência da tool não bastaria:
o cancelamento entraria pela porta dos fundos de `avancar_status_pedido`. Por isso a decisão
é aplicada em dois pontos, ambos cobertos por teste:

1. `recusarSeVedado()` em `tools/escrita.ts`, por alias (`cancelled`, `refused`) e nunca por
   ID — IDs de status são dados da loja, não constantes universais.
2. `ROTAS_VEDADAS` em `yampi.ts`, na costura por onde toda requisição passa, para que um erro
   futuro não alcance essas rotas por outro caminho. Vale só para métodos que alteram estado:
   ler a configuração de gateway é legítimo, trocá-la não.

Quem discordar tem um fork a um comando de distância. Uma garantia que se desliga por variável
de ambiente não é garantia.
