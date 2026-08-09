-- soulljess e mariliafavero foram só para testar o pipeline (scrape,
-- transcrição, export) — não são clientes reais ainda. Marcamos como
-- inativas para que o cron (quando ligado) não processe ninguém à toa.
update influenciador
set ativo = false
where handle in ('soulljess', 'mariliafavero');
