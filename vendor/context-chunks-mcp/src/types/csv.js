export function compressCSV(filePath, content) {
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    return null;
  }

  const headers = lines[0].split(',').map(h => h.trim());
  const dataLines = lines.slice(1);

  const columnStats = headers.map((header, colIdx) => {
    const values = dataLines.map(line => {
      const cells = line.split(',');
      return cells[colIdx]?.trim() || '';
    });

    const unique = [...new Set(values)];
    return {
      header,
      uniqueCount: unique.length,
      sampleValues: unique.slice(0, 5),
    };
  });

  const ref = JSON.stringify({ type: 'csv' });

  const compressed = `[COMPRESSED:csv]
Rows: ${dataLines.length}
Columns: ${headers.length}
${headers.map((h, i) => `  ${h}: ${columnStats[i]?.uniqueCount || '?'} unique`).join('\n')}

Sample rows:
${dataLines.slice(0, 5).map((line, i) => `  Row${i}: ${line.substring(0, 80)}`).join('\n')}
[/COMPRESSED]
→ get_context: ${ref}`;

  return {
    compressed,
    ref,
    stats: {
      originalChars: content.length,
      compressedChars: compressed.length,
      ratio: (compressed.length / content.length * 100).toFixed(1),
      rows: dataLines.length,
      columns: headers.length,
    },
  };
}
