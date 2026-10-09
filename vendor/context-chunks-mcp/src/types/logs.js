export function compressLogs(logContent) {
  const lines = logContent.split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    return {
      compressed: '[COMPRESSED:log]\nEmpty\n[/COMPRESSED]',
      ref: JSON.stringify({ type: 'log', empty: true }),
      stats: { originalChars: 0, compressedChars: 30, ratio: '0', totalLines: 0, granules: 0 },
    };
  }

  const patternCounts = {};
  const levelCounts = {};
  let minTime = null;
  let maxTime = null;
  let errorLines = [];
  const timeRanges = [];

  for (const line of lines) {
    const match = line.match(/\[(.*?)\]\s+(\w+):\s*(.*)/);
    if (!match) continue;

    const [, time, level, message] = match;
    const key = `${level}: ${message.substring(0, 100)}`;

    patternCounts[key] = (patternCounts[key] || 0) + 1;
    levelCounts[level] = (levelCounts[level] || 0) + 1;

    if (!minTime || time < minTime) minTime = time;
    if (!maxTime || time > maxTime) maxTime = time;

    if (level === 'ERROR' || level === 'WARN') {
      errorLines.push(line);
    }
  }

  const errorPatterns = Object.entries(patternCounts)
    .filter(([k]) => k.startsWith('ERROR') || k.startsWith('WARN'))
    .sort((a, b) => b[1] - a[1]);

  const topPatterns = Object.entries(patternCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const ref = JSON.stringify({ type: 'log', from: minTime, to: maxTime });

  const compressed = `[COMPRESSED:log]
Lines: ${lines.length}
Time range: ${minTime} → ${maxTime}

Levels: ${Object.entries(levelCounts).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}×${c}`).join(', ')}

Top patterns:
${topPatterns.map(([p, c]) => `  ${p} ×${c}`).join('\n')}

Error/Warning patterns:
${errorPatterns.map(([p, c]) => `  ${p} ×${c}`).join('\n')}

Error samples (${errorLines.length} lines, first 10):
${errorLines.slice(0, 10).map(l => `  ${l.substring(0, 120)}`).join('\n')}
[/COMPRESSED]
→ get_context: ${ref}`;

  return {
    compressed,
    ref,
    stats: {
      originalChars: logContent.length,
      compressedChars: compressed.length,
      ratio: (compressed.length / logContent.length * 100).toFixed(1),
      totalLines: lines.length,
      granules: 1,
    },
  };
}
