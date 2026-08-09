// Exporta o conteúdo (legenda + transcrição + métricas) em CSV pra
// categorização manual. Por padrão só traz quem ainda não tem editoria —
// passe ?todos=1 pra exportar tudo, mesmo já categorizado.

const TRIGGER_SECRET = Deno.env.get("TRIGGER_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function supabaseRequest(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${path} falhou: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Escapa um campo pra CSV: envolve em aspas se tiver vírgula, aspas ou quebra
// de linha, e duplica aspas internas.
function csvField(valor: unknown): string {
  const texto = valor === null || valor === undefined ? "" : String(valor);
  if (/[",\n]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
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

    const somenteTodos = params.get("todos") === "1";
    const filtro = somenteTodos ? "" : "&editoria=is.null";

    const conteudos: any[] = await supabaseRequest(
      "conteudo?select=id,url,tipo,data_publicacao,legenda,editoria,subeditoria," +
        "influenciador(handle)," +
        "transcricao(texto)," +
        "metrica_snapshot(likes,comentarios,views,data_coleta)" +
        filtro +
        "&order=data_publicacao.desc",
    );

    const cabecalho = [
      "conteudo_id",
      "handle",
      "url",
      "tipo",
      "data_publicacao",
      "legenda",
      "transcricao",
      "likes",
      "comentarios",
      "views",
      "editoria",
      "subeditoria",
    ];

    const linhas = conteudos.map((c) => {
      const snapshots = [...(c.metrica_snapshot ?? [])].sort(
        (a, b) => new Date(b.data_coleta).getTime() - new Date(a.data_coleta).getTime(),
      );
      const metrica = snapshots[0] ?? { likes: "", comentarios: "", views: "" };

      return [
        c.id,
        c.influenciador?.handle ?? "",
        c.url,
        c.tipo,
        c.data_publicacao,
        c.legenda,
        c.transcricao?.texto ?? "",
        metrica.likes,
        metrica.comentarios,
        metrica.views,
        c.editoria ?? "",
        c.subeditoria ?? "",
      ].map(csvField).join(",");
    });

    const csv = [cabecalho.join(","), ...linhas].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="conteudo_export.csv"',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, erro: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
