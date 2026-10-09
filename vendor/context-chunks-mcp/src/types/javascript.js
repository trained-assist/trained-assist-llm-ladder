export function compressJavaScript(filePath, source) {
  const lines = source.split('\n');
  const imports = [];
  const functions = [];
  const classes = [];
  const constants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('import ') || trimmed.startsWith('export {') || trimmed.startsWith('require(')) {
      imports.push(trimmed);
    }

    const funcMatch = trimmed.match(
      /^(?:export\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/
    );
    if (funcMatch && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
      const [, name, params, returnType] = funcMatch;
      if (!['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) {
        functions.push({
          name,
          params: params.trim(),
          returnType: returnType?.trim() || null,
          line: i + 1,
        });
      }
    }

    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
    if (arrowMatch) {
      functions.push({
        name: arrowMatch[1],
        params: arrowMatch[2].trim(),
        returnType: null,
        line: i + 1,
        type: 'arrow',
      });
    }

    const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
    if (classMatch) {
      classes.push({
        name: classMatch[1],
        extends: classMatch[2] || null,
        line: i + 1,
      });
    }

    const constMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/);
    if (constMatch) {
      constants.push({
        name: constMatch[1],
        line: i + 1,
      });
    }
  }

  const ref = JSON.stringify({ type: 'file', path: filePath, lines: [1, lines.length] });

  const sections = [
    imports.length > 0 && `Imports: ${imports.join(', ')}`,
    functions.length > 0 && `Functions: ${functions.map(f => `${f.name}(${f.params})${f.returnType ? ': ' + f.returnType : ''}`).join(', ')}`,
    classes.length > 0 && `Classes: ${classes.map(c => c.name + (c.extends ? ' extends ' + c.extends : '')).join(', ')}`,
    constants.length > 0 && `Constants: ${constants.map(c => c.name).join(', ')}`,
    `Lines: ${lines.length}`,
  ].filter(Boolean);

  const compressed = `[COMPRESSED:file:${filePath}]
${sections.join('\n')}
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
