import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getDocument } from "pdfjs-serverless";

const MOODLE_URL =
  "https://presencial.moodle.ufsc.br/webservice/rest/server.php";

const MOODLE_HOST = "presencial.moodle.ufsc.br";
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PDF_PAGES = 60;
const MAX_TEXT_CHARS = 120_000;

type MoodleIdentity = "graduacao" | "pos";

const TOKEN_BINDINGS: Record<MoodleIdentity, string> = {
  graduacao: "MOODLE_TOKEN",
  pos: "MOODLE_TOKEN_POS"
};

async function getSecret(name: string): Promise<string> {
  const secret = (env as any)[name];

  if (!secret) {
    throw new Error(`Secret binding não encontrado: ${name}`);
  }

  return await secret.get();
}

async function moodleCall(
  identity: MoodleIdentity,
  wsfunction: string,
  params: Record<string, string> = {}
) {
  const tokenBinding = TOKEN_BINDINGS[identity];
  const token = await getSecret(tokenBinding);

  const query = new URLSearchParams({
    wstoken: token,
    wsfunction,
    moodlewsrestformat: "json",
    ...params
  });

  const response = await fetch(
    `${MOODLE_URL}?${query.toString()}`
  );

  if (!response.ok) {
    throw new Error(
      `Erro Moodle HTTP ${response.status} na identidade ${identity}`
    );
  }

  const data: any = await response.json();

  if (data?.exception) {
    throw new Error(
      `Erro Moodle na identidade ${identity}: ${
        data.message || data.exception
      }`
    );
  }

  return data;
}

async function listarCursosDaIdentidade(
  identity: MoodleIdentity
) {
  const siteInfo = await moodleCall(
    identity,
    "core_webservice_get_site_info"
  );

  const courses = await moodleCall(
    identity,
    "core_enrol_get_users_courses",
    {
      userid: String(siteInfo.userid)
    }
  );

  return courses.map((course: any) => ({
    id: course.id,
    nome: course.fullname,
    nome_curto: course.shortname,
    inicio: course.startdate,
    fim: course.enddate,
    ultimo_acesso: course.lastaccess,
    identidade: identity,
    userid: siteInfo.userid
  }));
}

async function encontrarDisciplina(
  courseid: number
): Promise<{
  identidade: MoodleIdentity;
  curso: any;
}> {
  const [graduacao, pos] = await Promise.all([
    listarCursosDaIdentidade("graduacao"),
    listarCursosDaIdentidade("pos")
  ]);

  const cursoGraduacao = graduacao.find(
    (curso: any) => Number(curso.id) === Number(courseid)
  );

  if (cursoGraduacao) {
    return {
      identidade: "graduacao",
      curso: cursoGraduacao
    };
  }

  const cursoPos = pos.find(
    (curso: any) => Number(curso.id) === Number(courseid)
  );

  if (cursoPos) {
    return {
      identidade: "pos",
      curso: cursoPos
    };
  }

  throw new Error(
    `Disciplina com courseid ${courseid} não encontrada.`
  );
}

async function extrairPendenciasDaDisciplina(
  curso: any,
  identidade: MoodleIdentity
) {
  const conteudo = await moodleCall(
    identidade,
    "core_course_get_contents",
    {
      courseid: String(curso.id)
    }
  );

  const pendencias: any[] = [];

  if (!Array.isArray(conteudo)) {
    return pendencias;
  }

  for (const secao of conteudo) {
    if (!Array.isArray(secao.modules)) continue;

    for (const modulo of secao.modules) {
      if (modulo.modname !== "assign") continue;

      const datas = Array.isArray(modulo.dates)
        ? modulo.dates
        : [];

      const abertura = datas.find(
        (d: any) =>
          d.dataid === "allowsubmissionsfromdate" ||
          d.label?.toLowerCase().includes("abertura") ||
          d.label?.toLowerCase().includes("disponível")
      );

      const vencimento = datas.find(
        (d: any) =>
          d.dataid === "duedate" ||
          d.label?.toLowerCase().includes("vencimento") ||
          d.label?.toLowerCase().includes("entrega")
      );

      pendencias.push({
        disciplina_id: curso.id,
        disciplina: curso.nome,
        disciplina_nome_curto: curso.nome_curto,
        identidade,
        secao: secao.name,
        atividade_id: modulo.id,
        atividade: modulo.name,
        tipo: modulo.modname,
        url: modulo.url,
        visivel: modulo.visible,
        abertura: abertura?.timestamp ?? null,
        vencimento: vencimento?.timestamp ?? null,
        datas
      });
    }
  }

  return pendencias;
}

