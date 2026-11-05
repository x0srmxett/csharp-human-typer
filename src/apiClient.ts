import type { ExtensionConfig } from './config';

export interface GenerateOptions {
  instruction: string;
  config: ExtensionConfig;
  signal?: AbortSignal;
}

export interface GenerateResult {
  /** Texto crudo devuelto por la API (antes de limpiar). */
  raw: string;
}

interface HttpResponse {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
}

/** Proveedores compatibles con el formato OpenAI (DeepSeek, Groq, OpenRouter, LM Studio...). */
function isOpenAiCompatible(url: string): boolean {
  return /\/chat\/completions\/?$/i.test(url) || /deepseek|openai|groq|openrouter|mistral|together|localhost|127\.0\.0\.1/i.test(url);
}

/** Peticion HTTP real. Usa fetch (undici) del propio Node del Extension Host. */
async function request(
  urlString: string,
  payload: string,
  headers: Record<string, string>,
  options: { rejectUnauthorized: boolean; timeoutMs: number; signal?: AbortSignal }
): Promise<HttpResponse> {
  if (!options.rejectUnauthorized) {
    // Red con proxy/antivirus que intercepta TLS con su propio certificado.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetch(urlString, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') ?? '',
      body,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/self.signed certificate|certificate in certificate chain|UNABLE_TO_VERIFY/i.test(message)) {
      throw new Error(
        'El certificado de la API no es de confianza (proxy/antivirus con certificado propio). ' +
          'Activa "csharpHumanTyper.tlsRejectUnauthorized": false en los ajustes si confias en esa red.'
      );
    }
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error(`La API tardo mas de ${options.timeoutMs} ms en responder.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Peticion POST a la API configurada.
 * Soporta endpoints propios ({instruction, system, messages...}) y compatibles con OpenAI
 * (/chat/completions), que es el caso de DeepSeek.
 */
export async function generateCSharp(options: GenerateOptions): Promise<GenerateResult> {
  const { instruction, config, signal } = options;

  if (!config.apiUrl) {
    throw new Error(
      'No hay API configurada. Define API_URL (variable de entorno o .env) o el setting "csharpHumanTyper.apiUrl".'
    );
  }

  let body: Record<string, unknown>;
  if (isOpenAiCompatible(config.apiUrl)) {
    body = {
      model: config.apiModel || 'deepseek-flash',
      messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: instruction },
      ],
      stream: false,
      temperature: 0.2,
    };
  } else {
    body = {
      instruction,
      prompt: instruction,
      system: config.systemPrompt,
      systemPrompt: config.systemPrompt,
      messages: [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: instruction },
      ],
      language: 'csharp',
      stream: false,
    };
    if (config.apiModel) {
      body.model = config.apiModel;
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain',
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    headers['x-api-key'] = config.apiKey;
  }

  const response = await request(config.apiUrl, JSON.stringify(body), headers, {
    rejectUnauthorized: config.tlsRejectUnauthorized,
    timeoutMs: config.requestTimeoutMs,
    signal,
  });

  if (response.status < 200 || response.status >= 300) {
    let detail = response.body.slice(0, 600);
    try {
      const parsed = JSON.parse(response.body) as { error?: { message?: string } | string };
      if (parsed.error) {
        detail = typeof parsed.error === 'string' ? parsed.error : parsed.error.message ?? detail;
      }
    } catch {
      /* respuesta no JSON */
    }
    if (response.status === 401) {
      throw new Error(`La API rechazo la clave (401). Revisa API_KEY. Detalle: ${detail}`);
    }
    if (response.status === 402) {
      throw new Error(`La cuenta de la API no tiene saldo (402). Detalle: ${detail}`);
    }
    throw new Error(`La API respondio ${response.status} ${response.statusText}: ${detail}`);
  }

  return { raw: extractText(response.body, response.contentType) };
}

function extractText(rawBody: string, contentType: string): string {
  const trimmed = rawBody.trim();
  const looksJson = contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');

  if (!looksJson) {
    return rawBody;
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return rawBody;
  }

  const candidate = pickText(data);
  return typeof candidate === 'string' ? candidate : rawBody;
}

function pickText(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    // Anthropic: content: [{ type: 'text', text: '...' }]
    const parts = value.map((item) => pickText(item, depth + 1)).filter((item): item is string => !!item);
    return parts.length > 0 ? parts.join('') : undefined;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // OpenAI / DeepSeek: choices[0].message.content (y reasoning_content como respaldo).
    if (Array.isArray(obj.choices) && obj.choices.length > 0) {
      const first = obj.choices[0] as Record<string, unknown>;
      const found =
        pickText(first?.message, depth + 1) ??
        pickText(first?.text, depth + 1) ??
        pickText(first?.delta, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }

    for (const key of ['code', 'content', 'response', 'result', 'output', 'text', 'message', 'data', 'answer']) {
      if (key in obj) {
        const found = pickText(obj[key], depth + 1);
        if (found !== undefined) {
          return found;
        }
      }
    }
  }
  return undefined;
}
