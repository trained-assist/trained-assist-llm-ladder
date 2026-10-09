export function compressPython(filePath, source) {
  const lines = source.split('\n');
  const imports = [];
  const functions = [];
  const classes = [];
  const constants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      imports.push(trimmed);
    }

    const funcMatch = trimmed.match(/^(\s*)def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/);
    if (funcMatch) {
      const [, indent, name, params, returnType] = funcMatch;
      functions.push({
        name,
        params: params.trim(),
        returnType: returnType?.trim() || null,
        line: i + 1,
        method: indent.length > 0,
      });
    }

    const asyncFuncMatch = trimmed.match(/^(\s*)async\s+def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/);
    if (asyncFuncMatch) {
      const [, indent, name, params, returnType] = asyncFuncMatch;
      functions.push({
        name,
        params: params.trim(),
        returnType: returnType?.trim() || null,
        line: i + 1,
        method: indent.length > 0,
        async: true,
      });
    }

    const classMatch = trimmed.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
    if (classMatch) {
      classes.push({
        name: classMatch[1],
        extends: classMatch[2] || null,
        line: i + 1,
      });
    }

    const constMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (constMatch) {
      constants.push({
        name: constMatch[1],
        line: i + 1,
      });
    }
  }

  const ref = JSON.stringify({ type: 'file', path: filePath, lines: [1, lines.length] });

  const compressed = `[COMPRESSED:file:${filePath}]
Imports: ${imports.length > 0 ? imports.join(', ') : 'none'}
Functions: ${functions.length > 0 ? functions.map(f => `${f.name}(${f.params})${f.returnType ? ' -> ' + f.returnType : ''}`).join(', ') : 'none'}
Classes: ${classes.length > 0 ? classes.map(c => c.name + (c.extends ? '(' + c.extends + ')' : '')).join(', ') : 'none'}
Constants: ${constants.length > 0 ? constants.map(c => c.name).join(', ') : 'none'}
Lines: ${lines.length}
[/COMPRESSED]
→ get_context: ${ref}`;

  return {
    compressed,
    ref,
    stats: {
      originalChars: source.length,
      compressedChars: compressed.length,
      ratio: (compressed.length / source.length * 100).toFixed(1),
      functions: functions.length,
      classes: classes.length,
      imports: imports.length,
    },
  };
}