function normalizarTexto(valor: any): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function correspondeAoTermo(
  termo: string,
  valores: any[]
): boolean {
  const termoNormalizado = normalizarTexto(termo);

  return valores.some((valor) =>
    normalizarTexto(valor).includes(termoNormalizado)
  );
}


async function obterMateriaisDaDisciplina(courseid: number) {
  const { identidade, curso } =
    await encontrarDisciplina(courseid);

  const conteudo = await moodleCall(
    identidade,
    "core_course_get_contents",
    {
      courseid: String(courseid)
    }
  );

  const tiposMaterial = new Set([
    "resource",
    "folder",
    "url",
    "page",
    "book"
  ]);

  const materiais: any[] = [];

  if (Array.isArray(conteudo)) {
    for (const secao of conteudo) {
      if (!Array.isArray(secao.modules)) continue;

      for (const modulo of secao.modules) {
        if (!tiposMaterial.has(modulo.modname)) continue;

        const arquivos = Array.isArray(modulo.contents)
          ? modulo.contents.map((arquivo: any) => ({
              nome: arquivo.filename ?? null,
              tipo: arquivo.type ?? null,
              mimetype: arquivo.mimetype ?? null,
              tamanho: arquivo.filesize ?? null,
              url_arquivo: arquivo.fileurl ?? null,
              modificado_em: arquivo.timemodified ?? null
            }))
          : [];

        materiais.push({
          disciplina_id: curso.id,
          disciplina: curso.nome,
          identidade,
          secao_id: secao.id,
          secao: secao.name,
          modulo_id: modulo.id,
          nome: modulo.name,
          tipo: modulo.modname,
          url: modulo.url ?? null,
          descricao: modulo.description ?? null,
          visivel: modulo.visible,
          arquivos
        });
      }
    }
  }

  return { identidade, curso, materiais };
}

function localizarPrimeiroArquivo(
  materiais: any[],
  termo: string
) {
  for (const material of materiais) {
    const arquivos = Array.isArray(material.arquivos)
      ? material.arquivos
      : [];

    for (const arquivo of arquivos) {
      if (
        arquivo.url_arquivo &&
        correspondeAoTermo(termo, [
          material.nome,
          arquivo.nome,
          arquivo.mimetype
        ])
      ) {
        return { material, arquivo };
      }
    }
  }

  return null;
}

function criarUrlAutenticada(
  fileUrl: string,
  token: string
) {
  const url = new URL(fileUrl);

  if (url.hostname !== MOODLE_HOST) {
    throw new Error(
      "URL de arquivo fora do domínio Moodle UFSC."
    );
  }

  if (!url.pathname.startsWith("/webservice/pluginfile.php/")) {
    throw new Error(
      "A URL encontrada não é um arquivo webservice/pluginfile do Moodle."
    );
  }

  url.searchParams.set("token", token);
  return url;
}

