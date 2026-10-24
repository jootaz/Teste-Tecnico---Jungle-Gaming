# Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) recebidas de múltiplos provedores, com correção financeira, idempotência persistente, ledger imutável e processamento assíncrono via SQS.

> Decisões de arquitetura, trade-offs e limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Linguagem | TypeScript (strict) |
| Framework | NestJS |
| Banco | PostgreSQL 16 |
| ORM | MikroORM 6 |
| Mensageria | AWS SQS via LocalStack |
| Orquestração local | Docker Compose |

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose

## Subindo o ambiente completo

```bash
docker compose up --build
```

Isso sobe:

- `postgres` (porta 5432);
- `localstack` com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 tentativas) e `wager-events`;
- `migrations` (job que aplica as migrations e termina);
- **três instâncias da aplicação** (`app-1`, `app-2`, `app-3`) nas portas 3001, 3002 e 3003 — todas consumindo a mesma fila e publicando a mesma outbox, para demonstrar correção multi-instância.

## Rodando localmente (dev)

```bash
bun install
docker compose up -d postgres localstack
cp .env.example .env
bun run migration:up
bun run start:dev
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação |
| `bun run start:dev` | sobe com watch |
| `bun run migration:up` / `migration:down` | aplica / reverte migrations (versionadas e reversíveis) |
| `bun run test` | testes de unidade (rápidos, sem containers) |
| `bun run test:integration` | integração contra PostgreSQL e LocalStack **reais** |
| `bun run test:concurrency` | corridas com paralelismo real + 3 processos simultâneos |
| `bun run test:all` | tudo |
| `bun run lint` | typecheck estrito |

Os testes de integração e concorrência exigem `docker compose up -d postgres localstack`. Cada arquivo de teste cria **seu próprio banco** (`wagering_test_*`) e **suas próprias filas**, então podem rodar em paralelo e não poluem o ambiente de dev.

## API

Autenticação: não implementada por decisão documentada (seção 2 do desafio não pontua) — ver ponto de extensão `ProviderAuthGuard` e o desenho em [ARCHITECTURE.md](./ARCHITECTURE.md#autenticação).

### Criar wallet

```http
POST /wallets
{ "playerId": "<uuid>", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }
```

- `201` wallet criada (saldo inicial > 0 gera transação interna `OPENING` + lançamento `CREDIT` na mesma transação SQL);
- `409` já existe wallet para `(playerId, currency)`.

### Submeter transação

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "<uuid>", "walletId": "<uuid>",
  "roundId": "round-987", "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Resposta:

```json
{ "transactionId": "<uuid>", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

**Mapa de status HTTP** (consistente em todos os endpoints):

| Código | Situação | O provedor deve |
|---|---|---|
| `201` | transação aplicada (`PROCESSED`) | — |
| `200` | replay idempotente (mesma key, mesmo payload) | — |
| `202` | aceita, aguardando referência (`PENDING_REFERENCE`) | consultar depois |
| `400` | payload inválido (`VALIDATION_FAILED`) | corrigir o payload |
| `404` | wallet/transação inexistente | corrigir os ids |
| `409` | mesma `Idempotency-Key` com payload diferente, ou wallet duplicada | corrigir o payload / não reenviar |
| `422` | rejeição por regra de negócio (`REJECTED` + `failureCode`) | não reenviar |
| `503` | falha transitória de infraestrutura | **reenviar com a mesma key** |

### Consultas

```http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
```

O cursor do ledger é opaco e estável (base64url do último id — ids são UUIDv7, monotônicos).

### Reconciliação

```http
POST /wallets/:walletId/reconciliation
```

Compara o saldo materializado com o saldo reconstruído do ledger. Divergências não são corrigidas: são sinalizadas na resposta, logadas e contadas na métrica `wallet_reconciliation_divergence_total`.

### Health e métricas

```http
GET /health/live    # processo vivo
GET /health/ready   # PostgreSQL e SQS alcançáveis
GET /metrics        # Prometheus
```

## Mensageria

Mensagem esperada em `wager-transactions.fifo` (envelope `WagerTransactionRequested` — ver seção 10 do desafio). O consumidor:

- reusa o mesmo use case da entrada HTTP;
- deduplica via inbox persistente `(consumerName, messageId)`;
- faz ack **somente após o commit**;
- rejeições de negócio são terminais (ack); falhas transitórias voltam com backoff de visibilidade e vão à DLQ após 5 tentativas (redrive); payloads impossíveis vão direto à DLQ;
- em `SIGTERM`, conclui as mensagens em andamento antes de encerrar.

Eventos de integração (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) saem pela **outbox transacional** e são publicados em `wager-events` com entrega at-least-once (consumidores deduplicam por `eventId`).

## Códigos de falha

| `failureCode` | Significado |
|---|---|
| `INSUFFICIENT_FUNDS` | aposta sem saldo |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria o saldo negativo (distinto do anterior) |
| `REFERENCE_NOT_FOUND` | referência não apareceu dentro do limite de tentativas |
| `REFERENCE_KIND_MISMATCH` | p.ex. `REFUND` de um `WIN` |
| `REFERENCE_CONTEXT_MISMATCH` | referência de outro player/wallet/rodada/moeda |
| `REFERENCE_NOT_PROCESSED` | referência terminou `REJECTED`/`FAILED` |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida (uma reversão por referência) |
| `REFERENCE_AMOUNT_MISMATCH` | valor difere da referência (reversão parcial fora de escopo) |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet |
| `WALLET_NOT_FOUND` | wallet inexistente |
| `PLAYER_WALLET_MISMATCH` | wallet não pertence ao player |
| `VALIDATION_FAILED` | payload inválido |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | mesma key, payload diferente |

## Estrutura

```
src/
  domain/           # entidades, VOs, eventos — zero dependência de ORM/Nest
  application/      # use cases + portas (repositórios, UoW, publisher)
  infrastructure/
    persistence/    # MikroORM, repositórios, migrations, UoW
    messaging/      # consumer SQS, outbox publisher, worker de referências
    observability/  # logger estruturado, métricas Prometheus
  api/              # controllers, DTOs, filtro de exceções, guard no-op
test/
  unit/             # regras de negócio com fakes in-memory
  integration/      # PostgreSQL + LocalStack reais
  concurrency/      # corridas reais, incl. 3 processos simultâneos
```
