# C# Human Typer

Extension de VS Code que recibe una instruccion desde la terminal integrada, consulta tu API y **teclea** el codigo C# resultante letra a letra, dejando cada paso en el historial.


## Como funciona

```
terminal  ──POST /typing──▶  servidor local (127.0.0.1:45678)
                                     │
                                     ▼
                          apiClient.ts  ──POST API_URL──▶  tu API
                                     │
                                     ▼
                          sanitizer.ts  (quita markdown y comentarios)
                                     │
                                     ▼
                          humanTyper.ts  editor.edit(..., {undoStopBefore: true, undoStopAfter: true})
```

## Instalacion

```powershell
cd csharp-human-typer
npm install
npm run compile
```

**Para probar:** abre la carpeta en VS Code y pulsa `F5` (configuracion "Ejecutar extension").

**Para instalar en tu VS Code normal** (cualquiera de las dos opciones):

```powershell
# Opcion A: empaquetar un .vsix
npm install -g @vscode/vsce
npm run package            # crea csharp-human-typer-1.0.0.vsix
code --install-extension csharp-human-typer-1.0.0.vsix

# Opcion B: copiar la carpeta (hay que compilar antes)
Copy-Item -Recurse -Force . "$env:USERPROFILE\.vscode\extensions\local.csharp-human-typer-1.0.0"
```

## Configuracion

| Setting / variable | Descripcion |
|---|---|
| `API_URL` / `csharpHumanTyper.apiUrl` | Endpoint POST de tu API |
| `API_KEY` / `csharpHumanTyper.apiKey` | Se envia como `Authorization: Bearer ...` y `x-api-key` |
| `API_MODEL` / `csharpHumanTyper.apiModel` | Modelo opcional en el cuerpo JSON |
| `csharpHumanTyper.httpPort` | Puerto del servidor local (por defecto `45678`) |
| `csharpHumanTyper.typing.minDelayMs` / `maxDelayMs` | Retardo aleatorio por fragmento (`25` / `75`) |
| `csharpHumanTyper.typing.maxChunkSize` | Caracteres por fragmento (`3`) |
| `csharpHumanTyper.typing.undoEvery` | Una parada de Undo cada N fragmentos (`1` = cada uno) |
| `csharpHumanTyper.typing.pauseAtNewlineMs` | Pausa extra tras un salto de linea (`180`) |
| `csharpHumanTyper.typing.clearEditorBeforeTyping` | Vaciar el editor antes de escribir (`false`) |
| `csharpHumanTyper.systemPrompt` | Sobreescribe el System Prompt (opcional) |

Las variables de entorno tienen prioridad sobre los settings. Tambien se lee un archivo `.env`
(en la raiz del workspace y en la carpeta de la extension); usa `.env.example` como plantilla.

El System Prompt por defecto es:

> Genera unicamente codigo en C# que funcione como la estructura o introduccion del programa solicitado. PROHIBIDO incluir bloques markdown (\`\`\`csharp), explicaciones en texto, ni ningun tipo de comentario en el codigo (ni // ni /\* \*/). Devuelve exclusivamente codigo C# puro listo para compilar.

El cuerpo del POST incluye `instruction`, `prompt`, `system`, `systemPrompt`, `messages` (system + user)
y `model`. Se aceptan como respuesta texto plano, `{code}`, `{content}`, `{result}`, `{message}`,
OpenAI (`choices[0].message.content`) y Anthropic (`content: [{text}]`).

## Uso desde la terminal

Dos formas equivalentes:

1. **Perfil de terminal integrada**: `Terminal > New Terminal` y elige `C# Human Typer (escribir)`, o
   ejecuta `C# Human Typer: Abrir terminal 'escribir'`. Sintaxis:

   ```
   > escribir "crea la estructura de una clase Persona con nombre y edad"
   > detener
   > estado
   ```

2. **Script `escribir`** desde cualquier terminal (PowerShell, cmd, bash):

   ```powershell
   # PowerShell: usa el .cmd del proyecto
   .\bin\escribir.cmd "crea una clase Empleado"

   # Para tenerlo solo con `escribir`, anade esa carpeta al PATH:
   [Environment]::SetEnvironmentVariable('Path', $env:Path + ";C:\ruta\a\csharp-human-typer\bin", 'User')
   ```

   Solo necesitas el token si has fijado `HUMAN_TYPER_TOKEN` en VS Code; si no, el script lo lee
   automaticamente de `globalStorage/local.csharp-human-typer/server.json`.

El script y el servidor usan un token local (`X-Human-Typer-Token`) para que solo tu maquina pueda
enviar instrucciones. Puedes verlo con `C# Human Typer: Mostrar URL/Token del servidor local`.

## Undo real (Ctrl + Z)

Cada llamada a `editor.edit` se hace con `undoStopBefore: true` y `undoStopAfter: true` al cerrar cada
ventana de Undo, de modo que el historial guarda paradas independientes. El texto se envía en fragmentos
de 1-3 caracteres con retardos aleatorios de 25-75 ms y el cursor se mueve + `revealRange` en cada paso,
igual que al teclear. Con `undoEvery = 1`, `Ctrl+Z` retrocede caracter a caracter; con `undoEvery = 4`,
palabra a palabra. El test automatizado comprueba que se generan decenas de pasos de Undo.

## Notas

- El texto se escribe **en la posicion del cursor** del editor activo (util para continuar dentro de una clase).
- Si el formateo al escribir del lenguaje mueve el cursor, la extension sigue al editor para no perder texto.
- La limpieza quita bloques markdown y comentarios `//` y `/* */` **sin tocar strings** (incluidos `@"..."`,
  `$"..."` y raw strings `"""..."""`).
- `CSHARP_HUMAN_TYPER_AUTOTEST=<ruta.json>` ejecuta una prueba automatica de tecleo + Undo al activar la
  extension (usado para validar en el Extension Host).