async function baixarArquivoAutenticado(
  fileUrl: string,
  identidade: MoodleIdentity,
  limiteBytes: number = MAX_PDF_BYTES
) {
  const token = await getSecret(TOKEN_BINDINGS[identidade]);
  const url = criarUrlAutenticada(fileUrl, token);

  const response = await fetch(url.toString(), {
    method: "GET",
    redirect: "manual"
  });

  if (response.status >= 300 && response.status < 400) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {}
    }

    throw new Error(
      `Download retornou redirecionamento HTTP ${response.status}.`
    );
  }

  if (!response.ok) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {}
    }

    throw new Error(
      `Falha no download do arquivo: HTTP ${response.status}.`
    );
  }

  const contentType =
    response.headers.get("content-type") ?? "";

  const contentLengthHeader =
    response.headers.get("content-length");

  const contentLength = contentLengthHeader
    ? Number(contentLengthHeader)
    : null;

  if (
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength > limiteBytes
  ) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {}
    }

    return {
      sucesso: false as const,
      motivo: "arquivo_muito_grande" as const,
      tamanho_bytes: contentLength,
      content_type: contentType
    };
  }

  if (!response.body) {
    throw new Error(
      "O Moodle retornou o arquivo sem corpo de resposta."
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;

    if (total > limiteBytes) {
      try {
        await reader.cancel();
      } catch {}

      return {
        sucesso: false as const,
        motivo: "arquivo_muito_grande" as const,
        tamanho_bytes: total,
        content_type: contentType
      };
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    sucesso: true as const,
    bytes,
    tamanho_bytes: total,
    content_type: contentType
  };
}

async function extrairTextoPdf(bytes: Uint8Array) {
  const loadingTask = getDocument({
    data: bytes,
    useSystemFonts: true
  });

  const pdf = await loadingTask.promise;
  const paginasTotal = pdf.numPages;
  const limitePaginas = Math.min(
    paginasTotal,
    MAX_PDF_PAGES
  );

  const partes: string[] = [];
  let caracteres = 0;
  let paginasProcessadas = 0;
  let textoTruncado = false;

  try {
    for (let i = 1; i <= limitePaginas; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      const textoPagina = textContent.items
        .map((item: any) =>
          typeof item?.str === "string" ? item.str : ""
        )
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const bloco = `\n\n--- Página ${i} ---\n${textoPagina}`;
      const restante = MAX_TEXT_CHARS - caracteres;

      if (restante <= 0) {
        textoTruncado = true;
        break;
      }

      if (bloco.length > restante) {
        partes.push(bloco.slice(0, restante));
        caracteres += restante;
        paginasProcessadas = i;
        textoTruncado = true;
        break;
      }

      partes.push(bloco);
      caracteres += bloco.length;
      paginasProcessadas = i;
    }

    if (paginasTotal > limitePaginas) {
      textoTruncado = true;
    }
  } finally {
    try {
      await pdf.destroy();
    } catch {}
  }

  const texto = partes.join("").trim();

  return {
    paginas_total: paginasTotal,
    paginas_processadas: paginasProcessadas,
    limite_paginas: MAX_PDF_PAGES,
    caracteres_retornados: texto.length,
    limite_caracteres: MAX_TEXT_CHARS,
    truncado: textoTruncado,
    texto
  };
}


function truncarTexto(valor: any, limite: number = 4000): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor);
  return texto.length > limite
    ? texto.slice(0, limite) + `\n...[truncado em ${limite} caracteres]`
    : texto;
}

