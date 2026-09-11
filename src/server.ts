import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getDocument } from "pdfjs-serverless";
import { unzipSync } from "fflate";

const MOODLE_URL =
  "https://presencial.moodle.ufsc.br/webservice/rest/server.php";

const MOODLE_HOST = "presencial.moodle.ufsc.br";
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PDF_PAGES = 60;
const MAX_TEXT_CHARS = 120_000;
const MAX_DOCX_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

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


function decodificarEntidadesHtml(texto: string): string {
  const entidades: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " "
  };

  return texto
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) =>
      entidades[m] ?? m
    )
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code)
        ? String.fromCodePoint(code)
        : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code)
        ? String.fromCodePoint(code)
        : _m;
    });
}

function htmlParaTexto(html: string): string {
  return decodificarEntidadesHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function xmlWordParaTexto(xml: string): string {
  const comQuebras = xml
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")
    .replace(/<w:br\b[^>]*\/>/gi, "\n")
    .replace(/<w:cr\b[^>]*\/>/gi, "\n")
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<\/w:tr>/gi, "\n")
    .replace(/<\/w:tc>/gi, "\t");

  return decodificarEntidadesHtml(
    comQuebras.replace(/<[^>]+>/g, "")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extrairTextoDocx(bytes: Uint8Array) {
  const zip = unzipSync(bytes);
  const decoder = new TextDecoder("utf-8");

  const nomes = Object.keys(zip).filter((nome) =>
    /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/i.test(
      nome
    )
  );

  if (!nomes.includes("word/document.xml")) {
    throw new Error(
      "O DOCX não contém word/document.xml e não pôde ser interpretado."
    );
  }

  nomes.sort((a, b) => {
    if (a === "word/document.xml") return -1;
    if (b === "word/document.xml") return 1;
    return a.localeCompare(b);
  });

  const partes: string[] = [];

  for (const nome of nomes) {
    const xml = decoder.decode(zip[nome]);
    const texto = xmlWordParaTexto(xml);
    if (!texto) continue;

    const rotulo =
      nome === "word/document.xml"
        ? "Documento"
        : nome
            .replace("word/", "")
            .replace(".xml", "");

    partes.push(`--- ${rotulo} ---\n${texto}`);
  }

  const textoCompleto = partes.join("\n\n").trim();
  const truncado = textoCompleto.length > MAX_TEXT_CHARS;
  const texto = truncado
    ? textoCompleto.slice(0, MAX_TEXT_CHARS)
    : textoCompleto;

  return {
    caracteres_totais_estimados: textoCompleto.length,
    caracteres_retornados: texto.length,
    limite_caracteres: MAX_TEXT_CHARS,
    truncado,
    partes_xml_processadas: nomes,
    texto
  };
}

function extrairUrlsIframe(html: string): string[] {
  const urls: string[] = [];
  const regex = /<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    if (match[1]) {
      urls.push(decodificarEntidadesHtml(match[1]));
    }
  }

  return [...new Set(urls)];
}

async function baixarTextoLimitado(
  urlTexto: string,
  limiteBytes: number = MAX_HTML_BYTES
) {
  const url = new URL(urlTexto);

  const hostsPermitidos = new Set([
    "docs.google.com",
    MOODLE_HOST
  ]);

  if (!hostsPermitidos.has(url.hostname)) {
    throw new Error(
      `Host não permitido para leitura HTML: ${url.hostname}`
    );
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 Moodle-UFSC-MCP/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Falha ao baixar HTML: HTTP ${response.status}.`
    );
  }

  const lengthHeader = response.headers.get("content-length");
  const contentLength = lengthHeader ? Number(lengthHeader) : null;

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

    throw new Error(
      `HTML excede o limite de ${Math.round(
        limiteBytes / 1024 / 1024
      )} MB.`
    );
  }

  if (!response.body) {
    return "";
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
      throw new Error(
        `HTML excede o limite de ${Math.round(
          limiteBytes / 1024 / 1024
        )} MB.`
      );
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(bytes);
}

async function obterPaginaMoodle(
  courseid: number,
  identidade: MoodleIdentity,
  termo: string
) {
  const retorno = await moodleCall(
    identidade,
    "mod_page_get_pages_by_courses",
    {
      "courseids[0]": String(courseid)
    }
  );

  const paginas = Array.isArray(retorno?.pages)
    ? retorno.pages
    : [];

  const candidatos = paginas.filter((page: any) =>
    correspondeAoTermo(termo, [
      page.name,
      page.intro,
      page.content
    ])
  );

  if (candidatos.length === 0) {
    return null;
  }

  candidatos.sort(
    (a: any, b: any) =>
      Number(b.timemodified ?? 0) -
      Number(a.timemodified ?? 0)
  );

  return candidatos[0];
}


async function obterModuloExatoDoCurso(
  courseid: number,
  identidade: MoodleIdentity,
  moduloId: number
) {
  const conteudo = await moodleCall(
    identidade,
    "core_course_get_contents",
    {
      courseid: String(courseid)
    }
  );

  if (!Array.isArray(conteudo)) {
    return null;
  }

  for (const secao of conteudo) {
    if (!Array.isArray(secao.modules)) continue;

    const modulo = secao.modules.find(
      (item: any) => Number(item.id) === Number(moduloId)
    );

    if (modulo) {
      return {
        secao,
        modulo
      };
    }
  }

  return null;
}

async function obterPaginaMoodlePorModuloId(
  courseid: number,
  identidade: MoodleIdentity,
  moduloId: number
) {
  const localizado = await obterModuloExatoDoCurso(
    courseid,
    identidade,
    moduloId
  );

  if (!localizado) {
    throw new Error(
      `Módulo ${moduloId} não encontrado no courseid ${courseid}.`
    );
  }

  const { modulo } = localizado;

  if (modulo.modname !== "page") {
    return null;
  }

  const retorno = await moodleCall(
    identidade,
    "mod_page_get_pages_by_courses",
    {
      "courseids[0]": String(courseid)
    }
  );

  const paginas = Array.isArray(retorno?.pages)
    ? retorno.pages
    : [];

  // Algumas versões do Moodle expõem o cmid como coursemodule/cmid.
  const porCourseModule = paginas.find(
    (page: any) =>
      Number(page.coursemodule ?? page.cmid ?? 0) ===
      Number(moduloId)
  );

  if (porCourseModule) {
    return porCourseModule;
  }

  // Fallback determinístico: o nome do módulo em core_course_get_contents
  // corresponde ao nome da instância da página. A comparação é EXATA,
  // portanto "Plano de Ensino_Detalhado" não casa com "(copiado)".
  const porNomeExato = paginas.filter(
    (page: any) =>
      String(page.name ?? "").trim() ===
      String(modulo.name ?? "").trim()
  );

  if (porNomeExato.length === 1) {
    return porNomeExato[0];
  }

  if (porNomeExato.length > 1) {
    const porInstance = porNomeExato.find(
      (page: any) =>
        Number(page.id ?? 0) === Number(modulo.instance ?? -1)
    );

    if (porInstance) {
      return porInstance;
    }

    throw new Error(
      `O módulo ${moduloId} corresponde a mais de uma página com o mesmo nome e não foi possível resolver de forma determinística.`
    );
  }

  throw new Error(
    `A página do módulo ${moduloId} foi encontrada no curso, mas não pôde ser associada de forma determinística ao retorno de mod_page_get_pages_by_courses.`
  );
}

function localizarArquivosDoModuloExato(
  materiais: any[],
  moduloId: number
) {
  const material = materiais.find(
    (item: any) => Number(item.modulo_id) === Number(moduloId)
  );

  if (!material) {
    return null;
  }

  const arquivos = Array.isArray(material.arquivos)
    ? material.arquivos
    : [];

  return {
    material,
    arquivos
  };
}

async function extrairTextoPaginaMoodle(page: any) {
  const content = String(page?.content ?? "");
  const textoDireto = htmlParaTexto(content);
  const iframes = extrairUrlsIframe(content);
  const fontes: any[] = [];
  const partes: string[] = [];

  if (textoDireto) {
    partes.push(textoDireto);
    fontes.push({
      tipo: "html_moodle",
      url: null,
      caracteres: textoDireto.length
    });
  }

  for (const iframeUrl of iframes.slice(0, 5)) {
    try {
      const url = new URL(iframeUrl);

      if (url.hostname !== "docs.google.com") {
        fontes.push({
          tipo: "iframe_nao_suportado",
          url: iframeUrl
        });
        continue;
      }

      const htmlPublicado = await baixarTextoLimitado(
        iframeUrl,
        MAX_HTML_BYTES
      );
      const textoPublicado = htmlParaTexto(htmlPublicado);

      if (textoPublicado) {
        partes.push(textoPublicado);
        fontes.push({
          tipo: url.pathname.includes("/presentation/")
            ? "google_slides_publicado"
            : "google_docs_publicado",
          url: iframeUrl,
          caracteres: textoPublicado.length
        });
      }
    } catch (error: any) {
      fontes.push({
        tipo: "erro_iframe",
        url: iframeUrl,
        erro: error?.message || String(error)
      });
    }
  }

  const textoCompleto = partes
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const truncado = textoCompleto.length > MAX_TEXT_CHARS;
  const texto = truncado
    ? textoCompleto.slice(0, MAX_TEXT_CHARS)
    : textoCompleto;

  return {
    texto,
    truncado,
    caracteres_retornados: texto.length,
    limite_caracteres: MAX_TEXT_CHARS,
    iframes_detectados: iframes,
    fontes
  };
}

function localizarArquivoPorTermo(
  materiais: any[],
  termo: string,
  extensoes: string[]
) {
  const extNorm = extensoes.map((e) => normalizarTexto(e));

  for (const material of materiais) {
    const arquivos = Array.isArray(material.arquivos)
      ? material.arquivos
      : [];

    for (const arquivo of arquivos) {
      const nome = normalizarTexto(arquivo.nome);
      const mime = normalizarTexto(arquivo.mimetype);
      const formatoOk = extNorm.some(
        (ext) => nome.endsWith(ext) || mime.includes(ext.replace(".", ""))
      );

      if (
        formatoOk &&
        arquivo.url_arquivo &&
        correspondeAoTermo(termo, [
          material.nome,
          material.secao,
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
    version: "6.3.0"
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
        "Localiza e lê materiais acadêmicos do Moodle UFSC em PDF, DOCX ou página HTML. Pode selecionar exatamente um módulo por modulo_id; quando modulo_id é informado, ele tem precedência total sobre termo.",
      inputSchema: z
        .object({
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
            .optional()
            .describe(
              "Termo usado para localizar o material quando modulo_id não for informado"
            ),
          modulo_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "ID exato do módulo (cmid) retornado por consultar_disciplina/listar_materiais. Quando informado, ignora correspondências por termo e lê somente esse módulo."
            )
        })
        .refine(
          (dados) => Boolean(dados.termo || dados.modulo_id),
          {
            message:
              "Informe termo ou modulo_id para localizar o material."
          }
        )
    },
    async ({ courseid, termo, modulo_id }) => {
      try {
        const { identidade, curso, materiais } =
          await obterMateriaisDaDisciplina(courseid);

        let arquivoPdf: any = null;
        let arquivoDocx: any = null;
        let pagina: any = null;
        let selecao: any = null;

        if (modulo_id) {
          const moduloExato = await obterModuloExatoDoCurso(
            courseid,
            identidade,
            modulo_id
          );

          if (!moduloExato) {
            throw new Error(
              `Módulo ${modulo_id} não encontrado na disciplina ${courseid}.`
            );
          }

          const { secao, modulo } = moduloExato;

          selecao = {
            modo: "modulo_id",
            modulo_id,
            modulo_nome: modulo.name ?? null,
            modulo_tipo: modulo.modname ?? null,
            secao: secao.name ?? null
          };

          if (modulo.modname === "page") {
            pagina = await obterPaginaMoodlePorModuloId(
              courseid,
              identidade,
              modulo_id
            );
          } else {
            const localizado = localizarArquivosDoModuloExato(
              materiais,
              modulo_id
            );

            if (!localizado) {
              throw new Error(
                `O módulo ${modulo_id} foi encontrado, mas não possui material de arquivo suportado por ler_material.`
              );
            }

            const pdf = localizado.arquivos.find(
              (arquivo: any) => {
                const nome = normalizarTexto(arquivo.nome);
                const mime = normalizarTexto(arquivo.mimetype);
                return (
                  nome.endsWith(".pdf") ||
                  mime.includes("application/pdf")
                );
              }
            );

            const docx = localizado.arquivos.find(
              (arquivo: any) => {
                const nome = normalizarTexto(arquivo.nome);
                const mime = normalizarTexto(arquivo.mimetype);
                return (
                  nome.endsWith(".docx") ||
                  mime.includes(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  )
                );
              }
            );

            if (pdf) {
              arquivoPdf = {
                material: localizado.material,
                arquivo: pdf
              };
            } else if (docx) {
              arquivoDocx = {
                material: localizado.material,
                arquivo: docx
              };
            } else {
              throw new Error(
                `O módulo ${modulo_id} foi localizado, mas não contém PDF ou DOCX suportado.`
              );
            }
          }
        } else {
          const termoBusca = String(termo);

          selecao = {
            modo: "termo",
            termo: termoBusca
          };

          arquivoPdf = localizarArquivoPorTermo(
            materiais,
            termoBusca,
            [".pdf", "application/pdf"]
          );

          arquivoDocx = localizarArquivoPorTermo(
            materiais,
            termoBusca,
            [
              ".docx",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ]
          );

          pagina = await obterPaginaMoodle(
            courseid,
            identidade,
            termoBusca
          );
        }

        if (!arquivoPdf && !arquivoDocx && !pagina) {
          throw new Error(
            modulo_id
              ? `O módulo ${modulo_id} não contém material em formato suportado.`
              : `Nenhum material suportado com o termo "${termo}" foi encontrado na disciplina.`
          );
        }

        if (arquivoPdf) {
          const nomeArquivo =
            arquivoPdf.arquivo.nome ?? "arquivo.pdf";

          const download = await baixarArquivoAutenticado(
            arquivoPdf.arquivo.url_arquivo,
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
                      formato: "pdf",
                      selecao,
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

          const extracao = await extrairTextoPdf(download.bytes);
          const semTexto = extracao.texto.trim().length === 0;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sucesso: !semTexto,
                    formato: "pdf",
                    selecao,
                    motivo: semTexto
                      ? "pdf_sem_texto_extraivel"
                      : null,
                    disciplina: {
                      id: curso.id,
                      nome: curso.nome,
                      identidade
                    },
                    material: {
                      modulo_id: arquivoPdf.material.modulo_id,
                      nome: arquivoPdf.material.nome,
                      secao: arquivoPdf.material.secao
                    },
                    arquivo: {
                      nome: nomeArquivo,
                      mimetype: arquivoPdf.arquivo.mimetype,
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
                      limite_paginas: extracao.limite_paginas,
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
        }

        if (arquivoDocx) {
          const nomeArquivo =
            arquivoDocx.arquivo.nome ?? "arquivo.docx";

          const download = await baixarArquivoAutenticado(
            arquivoDocx.arquivo.url_arquivo,
            identidade,
            MAX_DOCX_BYTES
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
                      formato: "docx",
                      selecao,
                      motivo: "arquivo_muito_grande",
                      limite_mb: MAX_DOCX_BYTES / 1024 / 1024,
                      tamanho_mb: tamanhoMb,
                      arquivo: nomeArquivo,
                      disciplina: {
                        id: curso.id,
                        nome: curso.nome,
                        identidade
                      },
                      mensagem:
                        "O DOCX excede o limite de processamento direto do Worker."
                    },
                    null,
                    2
                  )
                }
              ],
              isError: false
            };
          }

          const extracao = extrairTextoDocx(download.bytes);
          const semTexto = extracao.texto.trim().length === 0;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sucesso: !semTexto,
                    formato: "docx",
                    selecao,
                    motivo: semTexto
                      ? "docx_sem_texto_extraivel"
                      : null,
                    disciplina: {
                      id: curso.id,
                      nome: curso.nome,
                      identidade
                    },
                    material: {
                      modulo_id: arquivoDocx.material.modulo_id,
                      nome: arquivoDocx.material.nome,
                      secao: arquivoDocx.material.secao
                    },
                    arquivo: {
                      nome: nomeArquivo,
                      mimetype: arquivoDocx.arquivo.mimetype,
                      tamanho_bytes: download.tamanho_bytes,
                      tamanho_mb:
                        Math.round(
                          (download.tamanho_bytes / 1024 / 1024) * 100
                        ) / 100
                    },
                    extracao: {
                      caracteres_totais_estimados:
                        extracao.caracteres_totais_estimados,
                      caracteres_retornados:
                        extracao.caracteres_retornados,
                      limite_caracteres:
                        extracao.limite_caracteres,
                      truncado: extracao.truncado,
                      partes_xml_processadas:
                        extracao.partes_xml_processadas
                    },
                    mensagem: semTexto
                      ? "O DOCX foi aberto, mas não contém texto extraível."
                      : extracao.truncado
                        ? "Texto do DOCX extraído com sucesso, mas truncado pelo limite de segurança."
                        : "Texto do DOCX extraído com sucesso.",
                    texto: extracao.texto
                  },
                  null,
                  2
                )
              }
            ],
            isError: false
          };
        }

        if (pagina) {
          const extracao = await extrairTextoPaginaMoodle(pagina);
          const semTexto = extracao.texto.trim().length === 0;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    sucesso: !semTexto,
                    formato: "pagina_html",
                    selecao,
                    motivo: semTexto
                      ? "pagina_sem_texto_extraivel"
                      : null,
                    disciplina: {
                      id: curso.id,
                      nome: curso.nome,
                      identidade
                    },
                    pagina: {
                      id: pagina.id ?? null,
                      coursemodule:
                        pagina.coursemodule ?? pagina.cmid ?? modulo_id ?? null,
                      nome: pagina.name ?? null,
                      timemodified: pagina.timemodified ?? null
                    },
                    extracao: {
                      caracteres_retornados:
                        extracao.caracteres_retornados,
                      limite_caracteres:
                        extracao.limite_caracteres,
                      truncado: extracao.truncado,
                      iframes_detectados:
                        extracao.iframes_detectados,
                      fontes: extracao.fontes
                    },
                    mensagem: semTexto
                      ? "A página foi localizada, mas não foi possível extrair texto útil do HTML ou dos conteúdos incorporados."
                      : extracao.truncado
                        ? "Texto da página extraído com sucesso, mas truncado pelo limite de segurança."
                        : "Texto da página extraído com sucesso.",
                    texto: extracao.texto
                  },
                  null,
                  2
                )
              }
            ],
            isError: false
          };
        }

        throw new Error(
          "Material localizado, mas nenhum formato compatível pôde ser processado."
        );
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
                  modulo_id: modulo_id ?? null,
                  motivo: "erro_leitura_material",
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
