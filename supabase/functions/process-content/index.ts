// Para cada conteúdo ainda sem transcrição: transcreve via AssemblyAI
// (usando a media_url direta, sem baixar nada) e categoriza via Claude.
// Pensado para rodar via cron logo após o scrape-trigger.

const ASSEMBLYAI_API_KEY = Deno.env.get("ASSEMBLYAI_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Taxonomia inicial de editorias — ajustar com base no que vocês já usam hoje.
const EDITORIAS = [
  "bastidores",
  "educativo",
  "humor",
  "review_produto",
  "storytime",
  "tutorial",
  "opiniao",
  "outro",
];

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

async function transcrever(mediaUrl: string): Promise<string> {
  const submit = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: ASSEMBLYAI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ audio_url: mediaUrl, language_code: "pt" }),
  });
  if (!submit.ok) {
    throw new Error(`AssemblyAI submit falhou: ${submit.status} ${await submit.text()}`);
  }
  const { id } = await submit.json();

  // Polling — aceitável no volume do MVP; se o vídeo demorar mais que ~2min
  // de processamento, considerar mover para um fluxo assíncrono com webhook.
  for (let tentativa = 0; tentativa < 40; tentativa++) {
    await new Promise((r) => setTimeout(r, 3000));
    const check = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: ASSEMBLYAI_API_KEY },
    });
    const data = await check.json();
    if (data.status === "completed") return data.text ?? "";
    if (data.status === "error") throw new Error(`AssemblyAI erro: ${data.error}`);
  }
  throw new Error("Timeout esperando transcrição do AssemblyAI");
}

async function categorizar(transcricao: string, legenda: string, metricas: {
  likes: number;
  comentarios: number;
  views: number | null;
}): Promise<string> {
  const prompt =
    `Classifique o conteúdo abaixo em UMA das editorias: ${EDITORIAS.join(", ")}.\n\n` +
    `Legenda: ${legenda}\n\n` +
    `Transcrição: ${transcricao}\n\n` +
    `Métricas: ${metricas.likes} likes, ${metricas.comentarios} comentários` +
    (metricas.views ? `, ${metricas.views} views` : "") +
    `.\n\nResponda APENAS com o nome exato de uma editoria da lista, nada mais.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 20,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic falhou: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const texto = data.content?.[0]?.text?.trim().toLowerCase() ?? "outro";
  return EDITORIAS.includes(texto) ? texto : "outro";
}

Deno.serve(async (_req) => {
  try {
    // conteúdo sem transcrição ainda, com media_url disponível
    const pendentes: any[] = await supabaseRequest(
      "conteudo?media_url=not.is.null&select=id,media_url,legenda," +
        "metrica_snapshot(likes,comentarios,views,data_coleta)," +
        "transcricao(id)&transcricao=is.null" +
        "&order=metrica_snapshot(data_coleta).desc",
    );

    const resultados = [];
    for (const conteudo of pendentes) {
      try {
        const texto = await transcrever(conteudo.media_url);

        await supabaseRequest("transcricao", {
          method: "POST",
          body: JSON.stringify({
            conteudo_id: conteudo.id,
            texto,
            provider: "assemblyai",
          }),
        });

        const metricaMaisRecente = conteudo.metrica_snapshot?.[0] ??
          { likes: 0, comentarios: 0, views: null };

        const editoria = await categorizar(texto, conteudo.legenda ?? "", metricaMaisRecente);

        await supabaseRequest(`conteudo?id=eq.${conteudo.id}`, {
          method: "PATCH",
          body: JSON.stringify({ editoria }),
        });

        resultados.push({ conteudo_id: conteudo.id, editoria, ok: true });
      } catch (err) {
        resultados.push({ conteudo_id: conteudo.id, ok: false, erro: String(err) });
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
