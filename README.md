# Pipeline de Análise de Influenciadores

MVP interno: automatiza scrape (Apify) → transcrição (AssemblyAI) → categorização
por editoria (Claude) → histórico de métricas. Tudo rodando em Supabase
(Postgres + Edge Functions + Cron), sem servidor próprio.

## Arquitetura

```
Cron diário
  └─> scrape-trigger (Edge Function)
        -> Apify: busca posts dos últimos 60 dias de cada influenciador ativo
        -> grava/atualiza `conteudo`
        -> insere um `metrica_snapshot` (histórico, nunca sobrescreve)

Cron diário (logo depois)
  └─> process-content (Edge Function)
        -> para conteúdo sem transcrição: chama AssemblyAI com a media_url direta
        -> categoriza a editoria via Claude (Haiku)
```

## Configuração necessária

### 1. Secrets do GitHub Actions (para o deploy automático)
Em `Settings > Secrets and variables > Actions` no repositório:
- `SUPABASE_ACCESS_TOKEN` — gerado em supabase.com/dashboard/account/tokens
- `SUPABASE_PROJECT_ID` — o "Project ref" do seu projeto Supabase
- `SUPABASE_DB_PASSWORD` — senha do banco definida na criação do projeto

### 2. Secrets das Edge Functions (para as chamadas de API)
No painel do Supabase: `Edge Functions > Manage secrets`, ou via CLI:
```
supabase secrets set APIFY_TOKEN=... APIFY_ACTOR_ID=... ASSEMBLYAI_API_KEY=... ANTHROPIC_API_KEY=...
```
(`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já ficam disponíveis automaticamente
dentro das Edge Functions.)

### 3. Cadastro de influenciadores
Inserir manualmente na tabela `influenciador` (via SQL editor do Supabase) —
a conexão self-service pelo próprio influenciador fica para a V2.

### 4. Agendamento (cron)
Configurar em `Database > Cron Jobs` no Supabase (usa `pg_cron` +
`pg_net` para chamar as Edge Functions via HTTP no horário definido).

## Pendências conhecidas
- Taxonomia de editorias em `process-content` é um placeholder inicial —
  ajustar para as editorias reais usadas na análise manual.
- `mapItem` em `scrape-trigger` está ajustado para o ator `apify/instagram-scraper`
  (posts com imagem não têm `media_url`, então não passam por transcrição/categorização
  por vídeo — via legenda ainda seria possível, mas não é o foco do MVP).
- Sem tratamento ainda para re-scrape com frequência diferenciada (diário para
  posts recentes, semanal para mais antigos) — todo o conteúdo em janela é
  reprocessado igualmente por enquanto.
