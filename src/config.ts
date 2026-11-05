import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Configuracion resuelta de la extension.
 * Prioridad: variable de entorno > setting de VS Code > default.
 */
export interface ExtensionConfig {
  apiUrl: string;
  apiKey: string;
  apiModel: string;
  httpPort: number;
  serverToken: string;
  systemPrompt: string;
  tlsRejectUnauthorized: boolean;
  requestTimeoutMs: number;
  /** Modo discreto: sin notificaciones ni foco, todo por terminal/salida. */
  discreet: boolean;
  /** Archivo destino fijo (relativo al workspace). Vacio = editor activo. */
  targetFile: string;
  typing: {
    minDelayMs: number;
    maxDelayMs: number;
    maxChunkSize: number;
    undoEvery: number;
    pauseAtNewlineMs: number;
    clearEditorBeforeTyping: boolean;
    saveAfterTyping: boolean;
  };
}

export const DEFAULT_SYSTEM_PROMPT =
  'Genera unicamente codigo en C# que funcione como la estructura o introduccion del programa solicitado. ' +
  'PROHIBIDO incluir bloques markdown (```csharp), explicaciones en texto, ni ningun tipo de comentario en el codigo ' +
  '(ni // ni /* */). Devuelve exclusivamente codigo C# puro listo para compilar. ' +
  'Escribe con estilo de programador junior, simple y facil de leer: usa tipos explicitos (nunca "var"), ' +
  'concatenacion con + en lugar de interpolacion, Console.ReadLine() con int.Parse o double.Parse, ' +
  'bucles for y foreach, y if/else sencillos. Evita LINQ salvo que la instruccion pida Find, Where o Count; ' +
  'en ese caso usa solo esa llamada con una expresion lambda de una linea. ' +
  'No uses caracteristicas modernas (nada de ?? , patrones, records, funciones locales, clases abstractas ni genericos propios). ' +
  'El programa debe ser completo y compilable: incluye los using necesarios y una sola clase con el metodo Main.';

const SECTION = 'csharpHumanTyper';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Token estable por instalacion/machine: se guarda en globalState para que
 * el script `escribir` siempre pueda autenticarse aunque se reinicie VS Code.
 */
export function resolveServerToken(context: vscode.ExtensionContext): string {
  const fromEnv = env('HUMAN_TYPER_TOKEN');
  if (fromEnv) {
    return fromEnv;
  }

  const fromSetting = vscode.workspace.getConfiguration(SECTION).get<string>('serverToken', '').trim();
  if (fromSetting) {
    return fromSetting;
  }

  let token = context.globalState.get<string>('serverToken');
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    void context.globalState.update('serverToken', token);
  }
  return token;
}

export function getConfig(context: vscode.ExtensionContext): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceCwd = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

  // Permite tener un .env con API_URL / API_KEY (en el workspace o en la carpeta de la extension).
  try {
    // dotenv no sobreescribe variables ya existentes en process.env.
    require('dotenv').config({ path: path.join(workspaceCwd, '.env') });
    require('dotenv').config({
      path: path.join(context.extensionPath, '.env'),
      override: false,
    });
  } catch {
    // dotenv es opcional en tiempo de ejecucion.
  }

  const apiUrl = env('API_URL') ?? cfg.get<string>('apiUrl', '').trim();
  const apiKey = env('API_KEY') ?? cfg.get<string>('apiKey', '').trim();
  const apiModel = env('API_MODEL') ?? cfg.get<string>('apiModel', '').trim();

  const typing = cfg.get('typing', {}) as Partial<ExtensionConfig['typing']>;
  let minDelayMs = Number(typing.minDelayMs ?? 25);
  let maxDelayMs = Number(typing.maxDelayMs ?? 75);
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) {
    minDelayMs = 25;
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < minDelayMs) {
    maxDelayMs = Math.max(minDelayMs, 75);
  }

  return {
    apiUrl,
    apiKey,
    apiModel,
    httpPort: clamp(Number(cfg.get<number>('httpPort', 45678)) || 45678, 1, 65535),
    serverToken: resolveServerToken(context),
    systemPrompt: cfg.get<string>('systemPrompt', '').trim() || DEFAULT_SYSTEM_PROMPT,
    tlsRejectUnauthorized: cfg.get<boolean>('tlsRejectUnauthorized', true),
    requestTimeoutMs: clamp(Number(cfg.get<number>('requestTimeoutMs', 120000)) || 120000, 5000, 600000),
    discreet: cfg.get<boolean>('discreet', true),
    targetFile: cfg.get<string>('targetFile', '').trim(),
    typing: {
      minDelayMs,
      maxDelayMs,
      maxChunkSize: clamp(Number(typing.maxChunkSize ?? 3) || 3, 1, 10),
      undoEvery: clamp(Number(typing.undoEvery ?? 1) || 1, 1, 50),
      pauseAtNewlineMs: Math.max(0, Number(typing.pauseAtNewlineMs ?? 180) || 0),
      clearEditorBeforeTyping: Boolean(typing.clearEditorBeforeTyping ?? false),
      saveAfterTyping: Boolean(typing.saveAfterTyping ?? false),
    },
  };
}
