-- Correções encontradas por revisão manual do usuário — todos os 3 casos
-- compartilham a mesma causa raiz: post categorizado sem transcrição
-- disponível, só pela legenda ambígua.

-- "As divas vão reconhecer essa música" (Barbie canta pro gatinho) —
-- na verdade é ela cantando com o pai tocando piano. Não é Pets.
update conteudo
set editoria = 'Cultura & Entretenimento', subeditoria = 'Música'
where id = '27c8833b-033a-45b9-943b-230595c745ed';

-- "Que dor no 💔" — é sobre mudança de casa, não bastidores genéricos.
update conteudo
set editoria = 'Casa & Moradia', subeditoria = 'Mudança'
where id = '68c29ac0-43cb-4381-836e-a5c3add897a1';
