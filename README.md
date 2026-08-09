# Pipeline de Análise de Influenciadores

MVP interno: automatiza scrape (Apify) → transcrição (AssemblyAI) →
histórico de métricas. Tudo rodando em Supabase (Postgres + Edge Functions +
Cron), sem servidor próprio. A categorização por editoria (campo `editoria`
em `conteudo`) é feita manualmente por enquanto — ver seção "Categorização
manual" abaixo.

## Arquitetura

```
Cron diário
  └─> scrape-trigger (Edge Function)
        -> Apify: busca posts dos últimos 60 dias de cada influenciador ativo
        -> grava/atualiza `conteudo`
        -> insere um `metrica_snapshot` (histórico, nunca sobrescreve)

Cron diário (logo depois)
  └─> process-content (Edge Function)
        -> para conteúdo de vídeo sem transcrição: busca o vídeo (em
           memória, nada em disco) e envia pra AssemblyAI — o CDN do
           Instagram bloqueia a AssemblyAI baixando direto da URL, então a
           função faz essa ponte. Posts de imagem não passam por aqui.
```

## Categorização manual (por enquanto)

Testamos categorização automática via Gemini, mas a conta ficou com cota
gratuita zerada (bloqueio da própria Google, não resolvido). Pra não travar
o MVP nisso, a categorização virou um passo manual, em 3 partes:

1. **Exportar** — acesse (com o `TRIGGER_SECRET`):
   ```
   https://<PROJECT_ID>.supabase.co/functions/v1/export-conteudo?secret=<TRIGGER_SECRET>
   ```
   Baixa um CSV com `conteudo_id, handle, url, tipo, data_publicacao, legenda,
   transcricao, likes, comentarios, views, editoria` de tudo que ainda não
   tem editoria. Use `&todos=1` para exportar tudo, incluindo já categorizado.
2. **Categorizar** — preencha a coluna `editoria` no CSV do seu jeito (usando
   sua conta da Anthropic, por exemplo).
3. **Aplicar** — devolva o arquivo preenchido; eu transformo em uma migration
   com `UPDATE conteudo SET editoria = ... WHERE id = ...` por linha, e a
   correção entra pelo pipeline normal (commit → deploy automático).

Automatizar essa etapa de novo (com Claude ou outro provedor) fica pra depois.

## Configuração necessária

### 1. Secrets do GitHub Actions (para o deploy automático)
Em `Settings > Secrets and variables > Actions` no repositório:
- `SUPABASE_ACCESS_TOKEN` — gerado em supabase.com/dashboard/account/tokens
- `SUPABASE_PROJECT_ID` — o "Project ref" do seu projeto Supabase
- `SUPABASE_DB_PASSWORD` — senha do banco definida na criação do projeto

### 2. Secrets das Edge Functions (para as chamadas de API)
No painel do Supabase: `Edge Functions > Manage secrets`, ou via CLI:
```
supabase secrets set APIFY_TOKEN=... APIFY_ACTOR_ID=... ASSEMBLYAI_API_KEY=... GEMINI_API_KEY=... TRIGGER_SECRET=...
```
(`APIFY_ACTOR_ID` default é `apify~instagram-scraper`; `GEMINI_MODEL` é opcional,
default `gemini-2.0-flash` — só precisa cadastrar se quiser trocar o modelo.
`TRIGGER_SECRET` é uma senha qualquer que você escolhe — usada pra chamar as
funções manualmente ou via cron, ver seção abaixo.)
(`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já ficam disponíveis automaticamente
dentro das Edge Functions.)

### 3. Cadastro de influenciadores
Feito via migration (`supabase/migrations/0002_seed_influenciadores.sql`) —
para adicionar mais, criar uma nova migration com `insert into influenciador (...)`.
A conexão self-service pelo próprio influenciador fica para a V2.

### 4. Chamando as funções manualmente (ex: backfill inicial)
As duas funções não exigem o JWT padrão do Supabase — em vez disso, verificam
um `TRIGGER_SECRET` próprio, passado por header ou query string. Isso permite
chamar direto do navegador. Formato da URL:
```
https://<PROJECT_ID>.supabase.co/functions/v1/scrape-trigger?secret=<TRIGGER_SECRET>&dias=120&limite=200
```
- `dias`: tamanho da janela de busca (padrão 60, sem precisar informar)
- `limite`: quantidade máxima de posts por influenciador (padrão 60)

Pra um backfill de 4 meses: `?secret=...&dias=120&limite=200`. Depois disso,
o cron recorrente continua usando os valores padrão (60/60).

O `process-content` aceita só `?secret=...&limite=N` (processa N conteúdos
pendentes por chamada, padrão 1 — mantém baixo de propósito pra nunca passar
do tempo máximo de execução da função, já que cada transcrição pode levar
até ~1 minuto). Pra esvaziar uma fila maior, chame várias vezes ou configure
o cron pra rodar com frequência (ex: a cada 2 minutos) até não sobrar pendente.

### 5. Agendamento (cron)
Configurar em `Database > Cron Jobs` no Supabase (usa `pg_cron` +
`pg_net` para chamar as Edge Functions via HTTP no horário definido, passando
o header `x-trigger-secret` com o mesmo valor do `TRIGGER_SECRET`).

## Pendências conhecidas
- `mapItem` em `scrape-trigger` está ajustado para o ator `apify/instagram-scraper`
  (posts com imagem não têm `media_url`, então não passam por transcrição —
  só entram no CSV de categorização com a legenda, sem transcrição).
- Sem tratamento ainda para re-scrape com frequência diferenciada (diário para
  posts recentes, semanal para mais antigos) — todo o conteúdo em janela é
  reprocessado igualmente por enquanto.
- Categorização automática (via LLM) fica pausada até decidirmos um provedor
  que não trave em cota — ver seção "Categorização manual" acima.
