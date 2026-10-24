# Arquitetura e decisões técnicas

Este documento registra as decisões, trade-offs e limitações da solução. O README traz setup, comandos e contrato da API.

## 1. Visão geral

Arquitetura hexagonal em três camadas:

- **`domain/`** — entidades e value objects puros (zero dependência de ORM, NestJS ou AWS). Construtores privados + factories estáticas (`create`/`from`/`rehydrate`); `rehydrate` reconstrói estado persistido sem revalidar transições.
- **`application/`** — use cases orquestrando o domínio através de **portas** (`WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `InboxRepository`, `OutboxRepository`, `UnitOfWork`, `EventPublisher`, `MetricsPort`).
- **`infrastructure/` + `api/`** — adaptadores: MikroORM/PostgreSQL, SQS/LocalStack, NestJS, pino, prom-client.

O ponto central é o `SubmitWagerTransactionUseCase`: **o mesmo use case atende HTTP, SQS e o worker de referências pendentes**. A única diferença entre os canais é o contexto de execução (o canal SQS injeta o registro de inbox na mesma transação SQL).

## 2. ORM: por que MikroORM

Escolhi **MikroORM** (preferência do desafio) pelos recursos que o problema pede explicitamente:

- `EntityManager.transactional()` dá a fronteira transacional do Unit of Work com fork explícito de contexto (`allowGlobalContext: false` — cada request/worker opera num EM isolado);
- `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`) e `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) cobrem o lock por wallet e a disputa de filas internas (outbox, referências pendentes) sem SQL manual para locking.

**Mapeamento consciente**: as entidades de domínio não são as entidades do ORM. Há *records* de persistência (`EntitySchema`) e mapeadores explícitos — o domínio nunca vê decorators nem tipos do ORM, e o `Money` é reidratado a partir de `numeric(18,2)` + `char(3)` (colunas separadas, representação exata).

Para escritas usei `em.insert`/`em.nativeUpdate` (SQL imediato e explícito) em vez do flush implícito do Unit of Work do ORM: num fluxo financeiro prefiro que cada escrita aconteça onde o código diz que acontece. O caso especial é o inbox: `INSERT ... ON CONFLICT DO NOTHING` cru, porque um INSERT que falha abortaria a transação PostgreSQL inteira.

## 3. Money

- `Decimal` (decimal.js) por trás de um VO imutável; **nunca** `number` para dinheiro.
- Contratos recebem e devolvem **string decimal com escala fixa 2**; entradas inválidas (`NaN`, `Infinity`, notação científica, >2 casas, negativos, vazio) são rejeitadas na factory `from`.
- Valores negativos só existem como resultado interno de aritmética (`subtract`/`negate`) — úteis para comparações e para a reconciliação — jamais vindos de fora.
- Persistência em `numeric(18,2)`; o driver devolve string e o mapper normaliza a escala.
- Todo o sistema assume `BRL` por padrão, mas o modelo é multi-moeda e conflitos de moeda são testados (regra do desafio).

## 4. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por linha** (`SELECT ... FOR UPDATE` na wallet) dentro da transação do use case.

Por quê pessimista e não otimista com retry?

- A disputa é por *hot wallet* (muitas operações no mesmo agregado em janelas curtas). Lock otimista degeneraria em tempestade de retries exatamente no pior momento; o lock de linha serializa barato e de forma justa (fila no Postgres), e wallets diferentes seguem 100% paralelas.
- Funciona idêntico com N instâncias — o lock vive no banco, não no processo. Não há lock global: cada wallet é serializada individualmente.
- `version` continua existindo e incrementa a cada mudança de saldo — serve de carimbo para eventos (`walletVersion` em `WalletBalanceChanged`) e permitiria migrar para optimistic locking sem mudança de schema.

**Backstops no schema** (a aplicação pode ter bugs; o banco não deixa passar):

