// Para conteúdo ainda sem transcrição: transcreve via AssemblyAI (usando a
// media_url direta, sem baixar nada) e categoriza via Gemini. Processa só
// alguns itens por chamada (LIMITE_PADRAO) pra nunca passar do tempo máximo
// de execução da Edge Function — o cron chama de novo até esvaziar a fila.

const LIMITE_PADRAO = 1;

const TRIGGER_SECRET = Deno.env.get("TRIGGER_SECRET")!;
const ASSEMBLYAI_API_KEY = Deno.env.get("ASSEMBLYAI_API_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
// gemini-2.0-flash é o modelo estável mais barato no momento em que isso foi
// escrito. Se o Google lançar um "flash" mais novo/barato, troque aqui ou via
// secret GEMINI_MODEL — confira nomes atuais em ai.google.dev/gemini-api/docs/models.
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.0-flash";
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

// O CDN do Instagram bloqueia requisições servidor-a-servidor sem os headers
// de navegador (a AssemblyAI recebia "could not connect to the host" tentando
// baixar direto). Por isso buscamos o vídeo aqui dentro (em memória, nada vai
// pro disco) e mandamos os bytes pra AssemblyAI via upload, em vez de só
// passar a URL.
async function baixarEEnviarParaAssemblyAI(mediaUrl: string): Promise<string> {
  const video = await fetch(mediaUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Referer: "https://www.instagram.com/",
    },
  });
  if (!video.ok) {
    throw new Error(`Download do vídeo falhou: ${video.status}`);
  }

  const upload = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { authorization: ASSEMBLYAI_API_KEY },
    body: video.body, // stream direto, sem acumular tudo em memória
  });
  if (!upload.ok) {
    throw new Error(`Upload pra AssemblyAI falhou: ${upload.status} ${await upload.text()}`);
  }
  const { upload_url } = await upload.json();
  return upload_url;
}

async function transcrever(mediaUrl: string): Promise<string> {
  const uploadUrl = await baixarEEnviarParaAssemblyAI(mediaUrl);

  const submit = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: ASSEMBLYAI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ audio_url: uploadUrl, language_code: "pt" }),
  });
  if (!submit.ok) {
    throw new Error(`AssemblyAI submit falhou: ${submit.status} ${await submit.text()}`);
  }
  const { id } = await submit.json();

  // Polling com teto de ~90s — deixa margem dentro do tempo máximo de
  // execução da Edge Function. Se estourar, cai no catch do item e tenta de
  // novo na próxima chamada (a transcrição não fica "pela metade" no banco).
  for (let tentativa = 0; tentativa < 30; tentativa++) {
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

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 20 },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Gemini falhou: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() ?? "outro";
  return EDITORIAS.includes(texto) ? texto : "outro";
}

Deno.serve(async (req) => {
  try {
    const params = new URL(req.url).searchParams;
    const secretRecebido = req.headers.get("x-trigger-secret") ?? params.get("secret");
    if (secretRecebido !== TRIGGER_SECRET) {
      return new Response(JSON.stringify({ ok: false, erro: "não autorizado" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const limite = Number(params.get("limite")) || LIMITE_PADRAO;

    // conteúdo sem transcrição ainda, com media_url disponível. A ordenação
    // por métrica mais recente é feita no código abaixo — o PostgREST não
    // aceita "order" numa tabela relacionada 1-para-N como metrica_snapshot.
    // O "limit" aqui é o que evita passar do tempo máximo de execução.
    const pendentes: any[] = await supabaseRequest(
      "conteudo?media_url=not.is.null&select=id,media_url,legenda," +
        "metrica_snapshot(likes,comentarios,views,data_coleta)," +
        `transcricao(id)&transcricao=is.null&limit=${limite}`,
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

        const snapshots = [...(conteudo.metrica_snapshot ?? [])].sort(
          (a, b) => new Date(b.data_coleta).getTime() - new Date(a.data_coleta).getTime(),
        );
        const metricaMaisRecente = snapshots[0] ?? { likes: 0, comentarios: 0, views: null };

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
