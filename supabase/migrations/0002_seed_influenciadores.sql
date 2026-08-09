-- Cadastro inicial dos influenciadores do piloto.
insert into influenciador (handle, plataforma)
values
  ('soulljess', 'instagram'),
  ('mariliafavero', 'instagram')
on conflict (handle, plataforma) do nothing;
