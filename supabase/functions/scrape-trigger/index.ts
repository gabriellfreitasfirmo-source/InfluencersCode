// Dispara o scrape no Apify (apify/instagram-scraper) para cada influenciador
// ativo e grava conteúdo + snapshot de métricas no banco. Pensado para rodar
// via cron diário com a janela padrão de 60 dias.
//
// Aceita overrides via query string para rodar um backfill inicial maior:
//   POST /scrape-trigger?dias=120&limite=200

const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN")!;
const APIFY_ACTOR_ID = Deno.env.get("APIFY_ACTOR_ID") ?? "apify~instagram-scraper";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const JANELA_DIAS_PADRAO = 60;
const LIMITE_PADRAO = 60;

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

async function runApifyActor(handle: string, janelaDias: number, limite: number): Promise<any[]> {
  const url =
    `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

  const desde = new Date();
  desde.setDate(desde.getDate() - janelaDias);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resultsType: "posts",
      directUrls: [`https://www.instagram.com/${handle}/`],
      resultsLimit: limite,
      onlyPostsNewerThan: desde.toISOString().slice(0, 10),
    }),
  });

  if (!res.ok) {
    throw new Error(`Apify falhou para @${handle}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Normaliza o item retornado pelo apify/instagram-scraper para o formato interno.
function mapItem(item: any) {
  return {
    post_id: String(item.id ?? item.shortCode),
    url: item.url,
    media_url: item.videoUrl ?? null, // null em posts de imagem — nada a transcrever
    tipo: item.type ?? "post",
    legenda: item.caption ?? "",
    data_publicacao: item.timestamp ?? new Date().toISOString(),
    likes: item.likesCount ?? 0,
    comentarios: item.commentsCount ?? 0,
    views: item.videoViewCount ?? item.videoPlayCount ?? null,
    compartilhamentos: null, // não exposto publicamente pelo Instagram
  };
}

async function processInfluenciador(
  influenciador: Influenciador,
  janelaDias: number,
  limite: number,
) {
  const items = await runApifyActor(influenciador.handle, janelaDias, limite);

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
  }

  return { handle: influenciador.handle, posts_processados: items.length };
}

Deno.serve(async (req) => {
  try {
    const params = new URL(req.url).searchParams;
    const janelaDias = Number(params.get("dias")) || JANELA_DIAS_PADRAO;
    const limite = Number(params.get("limite")) || LIMITE_PADRAO;

    const influenciadores: Influenciador[] = await supabaseRequest(
      "influenciador?ativo=eq.true&select=id,handle,plataforma",
    );

    const resultados = [];
    for (const inf of influenciadores) {
      try {
        resultados.push(await processInfluenciador(inf, janelaDias, limite));
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
