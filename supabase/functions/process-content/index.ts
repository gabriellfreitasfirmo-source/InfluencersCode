// Para conteúdo de vídeo ainda sem transcrição: busca o vídeo (em memória,
// nada em disco) e envia pra AssemblyAI. Posts de imagem não passam por
// aqui (não tem o que transcrever). A categorização (campo `editoria`) fica
// como etapa manual por enquanto — ver README.
//
// Processa só alguns itens por chamada (LIMITE_PADRAO) pra nunca passar do
// tempo máximo de execução da Edge Function — o cron chama de novo até
// esvaziar a fila.

const LIMITE_PADRAO = 1;

const TRIGGER_SECRET = Deno.env.get("TRIGGER_SECRET")!;
const ASSEMBLYAI_API_KEY = Deno.env.get("ASSEMBLYAI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    if (data.status === "error") {
      // Alguns vídeos do Instagram são servidos sem faixa de áudio embutida.
      // Não é um erro pra tentar de novo — tratamos como transcrição vazia.
      if (String(data.error).includes("No audio stream found")) return "";
      throw new Error(`AssemblyAI erro: ${data.error}`);
    }
  }
  throw new Error("Timeout esperando transcrição do AssemblyAI");
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

    const pendentes: any[] = await supabaseRequest(
      `conteudo?media_url=not.is.null&transcricao=is.null&select=id,media_url&limit=${limite}`,
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

        resultados.push({ conteudo_id: conteudo.id, ok: true });
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
