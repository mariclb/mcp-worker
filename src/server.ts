import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

const MOODLE_URL =
  "https://presencial.moodle.ufsc.br/webservice/rest/server.php";

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

function createServer() {
  const server = new McpServer({
    name: "Moodle UFSC",
    version: "3.0.0"
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
                    disponibilidade:
                      modulo.availability,
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
                  erro:
                    error?.message ||
                    String(error)
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
        "Lista tarefas do tipo assignment encontradas nas disciplinas de graduação e pós-graduação, incluindo datas de abertura, vencimento e links.",
      inputSchema: z.object({})
    },
    async () => {
      try {
        const [graduacao, pos] = await Promise.all([
          listarCursosDaIdentidade("graduacao"),
          listarCursosDaIdentidade("pos")
        ]);

        const resultados = await Promise.all([
          ...graduacao.map((curso: any) =>
            extrairPendenciasDaDisciplina(
              curso,
              "graduacao"
            )
          ),
          ...pos.map((curso: any) =>
            extrairPendenciasDaDisciplina(
              curso,
              "pos"
            )
          )
        ]);

        const pendencias = resultados
          .flat()
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
                  total: pendencias.length,
                  pendencias
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
                  erro:
                    error?.message ||
                    String(error)
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