- `CHECK (balance_amount >= 0)` — saldo jamais negativo, mesmo sob race;
- `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` — débito/crédito duplicado é impossível;
- `UNIQUE (transaction_id)` no ledger — no máximo um lançamento por transação;
- `CHECK` da aritmética do lançamento (`balance_after = balance_before ± amount`);
- índice único parcial `wager_tx_single_reversal` — uma única reversão `PROCESSED` por referência;
- trigger `BEFORE UPDATE OR DELETE` no ledger — imutabilidade estrutural (append-only) garantida pelo banco, não por convenção.

Erros transitórios de concorrência (40001/40P01) têm retry limitado (3 tentativas) — com lock pessimista e ordem de aquisição constante são raros.

**Corrida de inserção idempotente**: duas requisições com a mesma key podem passar juntas pela checagem de replay; a segunda viola a unique e a execução inteira é refeita uma vez, caindo no caminho de replay. O resultado é o original, sem efeito duplicado.

## 5. Idempotência

- O header `Idempotency-Key` é obrigatório e é a fonte da verdade; escopo **por provedor** (`UNIQUE (provider_id, idempotency_key)`) para que provedores distintos não colidam.
- `payloadHash` = SHA-256 do **JSON canônico** (chaves ordenadas recursivamente, campos `undefined` omitidos) do subconjunto de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`. Header e metadados de transporte ficam fora do hash.
- Requisição idêntica → resposta original com `idempotentReplay: true`, **incluindo o saldo observado no momento do processamento** (persistido em `observed_balance` na transação — regra 7). Replays nunca releem o saldo atual.
- Mesma key com payload diferente → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`, nunca replay.
- No canal SQS há uma segunda camada: inbox persistente por `(consumer_name, message_id)` — dedup de **entrega** — além da dedup de **negócio** pela key. Cache em memória não participa de nenhuma garantia.

## 6. Fluxo da transação (HTTP e SQS)

Tudo abaixo ocorre em **uma** transação SQL (`UnitOfWork.run`):

1. (SQS) insere inbox com `ON CONFLICT DO NOTHING`; se já existia, a mensagem é duplicata entregue de novo → responde com o resultado original e o consumer faz ack.
2. Checagem de replay por `(providerId, idempotencyKey)` (+ comparação do `payloadHash`).
3. Validação de existência da wallet (contrato) e criação da `WagerTransaction` em `PENDING`.
4. `SELECT ... FOR UPDATE` na wallet → daqui em diante a wallet está serializada.
5. Resolução/validação da referência (REFUND/ROLLBACK): mesmo provider, player, wallet, moeda e rodada; kinds compatíveis; valor idêntico; referência `PROCESSED`; nenhuma reversão anterior.
6. Aplicação do efeito: débito/crédito no agregado (`Wallet.debit/credit` devolve `balanceBefore/After`), lançamento no ledger criado pela factory que valida a aritmética.
7. Transição da transação (`PROCESSED`/`REJECTED` com `failureCode` + saldo observado).
8. Eventos de integração gravados na **outbox** (mesma transação).
9. Commit. Só então o consumer SQS faz ack; só então o publisher pode enxergar a outbox.

Violações de regra de negócio (`BusinessRuleViolationError`) não abortam a transação SQL: são convertidas em `REJECTED` auditável com `failureCode`, commit normal e evento `WagerTransactionRejected`.

## 7. Referências fora de ordem

- `REFUND`/`ROLLBACK` cuja referência ainda não existe (ou ainda não é terminal) ficam `PENDING_REFERENCE`, com `next_reference_retry_at` calculado por **backoff exponencial** (1s → 2s → 4s ... teto 60s).
- Um worker em cada instância reivindica vencidas com `FOR UPDATE SKIP LOCKED` (instâncias nunca pegam a mesma linha) e re-executa o mesmo caminho `applyToWallet` do use case.
- Limite: **10 tentativas** (~8,5 min acumulados) — justificativa: rodadas de jogo são curtas; uma referência que não apareceu nessa janela indica perda definitiva ou erro do provedor, e segurar crédito/débito indefinidamente é pior que rejeitar com código claro. Esgotado o limite → `REJECTED` com `REFERENCE_NOT_FOUND` + evento publicado; o provedor pode reenviar depois que a referência existir (nova key).
- `WIN` *pode* referenciar a `BET` da rodada (interpretação documentada): o vínculo é informativo; `WIN` sem referência resolvível é processado normalmente — bloquear premiações por ordenação seria pior para o jogador e não há exigência de reversão envolvida.

