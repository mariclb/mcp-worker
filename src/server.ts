import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";

const MOODLE_URL =
  "https://presencial.moodle.ufsc.br/webservice/rest/server.php";

async function getSecret(name: string): Promise<string> {
  const secret = (env as any)[name];
  return await secret.get();
}

async function moodleCall(
  wsfunction: string,
  params: Record<string, string> = {}
) {
  const token = await getSecret("MOODLE_TOKEN");

  const query = new URLSearchParams({
    wstoken: token,
    wsfunction,
    moodlewsrestformat: "json",
    ...params
  });

  const response = await fetch(`${MOODLE_URL}?${query.toString()}`);

  if (!response.ok) {
    throw new Error(`Erro Moodle HTTP ${response.status}`);
  }

  const data: any = await response.json();

  if (data?.exception) {
    throw new Error(data.message || data.exception);
  }

  return data;
}

function createServer() {
  const server = new McpServer({
    name: "Moodle UFSC",
    version: "1.0.0"
  });

  server.registerTool(
    "listar_disciplinas",
    {
      description:
        "Lista as disciplinas disponíveis para a usuária autenticada no Moodle Presencial da UFSC.",
      inputSchema: {}
    },
    async () => {
      const siteInfo = await moodleCall(
        "core_webservice_get_site_info"
      );

      const courses = await moodleCall(
        "core_enrol_get_users_courses",
        {
          userid: String(siteInfo.userid)
        }
      );

      const disciplinas = courses.map((course: any) => ({
        id: course.id,
        nome: course.fullname,
        nome_curto: course.shortname,
        inicio: course.startdate,
        fim: course.enddate,
        ultimo_acesso: course.lastaccess
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(disciplinas, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

export default {
  async fetch(request: Request, workerEnv: any, ctx: ExecutionContext) {
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
