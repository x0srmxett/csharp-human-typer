import * as http from 'http';
import type { AddressInfo } from 'net';

export interface ServerOptions {
  port: number;
  token: string;
  /** Recibe la instruccion ya autenticada. */
  onInstruction: (instruction: string) => Promise<void>;
  /** Escribe un texto ya generado (sin llamar a la API). */
  onTypeText: (text: string, file: string | undefined, silent: boolean) => Promise<void>;
  /** Healthcheck / info basica. */
  getStatus: () => Record<string, unknown>;
  /** Solicitud de parada de la escritura en curso. */
  onStop: () => void;
  /** Errores en segundo plano (se registran, no se muestran si el modo es discreto). */
  onError: (message: string) => void;
}

const MAX_BODY_BYTES = 256 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Cuerpo de la peticion demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error('JSON invalido.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Human-Typer-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

/**
 * Servidor HTTP ligero (localhost) que recibe las instrucciones del script `escribir`.
 * Se protege con un token que se envia en la cabecera `X-Human-Typer-Token`.
 */
export class InstructionServer {
  private server: http.Server | null = null;
  private actualPort = 0;
  private lastError: string | undefined;

  constructor(private readonly options: ServerOptions) {}

  get port(): number {
    return this.actualPort;
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[csharp-human-typer]', error);
    this.lastError = message;
    this.options.onError(message);
  }

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<number> {
    if (this.server) {
      return this.actualPort;
    }

    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.port, '127.0.0.1');
    });

    server.on('error', (error) => {
      this.lastError = String(error);
      console.error('[csharp-human-typer] server error', error);
    });

    this.server = server;
    this.actualPort = (server.address() as AddressInfo).port;
    this.lastError = undefined;
    return this.actualPort;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers['x-human-typer-token'] ?? req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) {
      return false;
    }
    const token = value.replace(/^Bearer\s+/i, '').trim();
    // Comparacion en tiempo constante sencilla.
    const expected = this.options.token;
    if (token.length !== expected.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < token.length; i++) {
      diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.actualPort}`);

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Human-Typer-Token',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
        send(res, 200, { ok: true, port: this.actualPort, error: this.lastError, ...this.options.getStatus() });
        return;
      }
      if (!this.isAuthorized(req)) {
        send(res, 401, { ok: false, error: 'Token invalido. Usa la cabecera X-Human-Typer-Token.' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/stop') {
        this.options.onStop();
        send(res, 200, { ok: true, stopped: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/type') {
        const body = await readJsonBody(req);
        const text = String(body.text ?? '');
        if (!text.trim()) {
          send(res, 400, { ok: false, error: 'Falta el campo "text".' });
          return;
        }
        const file = body.file ? String(body.file) : undefined;
        const silent = body.silent !== false;
        send(res, 202, { ok: true, accepted: true, chars: text.length, silent });
        setImmediate(() => {
          void this.options.onTypeText(text, file, silent).catch((error: unknown) => {
            this.reportError(error);
          });
        });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/typing' || url.pathname === '/instruction' || url.pathname === '/')) {
        const body = await readJsonBody(req);
        const instruction = String(body.instruction ?? body.text ?? body.input ?? '').trim();
        if (!instruction) {
          send(res, 400, { ok: false, error: 'Falta el campo "instruction".' });
          return;
        }

        // Responde de inmediato y trabaja en segundo plano: la terminal recupera el control.
        send(res, 202, { ok: true, accepted: true, instruction });
        setImmediate(() => {
          void this.options.onInstruction(instruction).catch((error: unknown) => {
            this.reportError(error);
          });
        });
        return;
      }

      send(res, 404, { ok: false, error: 'Ruta no encontrada.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        send(res, 500, { ok: false, error: message });
      } else {
        res.end();
      }
    }
  }
}