## 8. Interpretações adicionais documentadas

1. **Uma reversão por referência, de qualquer tipo.** A regra 4 fala em "mesmo tipo de operação", mas permitir `REFUND` e `ROLLBACK` da mesma `BET` duplicaria o crédito — violação da invariante global. Adotei a leitura mais estrita (única reversão `PROCESSED` por referência), garantida por índice único parcial e testada sob corrida.
2. **Wallet inexistente** → `404` (HTTP) / DLQ (SQS), sem persistir a transação: não há como auditar transação de wallet que não existe (FK), e aceitar violaria o contrato.
3. **Replay de `REJECTED`** devolve `422` com o mesmo corpo (mesma resposta, status HTTP incluído); replay de `PROCESSED` devolve `200` (o `201` fica para o primeiro processamento).
4. **`OPENING`**: kind interno, bloqueado na API (enum do DTO), na fila (consumer) e no domínio (`create` lança; só `createOpening` o produz, usado pelo `CreateWalletUseCase`). `version` da wallet termina em 1 após abertura com saldo (abre em 0 e o crédito de abertura incrementa), como no exemplo do desafio.
5. **`markProcessed` recebe também o saldo observado** — adaptação de assinatura permitida, necessária para a regra 7 (replay devolve o saldo da época).

## 9. Outbox transacional

- Eventos só existem porque o commit aconteceu (gravados na mesma transação) — **impossível publicar antes do commit**.
- O publisher roda em todas as instâncias: cada tick abre transação, reivindica vencidos com `FOR UPDATE SKIP LOCKED`, publica no SQS, marca `published_at` e commita. Dois publishers jamais pegam a mesma linha ao mesmo tempo.
- Cenário exigido: commit → processo morre antes de publicar → a linha continua `published_at IS NULL` → outra instância a reivindica e publica. Testado.
- Se o processo morre **entre o publish e o commit do tick**, o evento é republicado → entrega **at-least-once**; consumidores deduplicam pelo `eventId` do envelope.
- Falha de publicação → `attempts + 1` e `next_attempt_at` com backoff exponencial (1s, teto 60s); nada é perdido nem re-tentado em loop quente.
- Envelope: classe abstrata `IntegrationEvent<T>` com `eventType` e `version` **no tipo** (uma subclasse concreta por evento); `data` carrega `MoneyProps` (string), nunca instância de `Money`.
- A fila de eventos (`wager-events`) é standard, não FIFO: a ordem é reconstituível pelo consumidor via `walletVersion`/`occurredAt`, e FIFO não acrescentaria garantia (o banco é a fonte da ordem).

## 10. Consumer SQS

Taxonomia de erro (exigência da seção 10):

| Classe | Exemplos | Ação |
|---|---|---|
| Negócio (terminal) | saldo insuficiente, referência inválida | transação `REJECTED` commitada + **ack** |
| Transitório | Postgres/SQS fora, timeout | **sem ack**; `ChangeMessageVisibility` com backoff exponencial (2^n s, teto 300s); após 5 recebimentos o redrive manda à DLQ |
| Permanente | JSON malformado, kind desconhecido/`OPENING`, money inválido, wallet inexistente, conflito de idempotência | forward explícito à DLQ (com motivo) + ack |

- Ack (`DeleteMessage`) **somente após o commit** — um crash pós-commit/pré-ack causa redelivery, que o inbox absorve sem duplicar efeito (testado).
- FIFO + `MessageGroupId` são tratados como **otimização** de ordenação; as invariantes vêm do banco (lock + constraints + inbox). A dedup FIFO de 5 minutos não substitui o inbox persistente.
- `SIGTERM`: para de receber, conclui as mensagens em voo, então encerra (o `main.ts` drena consumer → workers → HTTP → ORM nessa ordem).

