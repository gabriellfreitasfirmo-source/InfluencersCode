-- Schema inicial: pipeline de análise de influenciadores
-- influenciador -> conteudo -> metrica_snapshot (histórico) / transcricao
-- insight_relatorio agrega tudo por período

create table influenciador (
  id uuid primary key default gen_random_uuid(),
  handle text not null,
  plataforma text not null check (plataforma in ('instagram', 'tiktok', 'youtube')),
  data_inicio_monitoramento date not null default current_date,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (handle, plataforma)
);

create table conteudo (
  id uuid primary key default gen_random_uuid(),
  influenciador_id uuid not null references influenciador (id) on delete cascade,
  post_id text not null, -- id do post na plataforma de origem (vem do Apify)
  url text not null,
  media_url text, -- url direta do vídeo/áudio, usada na transcrição sem download
  tipo text, -- reel, post, story, short, etc.
  legenda text,
  data_publicacao timestamptz not null,
  editoria text, -- preenchido depois da categorização por IA
  created_at timestamptz not null default now(),
  unique (influenciador_id, post_id)
);

create index idx_conteudo_influenciador on conteudo (influenciador_id);
create index idx_conteudo_data_publicacao on conteudo (data_publicacao);

-- Histórico de métricas: um registro por coleta, nunca sobrescrito.
-- É isso que permite ver a curva de evolução de um conteúdo ao longo do tempo.
create table metrica_snapshot (
  id uuid primary key default gen_random_uuid(),
  conteudo_id uuid not null references conteudo (id) on delete cascade,
  data_coleta timestamptz not null default now(),
  likes integer not null default 0,
  comentarios integer not null default 0,
  views integer,
  compartilhamentos integer,
  unique (conteudo_id, data_coleta)
);

create index idx_metrica_conteudo on metrica_snapshot (conteudo_id, data_coleta);

create table transcricao (
  id uuid primary key default gen_random_uuid(),
  conteudo_id uuid not null unique references conteudo (id) on delete cascade,
  texto text not null,
  idioma text default 'pt',
  provider text, -- qual API de transcrição gerou (assemblyai, whisper, etc.)
  created_at timestamptz not null default now()
);

create table insight_relatorio (
  id uuid primary key default gen_random_uuid(),
  influenciador_id uuid not null references influenciador (id) on delete cascade,
  periodo_inicio date not null,
  periodo_fim date not null,
  editorias_analisadas jsonb not null default '[]'::jsonb, -- agregados por editoria
  recomendacoes text not null,
  gerado_em timestamptz not null default now()
);

create index idx_insight_influenciador on insight_relatorio (influenciador_id, gerado_em desc);
