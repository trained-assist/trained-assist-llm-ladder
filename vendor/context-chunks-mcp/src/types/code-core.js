import { compressJavaScript } from './javascript.js';
import { compressPython } from './python.js';
import { compressGo } from './go.js';
import { compressCSV } from './csv.js';
import { compressJSON } from './json.js';

const EXTENSION_MAP = {
  '.js': compressJavaScript,
  '.mjs': compressJavaScript,
  '.ts': compressJavaScript,
  '.jsx': compressJavaScript,
  '.tsx': compressJavaScript,
  '.py': compressPython,
  '.go': compressGo,
  '.csv': compressCSV,
  '.json': compressJSON,
};

export function compressCode(filePath, source, maxChunkSize = 100000) {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
  const compressor = EXTENSION_MAP[ext] || compressJavaScript;
  return compressor(filePath, source, maxChunkSize);
}