## 11. Autenticação

**Não implementada** — decisão deliberada de timebox (seção 2 do desafio: não pontua e não deve competir com correção financeira).

Desenho que eu adotaria: **Keycloak** em container, OAuth2 **client-credentials** por provedor (cada provedor = um client confidencial). O `ProviderAuthGuard` (hoje no-op, aplicado globalmente — o ponto de extensão exigido) validaria o Bearer JWT via JWKS (issuer, audience, assinatura, expiração) e extrairia o `providerId` de um claim, cruzando-o com o `providerId` do payload — um token do provedor A não pode submeter transações como provedor B. Health endpoints ficam fora do guard; mensagens da fila são canal interno confiável, mas a identidade do provedor contida na mensagem continua sujeita às mesmas validações de domínio (como já é hoje).

## 12. Observabilidade

- **Logs**: pino, JSON estruturado, com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` como campos ligados; nunca payloads financeiros completos nem dados sensíveis.
- **Métricas** (Prometheus em `/metrics`): transações por status/kind, duplicatas por origem (idempotência/inbox), referências pendentes, conflitos de lock, mensagens SQS por resultado (processed/duplicate/retried/dlq), outbox publicadas/falhas/**lag** (histograma), latência de processamento por canal, divergências de reconciliação.
- **Health**: `/health/live` (processo) e `/health/ready` (Postgres `SELECT 1` + SQS `GetQueueUrl`), sem autenticação.

## 13. Testes

- **Unidade** (`bun run test`): domínio e regras de negócio com fakes in-memory das portas — Money (escala, entradas inválidas, aritmética exata), invariantes da Wallet, máquina de estados, BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, key com payload divergente, replay com saldo da época.
- **Integração** (`bun run test:integration`): PostgreSQL e LocalStack **reais**. Migrations e constraints (incluindo trigger append-only e índice de reversão única), atomicidade total do UoW (crash antes do commit desfaz inbox + transação + saldo + ledger + outbox), consumer (inbox/redelivery, crash pós-commit/pré-ack, DLQ), outbox (recuperação pós-crash, dois publishers concorrentes, retry com backoff), reinício do serviço com reconciliação.
- **Concorrência** (`bun run test:concurrency`): paralelismo real — 50 submissões idênticas em paralelo → 1 débito; cenário obrigatório 100/80/80; hot wallet (30×10 contra 100 → exatamente 10 processadas, saldo 0); wallets distintas em paralelo; REFUND × ROLLBACK da mesma BET em corrida; e a suíte **multi-instância com 3 processos reais do SO**, cada um com seu pool de conexões.
- **Invariante final de todos os testes**: `wallet.balance == saldo reconstruído pelo ledger` (helper `expectWalletConsistent`, que usa o próprio use case de reconciliação).

Mocks não substituem Postgres/SQS em nenhum teste de integração/concorrência; os fakes in-memory existem só na suíte de unidade.

## 14. Limitações conhecidas

- **Ordenação de eventos**: consumidores de `wager-events` precisam tolerar reordenação (usar `walletVersion`); se ordenação estrita por wallet for requisito, trocar por fila FIFO com `MessageGroupId = walletId`.
- **Retenção do inbox**: a tabela cresce indefinidamente; em produção haveria expurgo por idade (p.ex. > 14 dias) — seguro porque a dedup FIFO + idempotency key cobrem janelas curtas e longas respectivamente.
- **Ledger de partidas dobradas** (double-entry) ficou fora (diferencial opcional): o ledger atual é single-entry com saldo before/after verificado por CHECK.
- **Cursor do ledger** assume UUIDv7 monotônico por gerador; entre instâncias a ordem é aproximadamente temporal (suficiente para paginação estável; não é ordem total de eventos).
- **Teste de carga** (`test:load`) não incluído nesta entrega.
