// Dispara o scrape no Apify para cada influenciador ativo e grava
// conteúdo + snapshot de métricas no banco. Pensado para rodar via cron diário.
//
// IMPORTANTE: o mapeamento de campos abaixo (ITEM_FIELD_MAP) assume o formato
// de saída de um ator genérico de scraping de Instagram/TikTok. Ajuste os
// nomes de campo conforme o ator específico que vocês usam no Apify —
// rode o ator uma vez e compare com o JSON retornado.

const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN")!;
const APIFY_ACTOR_ID = Deno.env.get("APIFY_ACTOR_ID")!; // ex: "apify~instagram-scraper"
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const JANELA_DIAS = 60;

interface Influenciador {
  id: string;
  handle: string;
  plataforma: string;
}

async function supabaseRequest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${path} falhou: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function runApifyActor(handle: string): Promise<any[]> {
  const url =
    `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

  const desde = new Date();
  desde.setDate(desde.getDate() - JANELA_DIAS);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // TODO: ajustar conforme o input schema do ator escolhido no Apify.
      username: handle,
      resultsLimit: 60,
      onlyPostsNewerThan: desde.toISOString().slice(0, 10),
    }),
  });

  if (!res.ok) {
    throw new Error(`Apify falhou para @${handle}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Normaliza o item retornado pelo Apify para o formato interno.
// TODO: ajustar os nomes de campo conforme o ator real.
function mapItem(item: any) {
  return {
    post_id: String(item.id ?? item.shortCode ?? item.postId),
    url: item.url ?? item.postUrl,
    media_url: item.videoUrl ?? item.mediaUrl ?? null,
    tipo: item.type ?? item.productType ?? "post",
    legenda: item.caption ?? item.text ?? "",
    data_publicacao: item.timestamp ?? item.createTime ?? new Date().toISOString(),
    likes: item.likesCount ?? item.diggCount ?? 0,
    comentarios: item.commentsCount ?? item.commentCount ?? 0,
    views: item.videoViewCount ?? item.playCount ?? null,
    compartilhamentos: item.sharesCount ?? item.shareCount ?? null,
  };
}

async function processInfluenciador(influenciador: Influenciador) {
  const items = await runApifyActor(influenciador.handle);
  let novos = 0;
  let atualizados = 0;

  for (const raw of items) {
    const item = mapItem(raw);

    // upsert do conteúdo (identificado por influenciador_id + post_id)
    const [conteudo] = await supabaseRequest("conteudo", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        influenciador_id: influenciador.id,
        post_id: item.post_id,
        url: item.url,
        media_url: item.media_url,
        tipo: item.tipo,
        legenda: item.legenda,
        data_publicacao: item.data_publicacao,
      }),
    });

    // snapshot de métrica: sempre insere um novo registro, nunca sobrescreve
    await supabaseRequest("metrica_snapshot", {
      method: "POST",
      body: JSON.stringify({
        conteudo_id: conteudo.id,
        likes: item.likes,
        comentarios: item.comentarios,
        views: item.views,
        compartilhamentos: item.compartilhamentos,
      }),
    });

    conteudo.created_at === conteudo.updated_at ? novos++ : atualizados++;
  }

  return { handle: influenciador.handle, posts_processados: items.length, novos, atualizados };
}

Deno.serve(async (_req) => {
  try {
    const influenciadores: Influenciador[] = await supabaseRequest(
      "influenciador?ativo=eq.true&select=id,handle,plataforma",
    );

    const resultados = [];
    for (const inf of influenciadores) {
      try {
        resultados.push(await processInfluenciador(inf));
      } catch (err) {
        resultados.push({ handle: inf.handle, erro: String(err) });
      }
    }

    return new Response(JSON.stringify({ ok: true, resultados }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, erro: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
