-- Post categorizado errado como "Pets" (legenda ambigua "O divo esta solteiro"
-- sem transcricao disponivel na hora da categorizacao manual). Confirmado via
-- Instagram: e uma performance de piano do pai da influenciadora.
update conteudo
set editoria = 'Cultura & Entretenimento', subeditoria = 'Música'
where id = '74082c7c-c189-486e-9cad-ca71dc86c54d';
