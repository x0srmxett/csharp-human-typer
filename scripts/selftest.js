const Module = require('module');

// Stub del modulo "vscode" para probar logica fuera del Extension Host.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { window: { activeTextEditor: undefined } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { sanitizeCSharp, stripComments } = require('../out/sanitizer');
const { splitIntoKeystrokes } = require('../out/humanTyper');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n  got:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// --- sanitizer --------------------------------------------------------------
const apiResponse = '```csharp\n// comentario inicial\nusing System;\n\n/** bloque\ndoc */\nclass Program\n{\n    static void Main()\n    {\n        var url = "http://x/y"; // trailing\n        var c = \'/\';\n        Console.WriteLine($"{url} /* no */");\n    }\n}\n```';
check(
  'markdown + comentarios',
  sanitizeCSharp(apiResponse),
  'using System;\n\nclass Program\n{\n    static void Main()\n    {\n        var url = "http://x/y";\n        var c = \'/\';\n        Console.WriteLine($"{url} /* no */");\n    }\n}'
);

check(
  'verbatim y raw strings (se conservan literalmente)',
  stripComments('var a = @"C:\\temp\\ //x";\nvar b = """\n// no\n""";\nvar d = 1; // si').trimEnd(),
  'var a = @"C:\\temp\\ //x";\nvar b = """\n// no\n""";\nvar d = 1;'
);
check(
  'bloque en linea + // fuera de strings',
  stripComments('/* c */ int x = 1; /* d */ int y = 2; // fin').replace(/\s+/g, ' ').trim(),
  'int x = 1; int y = 2;'
);

check('texto sin markdown', stripComments('class A {}'), 'class A {}');

// --- keystrokes -------------------------------------------------------------
const text = '    public class Persona\n    {\n    }';
const strokes = splitIntoKeystrokes(text);
check('reconstruye el texto', strokes.join(''), text);
console.log('     pulsaciones:', JSON.stringify(strokes));
check('sin pulsaciones vacias', strokes.filter((s) => s.length === 0).length, 0);
check('ninguna pulsacion > 8 chars', Math.max(...strokes.map((s) => s.length)) <= 8, true);
check('la indentacion va con la primera palabra', strokes[0].startsWith('    ') && !strokes[0].includes('\n'), true);

// --- servidor ---------------------------------------------------------------
const { InstructionServer } = require('../out/server');
(async () => {
  const received = [];
  const server = new InstructionServer({
    port: 0,
    token: 'test-token',
    onInstruction: async (i) => received.push(i),
    getStatus: () => ({ typing: false }),
    onStop: () => received.push('STOP'),
  });
  const port = await server.start();

  const bad = await fetch(`http://127.0.0.1:${port}/typing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: 'x' }),
  });
  check('rechaza sin token', bad.status, 401);

  const good = await fetch(`http://127.0.0.1:${port}/typing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Human-Typer-Token': 'test-token' },
    body: JSON.stringify({ instruction: 'hola' }),
  });
  check('acepta con token', good.status, 202);

  await new Promise((r) => setTimeout(r, 50));
  check('recibe la instruccion', received, ['hola']);

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  check('health ok', health.ok, true);

  await server.stop();
  console.log(failures === 0 ? '\nTODAS LAS PRUEBAS PASARON' : `\n${failures} PRUEBAS FALLARON`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
