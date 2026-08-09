-- Agendamento automático: scrape diário + drenagem da fila de transcrição.
-- O valor do TRIGGER_SECRET não fica aqui (não deve ir pro git) — ele é lido
-- do Vault do Supabase por nome. Antes desta migration fazer efeito, rode UMA
-- VEZ no SQL Editor do Supabase (troque 'SUA_SENHA' pelo mesmo valor do
-- secret TRIGGER_SECRET das Edge Functions):
--
--   select vault.create_secret('SUA_SENHA', 'trigger_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Scrape diário (janela e limite padrão: 60 dias / 60 posts, definidos no
-- próprio código da função — não precisamos repetir aqui).
select cron.schedule(
  'scrape-trigger-diario',
  '0 6 * * *', -- 06:00 UTC = 03:00 no horário de Brasília
  $$
  select net.http_post(
    url := 'https://ohlwhswsengxqprlvwhi.supabase.co/functions/v1/scrape-trigger',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-trigger-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'trigger_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Drena a fila de transcrição a cada 10 minutos, poucos itens por vez
-- (evita passar do tempo máximo de execução da função).
select cron.schedule(
  'process-content-fila',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://ohlwhswsengxqprlvwhi.supabase.co/functions/v1/process-content?limite=5',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-trigger-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'trigger_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
