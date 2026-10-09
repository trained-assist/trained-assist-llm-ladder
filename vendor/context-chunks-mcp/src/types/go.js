export function compressGo(filePath, source) {
  const lines = source.split('\n');
  const imports = [];
  const functions = [];
  const types = [];
  const constants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('import ') || (trimmed.startsWith('"') && lines[i - 1]?.trim() === 'import')) {
      imports.push(trimmed);
    }

    const funcMatch = trimmed.match(/^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|([^{]+))?/);
    if (funcMatch) {
      const [, receiver, receiverType, name, params, multiReturn, singleReturn] = funcMatch;
      functions.push({
        name,
        params: params.trim(),
        returnType: (multiReturn || singleReturn || '').trim() || null,
        receiver: receiver ? `${receiver} ${receiverType}` : null,
        line: i + 1,
      });
    }

    const typeMatch = trimmed.match(/^type\s+(\w+)\s+(?:struct|interface)/);
    if (typeMatch) {
      types.push({
        name: typeMatch[1],
        line: i + 1,
      });
    }

    const constMatch = trimmed.match(/^const\s+([A-Z_][A-Z0-9_]*)\s*=/);
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
Functions: ${functions.length > 0 ? functions.map(f => `${f.name}(${f.params})${f.returnType ? ': ' + f.returnType : ''}`).join(', ') : 'none'}
Types: ${types.length > 0 ? types.map(t => t.name).join(', ') : 'none'}
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
      types: types.length,
      imports: imports.length,
    },
  };
}