async function diagnosticarFormatosPlano(
  courseid: number,
  termo?: string
) {
  const { identidade, curso } =
    await encontrarDisciplina(courseid);

  const conteudo = await moodleCall(
    identidade,
    "core_course_get_contents",
    {
      courseid: String(courseid)
    }
  );

  const paginasModulo: any[] = [];
  const arquivosDocx: any[] = [];

  if (Array.isArray(conteudo)) {
    for (const secao of conteudo) {
      if (!Array.isArray(secao.modules)) continue;

      for (const modulo of secao.modules) {
        if (modulo.modname === "page") {
          const candidato = {
            secao: secao.name,
            id: modulo.id,
            nome: modulo.name,
            url: modulo.url ?? null,
            descricao: truncarTexto(modulo.description, 2000),
            disponibilidade: modulo.availability ?? null
          };

          if (
            !termo ||
            correspondeAoTermo(termo, [
              secao.name,
              modulo.name,
              modulo.description
            ])
          ) {
            paginasModulo.push(candidato);
          }
        }

        const contents = Array.isArray(modulo.contents)
          ? modulo.contents
          : [];

        for (const arquivo of contents) {
          const nome = arquivo.filename ?? "";
          const mimetype = arquivo.mimetype ?? "";
          const ehDocx =
            normalizarTexto(nome).endsWith(".docx") ||
            normalizarTexto(mimetype).includes(
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            );

          if (!ehDocx) continue;

          if (
            termo &&
            !correspondeAoTermo(termo, [
              secao.name,
              modulo.name,
              nome,
              mimetype
            ])
          ) {
            continue;
          }

          arquivosDocx.push({
            secao: secao.name,
            modulo_id: modulo.id,
            modulo_nome: modulo.name,
            nome,
            mimetype,
            tamanho_moodle: arquivo.filesize ?? null,
            url_arquivo: arquivo.fileurl ?? null
          });
        }
      }
    }
  }

  let paginasApi: any = null;
  let erroPaginasApi: string | null = null;

  try {
    const retorno = await moodleCall(
      identidade,
      "mod_page_get_pages_by_courses",
      {
        "courseids[0]": String(courseid)
      }
    );

    const pages = Array.isArray(retorno?.pages)
      ? retorno.pages
      : [];

    paginasApi = {
      total: pages.length,
      warnings: retorno?.warnings ?? [],
      paginas: pages
        .filter((page: any) =>
          !termo ||
          correspondeAoTermo(termo, [
            page.name,
            page.intro,
            page.content
          ])
        )
        .map((page: any) => ({
          id: page.id ?? null,
          course: page.course ?? null,
          name: page.name ?? null,
          timemodified: page.timemodified ?? null,
          intro: truncarTexto(page.intro, 4000),
          content: truncarTexto(page.content, 8000),
          campos_disponiveis: Object.keys(page)
        }))
    };
  } catch (error: any) {
    erroPaginasApi = error?.message || String(error);
  }

  const testesDocx: any[] = [];

  for (const docx of arquivosDocx.slice(0, 3)) {
    if (!docx.url_arquivo) {
      testesDocx.push({
        nome: docx.nome,
        sucesso: false,
        motivo: "sem_url_arquivo"
      });
      continue;
    }

    try {
      const download = await baixarArquivoAutenticado(
        docx.url_arquivo,
        identidade,
        MAX_PDF_BYTES
      );

      if (!download.sucesso) {
        testesDocx.push({
          nome: docx.nome,
          sucesso: false,
          motivo: download.motivo,
          tamanho_bytes: download.tamanho_bytes,
          content_type: download.content_type
        });
        continue;
      }

      const assinatura = Array.from(
        download.bytes.slice(0, 4)
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");

      testesDocx.push({
        nome: docx.nome,
        sucesso: true,
        tamanho_bytes: download.tamanho_bytes,
        content_type: download.content_type,
        assinatura_hex_4_bytes: assinatura,
        parece_zip_docx:
          download.bytes.length >= 4 &&
          download.bytes[0] === 0x50 &&
          download.bytes[1] === 0x4b
      });
    } catch (error: any) {
      testesDocx.push({
        nome: docx.nome,
        sucesso: false,
        motivo: "erro_download",
        erro: error?.message || String(error)
      });
    }
  }

  return {
    disciplina: {
      id: curso.id,
      nome: curso.nome,
      nome_curto: curso.nome_curto,
      identidade
    },
    filtro_termo: termo ?? null,
    html: {
      paginas_detectadas_no_curso: paginasModulo.length,
      paginas_modulo: paginasModulo,
      mod_page_get_pages_by_courses: paginasApi,
      erro_api_paginas: erroPaginasApi
    },
    docx: {
      arquivos_detectados: arquivosDocx.length,
      arquivos: arquivosDocx,
      testes_download: testesDocx
    }
  };
}

function createServer() {
  const server = new McpServer({
    name: "Moodle UFSC",
    version: "6.1.0"
  });

  server.registerTool(
    "listar_disciplinas",
    {
      description:
        "Lista as disciplinas disponíveis nas identidades de graduação e pós-graduação da usuária autenticada no Moodle Presencial da UFSC.",
      inputSchema: z.object({})
    },
    async () => {
      const [graduacao, pos] = await Promise.all([
        listarCursosDaIdentidade("graduacao"),
        listarCursosDaIdentidade("pos")
      ]);

      const todas = [...graduacao, ...pos];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total: todas.length,
                graduacao: {
                  total: graduacao.length,
                  disciplinas: graduacao
                },
                pos: {
                  total: pos.length,
                  disciplinas: pos
                },
                todas
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  server.registerTool(
    "consultar_disciplina",
    {
      description:
        "Consulta o conteúdo interno de uma disciplina específica do Moodle UFSC. Use listar_disciplinas para descobrir o courseid.",
      inputSchema: z.object({
        courseid: z
          .number()
          .int()
          .positive()
          .describe(
            "ID numérico da disciplina retornado por listar_disciplinas"
          )
      })
    },
    async ({ courseid }) => {
      try {
        const { identidade, curso } =
          await encontrarDisciplina(courseid);

        const conteudo = await moodleCall(
          identidade,
          "core_course_get_contents",
          {
            courseid: String(courseid)
          }
        );

        const secoes = Array.isArray(conteudo)
          ? conteudo.map((secao: any) => ({
              id: secao.id,
              nome: secao.name,
              resumo: secao.summary,
              visivel: secao.visible,
              modulos: Array.isArray(secao.modules)
                ? secao.modules.map((modulo: any) => ({
                    id: modulo.id,
                    nome: modulo.name,
                    tipo: modulo.modname,
                    url: modulo.url,
                    visivel: modulo.visible,
                    descricao: modulo.description,
                    disponibilidade: modulo.availability,
                    datas: modulo.dates,
                    conteudos: modulo.contents
                  }))
                : []
            }))
          : [];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: true,
                  disciplina: {
                    id: curso.id,
                    nome: curso.nome,
                    nome_curto: curso.nome_curto,
                    identidade
                  },
                  total_secoes: secoes.length,
                  secoes
                },
                null,
                2
              )
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: false,
                  courseid,
                  erro: error?.message || String(error)
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "listar_pendencias",
    {
      description:
        "Lista assignments do semestre 2026.2 com filtros por janela de dias, identidade e disciplina. Retorna tarefas ordenadas por vencimento.",
      inputSchema: z.object({
        dias: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe(
            "Quantidade de dias futuros a considerar a partir de agora"
          ),

        identidade: z
          .enum(["graduacao", "pos", "todas"])
          .default("todas")
          .describe(
            "Filtra por graduação, pós-graduação ou ambas"
          ),

        courseid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "ID opcional de uma disciplina específica"
          ),

        incluir_sem_data: z
          .boolean()
          .default(false)
          .describe(
            "Se verdadeiro, inclui assignments sem data de vencimento"
          )
      })
    },
    async ({
      dias = 7,
      identidade = "todas",
      courseid,
      incluir_sem_data = false
    }) => {
      try {
        const agora = Math.floor(Date.now() / 1000);
        const limite = agora + dias * 24 * 60 * 60;

        let graduacao: any[] = [];
        let pos: any[] = [];

        if (
          identidade === "graduacao" ||
          identidade === "todas"
        ) {
          graduacao =
            await listarCursosDaIdentidade("graduacao");
        }

        if (
          identidade === "pos" ||
          identidade === "todas"
        ) {
          pos =
            await listarCursosDaIdentidade("pos");
        }

        let cursosAtivos = [
          ...graduacao.filter((curso: any) =>
            String(curso.nome_curto).includes("20262")
          ),
          ...pos.filter((curso: any) =>
            String(curso.nome_curto).includes("20262")
          )
        ];

        if (courseid) {
          cursosAtivos = cursosAtivos.filter(
            (curso: any) =>
              Number(curso.id) === Number(courseid)
          );
        }

        if (courseid && cursosAtivos.length === 0) {
          throw new Error(
            `Disciplina com courseid ${courseid} não encontrada no semestre 2026.2 para o filtro selecionado.`
          );
        }

        const resultados: any[] = [];

        for (const curso of cursosAtivos) {
          const identidadeCurso =
            curso.identidade as MoodleIdentity;

          const pendencias =
            await extrairPendenciasDaDisciplina(
              curso,
              identidadeCurso
            );

          resultados.push(...pendencias);
        }

        const filtradas = resultados
          .filter((item: any) => {
            if (item.vencimento === null) {
              return incluir_sem_data;
            }

            return (
              item.vencimento >= agora &&
              item.vencimento <= limite
            );
          })
          .sort((a: any, b: any) => {
            if (
              a.vencimento === null &&
              b.vencimento === null
            ) {
              return 0;
            }

            if (a.vencimento === null) return 1;
            if (b.vencimento === null) return -1;

            return a.vencimento - b.vencimento;
          });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: true,
                  semestre: "20262",
                  filtros: {
                    dias,
                    identidade,
                    courseid: courseid ?? null,
                    incluir_sem_data
                  },
                  periodo: {
                    inicio_timestamp: agora,
                    fim_timestamp: limite
                  },
                  disciplinas_consultadas:
                    cursosAtivos.length,
                  total: filtradas.length,
                  pendencias: filtradas
                },
                null,
                2
              )
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: false,
                  erro: error?.message || String(error)
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "listar_materiais",
    {
      description:
        "Lista e pesquisa materiais de uma disciplina do Moodle UFSC. Permite busca ampla ou exata por nome, seção, tipo e arquivos.",
      inputSchema: z.object({
        courseid: z
          .number()
          .int()
          .positive()
          .describe(
            "ID numérico da disciplina retornado por listar_disciplinas"
          ),

        termo: z
          .string()
          .trim()
          .optional()
          .describe(
            "Termo opcional para pesquisar materiais ou arquivos"
          ),

        modo: z
          .enum(["amplo", "exato"])
          .default("amplo")
          .describe(
            "amplo encontra materiais relacionados ao termo; exato retorna apenas módulos ou arquivos cujo próprio nome/metadados contenham o termo"
          )
      })
    },
    async ({
      courseid,
      termo,
      modo = "amplo"
    }) => {
      try {
        const { identidade, curso, materiais } =
          await obterMateriaisDaDisciplina(courseid);

        let resultado = materiais;

        if (termo) {
          if (modo === "amplo") {
            resultado = materiais.filter(
              (material: any) => {
                const arquivosTexto =
                  material.arquivos
                    .map((arquivo: any) =>
                      [
                        arquivo.nome,
                        arquivo.tipo,
                        arquivo.mimetype
                      ]
                        .filter(Boolean)
                        .join(" ")
                    )
                    .join(" ");

                return correspondeAoTermo(
                  termo,
                  [
                    material.nome,
                    material.secao,
                    material.tipo,
                    material.descricao,
                    arquivosTexto
                  ]
                );
              }
            );
          }

          if (modo === "exato") {
            resultado = materiais
              .map((material: any) => {
                const moduloCorresponde =
                  correspondeAoTermo(
                    termo,
                    [
                      material.nome,
                      material.tipo,
                      material.descricao
                    ]
                  );

                const arquivosCorrespondentes =
                  material.arquivos.filter(
                    (arquivo: any) =>
                      correspondeAoTermo(
                        termo,
                        [
                          arquivo.nome,
                          arquivo.tipo,
                          arquivo.mimetype
                        ]
                      )
                  );

                if (
                  !moduloCorresponde &&
                  arquivosCorrespondentes.length === 0
                ) {
                  return null;
                }

                return {
                  ...material,
                  arquivos: moduloCorresponde
                    ? material.arquivos
                    : arquivosCorrespondentes
                };
              })
              .filter(Boolean);
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: true,
                  disciplina: {
                    id: curso.id,
                    nome: curso.nome,
                    nome_curto: curso.nome_curto,
                    identidade
                  },
                  filtro: {
                    termo: termo ?? null,
                    modo
                  },
                  total: resultado.length,
                  materiais: resultado
                },
                null,
                2
              )
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: false,
                  courseid,
                  termo: termo ?? null,
                  modo,
                  erro: error?.message || String(error)
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
      }
    }
  );



  server.registerTool(
    "testar_acesso_material",
    {
      description:
        "Testa se o Worker consegue baixar de forma autenticada um arquivo de uma disciplina do Moodle UFSC. Não retorna o conteúdo nem expõe tokens.",
      inputSchema: z.object({
        courseid: z
          .number()
          .int()
          .positive()
          .describe("ID numérico da disciplina"),
        termo: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Termo para localizar o arquivo a ser testado, por exemplo DEMATEL"
          )
      })
    },
    async ({ courseid, termo }) => {
      try {
        const { identidade, curso, materiais } =
          await obterMateriaisDaDisciplina(courseid);

        const encontrado =
          localizarPrimeiroArquivo(materiais, termo);

        if (!encontrado) {
          throw new Error(
            `Nenhum arquivo com o termo "${termo}" foi encontrado na disciplina.`
          );
        }

        const resultado = await baixarArquivoAutenticado(
          encontrado.arquivo.url_arquivo,
          identidade
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: resultado.sucesso,
                  disciplina: {
                    id: curso.id,
                    nome: curso.nome,
                    identidade
                  },
                  material: {
                    nome: encontrado.material.nome,
                    secao: encontrado.material.secao
                  },
                  arquivo: {
                    nome: encontrado.arquivo.nome,
                    mimetype: encontrado.arquivo.mimetype,
                    tamanho_moodle: encontrado.arquivo.tamanho
                  },
                  download: resultado.sucesso
                    ? {
                        status_http: 200,
                        tamanho_bytes: resultado.tamanho_bytes,
                        content_type: resultado.content_type
                      }
                    : {
                        motivo: resultado.motivo,
                        tamanho_bytes: resultado.tamanho_bytes,
                        content_type: resultado.content_type
                      }
                },
                null,
                2
              )
            }
          ],
          isError: !resultado.sucesso
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: false,
                  courseid,
                  termo,
                  erro: error?.message || String(error)
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "ler_material",
    {
      description:
        "Localiza e lê o texto de um PDF do Moodle UFSC. PDFs acima de 8 MB não são processados e retornam uma indicação estruturada de arquivo grande.",
      inputSchema: z.object({
        courseid: z
          .number()
          .int()
          .positive()
          .describe(
            "ID numérico da disciplina retornado por listar_disciplinas"
          ),
        termo: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Termo usado para localizar o PDF, por exemplo DEMATEL ou plano de ensino"
          )
      })
    },
    async ({ courseid, termo }) => {
      try {
        const { identidade, curso, materiais } =
          await obterMateriaisDaDisciplina(courseid);

        const encontrado =
          localizarPrimeiroArquivo(materiais, termo);

        if (!encontrado) {
          throw new Error(
            `Nenhum arquivo com o termo "${termo}" foi encontrado na disciplina.`
          );
        }

        const nomeArquivo =
          encontrado.arquivo.nome ?? "arquivo";
        const mimetypeMoodle =
          encontrado.arquivo.mimetype ?? null;

        const parecePdf =
          normalizarTexto(nomeArquivo).endsWith(".pdf") ||
          normalizarTexto(mimetypeMoodle).includes("application/pdf");

        if (!parecePdf) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sucesso: false,
                    motivo: "formato_nao_suportado",
                    disciplina: {
                      id: curso.id,
                      nome: curso.nome,
                      identidade
                    },
                    arquivo: {
                      nome: nomeArquivo,
                      mimetype: mimetypeMoodle
                    },
                    mensagem:
                      "A leitura automática desta versão suporta apenas arquivos PDF."
                  },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }

        const download = await baixarArquivoAutenticado(
          encontrado.arquivo.url_arquivo,
          identidade,
          MAX_PDF_BYTES
        );

        if (!download.sucesso) {
          const tamanhoMb =
            Math.round(
              (download.tamanho_bytes / 1024 / 1024) * 100
            ) / 100;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sucesso: false,
                    motivo: "arquivo_muito_grande",
                    limite_mb: MAX_PDF_BYTES / 1024 / 1024,
                    tamanho_mb: tamanhoMb,
                    arquivo: nomeArquivo,
                    disciplina: {
                      id: curso.id,
                      nome: curso.nome,
                      identidade
                    },
                    mensagem:
                      "O PDF excede o limite de processamento direto do Worker."
                  },
                  null,
                  2
                )
              }
            ],
            isError: false
          };
        }

        const contentType =
          normalizarTexto(download.content_type);

        if (
          contentType &&
          !contentType.includes("application/pdf") &&
          !contentType.includes("octet-stream")
        ) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sucesso: false,
                    motivo: "resposta_nao_pdf",
                    arquivo: nomeArquivo,
                    content_type: download.content_type,
                    mensagem:
                      "O Moodle não retornou um conteúdo reconhecido como PDF."
                  },
                  null,
                  2
                )
              }
            ],
            isError: true
          };
        }

        const extracao =
          await extrairTextoPdf(download.bytes);

        const semTexto =
          extracao.texto.trim().length === 0;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: !semTexto,
                  motivo: semTexto
                    ? "pdf_sem_texto_extraivel"
                    : null,
                  disciplina: {
                    id: curso.id,
                    nome: curso.nome,
                    identidade
                  },
                  material: {
                    nome: encontrado.material.nome,
                    secao: encontrado.material.secao
                  },
                  arquivo: {
                    nome: nomeArquivo,
                    mimetype: mimetypeMoodle,
                    tamanho_bytes: download.tamanho_bytes,
                    tamanho_mb:
                      Math.round(
                        (download.tamanho_bytes / 1024 / 1024) * 100
                      ) / 100
                  },
                  extracao: {
                    paginas_total: extracao.paginas_total,
                    paginas_processadas:
                      extracao.paginas_processadas,
                    limite_paginas:
                      extracao.limite_paginas,
                    caracteres_retornados:
                      extracao.caracteres_retornados,
                    limite_caracteres:
                      extracao.limite_caracteres,
                    truncado: extracao.truncado
                  },
                  mensagem: semTexto
                    ? "O PDF foi aberto, mas não contém texto extraível. Pode ser um PDF digitalizado/imagem."
                    : extracao.truncado
                      ? "Texto extraído com sucesso, mas o retorno foi truncado pelos limites de segurança."
                      : "Texto extraído com sucesso.",
                  texto: extracao.texto
                },
                null,
                2
              )
            }
          ],
          isError: false
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: false,
                  courseid,
                  termo,
                  motivo: "erro_leitura_pdf",
                  erro: error?.message || String(error)
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
      }
    }
  );


  server.registerTool(
    "testar_formatos_plano",
    {
      description:
        "Diagnostica suporte a planos de ensino em página HTML do Moodle e arquivos DOCX. Não altera dados e não extrai ainda o texto do DOCX.",
      inputSchema: z.object({
        courseid: z
          .number()
          .int()
          .positive()
          .describe(
            "ID numérico da disciplina retornado por listar_disciplinas"
          ),
        termo: z
          .string()
          .trim()
          .optional()
          .describe(
            "Termo opcional para filtrar páginas ou arquivos, como plano, cronograma ou ensino"
          )
      })
    },
    async ({ courseid, termo }) => {
      try {
        const diagnostico = await diagnosticarFormatosPlano(
          courseid,
          termo
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: true,
                  ...diagnostico
                },
                null,
                2
              )
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sucesso: false,
                  courseid,
                  termo: termo ?? null,
                  motivo: "erro_diagnostico_formatos",
                  erro: error?.message || String(error)
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
      }
    }
  );

  return server;
}

export default {
  async fetch(
    request: Request,
    workerEnv: any,
    ctx: ExecutionContext
  ) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      const expectedKey =
        await workerEnv.CLAUDE_CONNECTOR_KEY_V2.get();

      const authorization =
        request.headers.get("authorization");

      const providedKey =
        authorization?.startsWith("Bearer ")
          ? authorization.slice(7)
          : null;

      if (!providedKey || providedKey !== expectedKey) {
        return new Response("Unauthorized", {
          status: 401
        });
      }
    }

    return createMcpHandler(createServer)(
      request,
      workerEnv,
      ctx
    );
  }
} satisfies ExportedHandler;
