export function compressJSON(filePath, source, maxTokens = null, targetRatio = 0.15, tokenizer = 'gpt-4') {
  let obj;
  try {
    obj = JSON.parse(source);
  } catch {
    return null;
  }

  const lines = [];
  const refs = new Map();
  let tokenCount = 0;
  const tokenBudget = maxTokens || Math.floor(estimateTokens(source, tokenizer) * targetRatio);
  const reservedTokens = 500;
  const usableBudget = tokenBudget - reservedTokens;

  const context = {
    obj,
    filePath,
    lines,
    refs,
    tokenCount: 0,
    tokenBudget: usableBudget,
    tokenizer,
    sourceTokens: estimateTokens(source, tokenizer),
  };

  buildOverview(context);
  addPathsDetail(context);
  addSchemasDetail(context);
  addResponsesDetail(context);
  addParametersDetail(context);
  addExamplesDetail(context);

  const content = lines.join('\n');
  const finalTokens = estimateTokens(content, tokenizer);
  
  const ref = JSON.stringify({ 
    type: 'json', 
    path: filePath, 
    version: hashSource(source),
    tokenizer 
  });

  const output = `[GETCONTEXT:v1]
source: ${filePath}
sourceTokens: ${context.sourceTokens}
outputTokens: ${finalTokens}
ratio: ${(finalTokens / context.sourceTokens * 100).toFixed(1)}%
budget: ${tokenBudget}
indexVersion: 1
tokenizer: ${tokenizer}

${content}

REFS (${context.refs.size}):
${Array.from(context.refs.entries()).map(([k, v]) => `  @${k}: ${v.path} (${formatSize(v.size)})`).join('\n')}

[/GETCONTEXT]
→ expandContext: ${ref}`;

  console.log(`[getContext] ${filePath}: ${context.sourceTokens} → ${finalTokens} tokens (${(finalTokens / context.sourceTokens * 100).toFixed(1)}%)`);

  return {
    compressed: output,
    ref,
    stats: {
      originalTokens: context.sourceTokens,
      outputTokens: finalTokens,
      ratio: (finalTokens / context.sourceTokens * 100).toFixed(1),
      refs: context.refs.size,
      lines: context.lines.length,
    },
  };
}

function buildOverview(ctx) {
  const { obj, lines, refs, tokenCount, tokenBudget, tokenizer } = ctx;
  if (!obj || typeof obj !== 'object') return;

  if (obj.info) {
    addLine(ctx, `API: ${obj.info.title || 'unknown'} v${obj.info.version || '0.0.0'}`);
    if (obj.info.description) {
      addLine(ctx, `  ${obj.info.description.substring(0, 200)}`);
    }
  }

  if (obj.servers && Array.isArray(obj.servers)) {
    addLine(ctx, `Servers: ${obj.servers.length}`);
    for (const s of obj.servers) {
      addLine(ctx, `  ${s.url || '?'} ${s.description ? '- ' + s.description.substring(0, 80) : ''}`);
    }
  }

  if (obj.paths && typeof obj.paths === 'object') {
    const paths = obj.paths;
    const pathKeys = Object.keys(paths);
    
    const tagCounts = {};
    let totalEndpoints = 0;
    
    for (const [path, methods] of Object.entries(paths)) {
      if (typeof methods === 'object') {
        for (const [method, spec] of Object.entries(methods)) {
          if (typeof spec === 'object') {
            if (spec.tags) {
              for (const tag of spec.tags) {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
              }
            }
            totalEndpoints++;
          }
        }
      }
    }
    
    addLine(ctx, `Paths: ${pathKeys.length} paths, ${totalEndpoints} endpoints`);
    addLine(ctx, `Endpoints by tag: ${Object.entries(tagCounts).sort((a,b) => b[1] - a[1]).map(([t,c]) => `${t}=${c}`).join(', ')}`);
    
    const pathsSize = estimateSize(paths);
    refs.set('paths', { path: 'paths', size: pathsSize });
    addLine(ctx, `  → paths (${formatSize(pathsSize)}) @ref:paths`);
  }

  if (obj.components && typeof obj.components === 'object') {
    const comp = obj.components;
    const compKeys = Object.keys(comp);
    
    let totalSchemas = 0;
    if (comp.schemas && typeof comp.schemas === 'object') {
      totalSchemas = Object.keys(comp.schemas).length;
    }
    
    addLine(ctx, `Components: ${compKeys.join(', ')} (${totalSchemas} schemas)`);
    
    const compSize = estimateSize(comp);
    refs.set('components', { path: 'components', size: compSize });
    addLine(ctx, `  → components (${formatSize(compSize)}) @ref:components`);
    
    if (comp.schemas) {
      const schemasSize = estimateSize(comp.schemas);
      refs.set('components.schemas', { path: 'components.schemas', size: schemasSize });
      addLine(ctx, `  → components.schemas (${formatSize(schemasSize)}) @ref:schemas`);
    }
    
    if (comp.responses && typeof comp.responses === 'object') {
      const respNames = Object.keys(comp.responses);
      addLine(ctx, `Shared responses: ${respNames.length} (${respNames.slice(0, 10).join(', ')}${respNames.length > 10 ? '...' : ''})`);
      const respSize = estimateSize(comp.responses);
      refs.set('components.responses', { path: 'components.responses', size: respSize });
      addLine(ctx, `  → responses (${formatSize(respSize)}) @ref:responses`);
    }
    
    if (comp.parameters && typeof comp.parameters === 'object') {
      const paramNames = Object.keys(comp.parameters);
      addLine(ctx, `Shared parameters: ${paramNames.length} (${paramNames.slice(0, 10).join(', ')}${paramNames.length > 10 ? '...' : ''})`);
      const paramSize = estimateSize(comp.parameters);
      refs.set('components.parameters', { path: 'components.parameters', size: paramSize });
      addLine(ctx, `  → parameters (${formatSize(paramSize)}) @ref:parameters`);
    }
    
    if (comp.securitySchemes) {
      const secNames = Object.keys(comp.securitySchemes);
      addLine(ctx, `Security schemes: ${secNames.join(', ')}`);
      for (const name of secNames) {
        const scheme = comp.securitySchemes[name];
        addLine(ctx, `  ${name}: ${scheme.type} ${scheme.scheme ? `(${scheme.scheme})` : ''} ${scheme.bearerFormat ? `Bearer: ${scheme.bearerFormat}` : ''}`);
      }
    }
    
    if (comp.examples && typeof comp.examples === 'object') {
      addLine(ctx, `Examples: ${Object.keys(comp.examples).length}`);
    }
    
    if (comp.headers && typeof comp.headers === 'object') {
      addLine(ctx, `Shared headers: ${Object.keys(comp.headers).length}`);
    }
    
    if (comp.pathItems && typeof comp.pathItems === 'object') {
      addLine(ctx, `Shared path items: ${Object.keys(comp.pathItems).length}`);
    }
    
    if (comp.callbacks && typeof comp.callbacks === 'object') {
      addLine(ctx, `Callbacks: ${Object.keys(comp.callbacks).length}`);
    }
    
    if (comp.links && typeof comp.links === 'object') {
      addLine(ctx, `Links: ${Object.keys(comp.links).length}`);
    }
  }

  if (obj.tags && Array.isArray(obj.tags)) {
    addLine(ctx, `Tags: ${obj.tags.map(t => t.name).join(', ')}`);
  }

  if (obj.security && Array.isArray(obj.security)) {
    addLine(ctx, `Global security: ${obj.security.length} requirements`);
    for (const sec of obj.security) {
      addLine(ctx, `  ${Object.keys(sec).join(', ')}`);
    }
  }

  if (obj.externalDocs) {
    addLine(ctx, `External docs: ${obj.externalDocs.url}`);
  }
}

function addPathsDetail(ctx) {
  const { obj, lines, refs, tokenBudget, tokenCount, tokenizer } = ctx;
  if (!obj.paths) return;

  addLine(ctx, '');
  addLine(ctx, 'Paths:');
  
  const paths = Object.entries(obj.paths || {});
  const CHUNK_SIZE_KB = 15;
  
  const pathInfos = paths.map(([path, methods]) => {
    const methodList = Object.keys(methods)
      .filter(m => typeof methods[m] === 'object')
      .map(m => m.toUpperCase())
      .join(',');
    
    const tags = new Set();
    for (const spec of Object.values(methods)) {
      if (typeof spec === 'object' && spec.tags) {
        for (const tag of spec.tags) tags.add(tag);
      }
    }
    
    const opId = Object.values(methods).find(m => typeof m === 'object' && m.operationId)?.operationId || '';
    const specSize = JSON.stringify(methods).length / 1024;
    
    return { path, methodList, tags: Array.from(tags), opId, size: specSize, methods };
  });
  
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  
  for (const info of pathInfos) {
    if (currentSize + info.size > CHUNK_SIZE_KB && currentChunk.length > 0) {
      chunks.push({ items: currentChunk, size: currentSize });
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(info);
    currentSize += info.size;
  }
  if (currentChunk.length > 0) {
    chunks.push({ items: currentChunk, size: currentSize });
  }
  
  addLine(ctx, `  Total: ${paths.length} paths in ${chunks.length} chunks (~${CHUNK_SIZE_KB}KB each):`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const preview = chunk.items.slice(0, 3).map(p => `${p.methodList} ${p.path} [${p.tags.join(',')}]`).join('; ') + (chunk.items.length > 3 ? ` ... +${chunk.items.length - 3}` : '');
    const refKey = `paths.chunk${i}`;
    refs.set(refKey, { path: `paths[${chunk.items.map(p => p.path).join(',')}]`, size: Math.round(chunk.size * 1024) });
    
    let detail = `    ${i}: ${preview} (${chunk.size.toFixed(1)}KB) @ref:${refKey}`;
    if (!addLine(ctx, detail)) break;
    
    // Show ALL paths in chunk with details
    for (let j = 0; j < chunk.items.length; j++) {
      const p = chunk.items[j];
      for (const [method, spec] of Object.entries(p.methods)) {
        if (typeof spec !== 'object') continue;
        const summary = spec.summary ? spec.summary.substring(0, 120) : '';
        const params = spec.parameters ? spec.parameters.length : 0;
        const paramLine = `      ${method.toUpperCase()} ${p.path}: ${summary}${summary ? ' | ' : ''}${params} params`;
        if (!addLine(ctx, paramLine)) break;
        
        // Request body
        if (spec.requestBody) {
          const rb = spec.requestBody;
          const content = rb.content ? Object.keys(rb.content).join(', ') : '';
          const rbLine = `        requestBody: ${content}${rb.required ? ' (required)' : ''}`;
          if (!addLine(ctx, rbLine)) break;
        }
        // Responses
        if (spec.responses) {
          const respCodes = Object.keys(spec.responses).slice(0, 5);
          const respLine = `        responses: ${respCodes.join(', ')}${Object.keys(spec.responses).length > 5 ? '...' : ''}`;
          if (!addLine(ctx, respLine)) break;
        }
      }
    }
  }
}

function addSchemasDetail(ctx) {
  const { obj, lines, refs, tokenBudget, tokenCount, tokenizer } = ctx;
  if (!obj.components?.schemas) return;

  addLine(ctx, '');
  addLine(ctx, 'Schemas:');
  
  const schemas = obj.components.schemas;
  const names = Object.keys(schemas);
  
  const types = { request: 0, response: 0, error: 0, other: 0 };
  for (const name of names) {
    if (name.includes('Request') || name.includes('Input')) types.request++;
    else if (name.includes('Response') || name.includes('Output')) types.response++;
    else if (name.includes('Error')) types.error++;
    else types.other++;
  }
  
  addLine(ctx, `  Total: ${names.length} schemas`);
  addLine(ctx, `  Types: ${Object.entries(types).filter(([,v]) => v > 0).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  
  // Group schemas into chunks of ~10KB each
  const CHUNK_SIZE_KB = 10;
  const schemaSizes = names.map(name => {
    const size = JSON.stringify(schemas[name]).length / 1024;
    return { name, size };
  });
  
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  
  for (const { name, size } of schemaSizes) {
    if (currentSize + size > CHUNK_SIZE_KB && currentChunk.length > 0) {
      chunks.push({ names: currentChunk, size: currentSize });
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(name);
    currentSize += size;
  }
  if (currentChunk.length > 0) {
    chunks.push({ names: currentChunk, size: currentSize });
  }
  
  addLine(ctx, `  Chunks (${chunks.length}, ~${CHUNK_SIZE_KB}KB each):`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const preview = chunk.names.slice(0, 5).join(', ') + (chunk.names.length > 5 ? ` ... +${chunk.names.length - 5}` : '');
    const refKey = `schemas.chunk${i}`;
    refs.set(refKey, { path: `components.schemas[${chunk.names.join(',')}]`, size: Math.round(chunk.size * 1024) });
    
    // For first 3 schemas in each chunk, show their properties inline
    let detail = `    ${i}: ${preview} (${chunk.size.toFixed(1)}KB) @ref:${refKey}`;
    if (!addLine(ctx, detail)) break;
    
    // Show properties of ALL schemas in chunk (up to budget)
    for (let j = 0; j < chunk.names.length; j++) {
      const schemaName = chunk.names[j];
      const schema = schemas[schemaName];
      if (schema?.properties && typeof schema.properties === 'object') {
        const propNames = Object.keys(schema.properties).slice(0, 20);
        const propLine = `      ${schemaName}: ${propNames.join(', ')}${Object.keys(schema.properties).length > 20 ? '...' : ''}`;
        if (!addLine(ctx, propLine)) break;
      }
      if (schema?.required && Array.isArray(schema.required)) {
        const reqLine = `        required: ${schema.required.join(', ')}`;
        if (!addLine(ctx, reqLine)) break;
      }
      if (schema?.type) {
        const typeLine = `        type: ${schema.type}`;
        if (!addLine(ctx, typeLine)) break;
      }
    }
  }
}

function addLine(ctx, text) {
  const tokens = estimateTokens(text + '\n', ctx.tokenizer);
  if (ctx.tokenCount + tokens > ctx.tokenBudget) {
    ctx.lines.push('... [budget exceeded]');
    return false;
  }
  ctx.lines.push(text);
  ctx.tokenCount += tokens;
  return true;
}

function addExamplesDetail(ctx) {
  const { obj, lines, refs, tokenBudget, tokenCount, tokenizer } = ctx;
  if (!obj.components?.examples) return;

  addLine(ctx, '');
  addLine(ctx, 'Examples:');
  
  const examples = obj.components.examples;
  const names = Object.keys(examples);
  
  const CHUNK_SIZE_KB = 10;
  const exampleSizes = names.map(name => {
    const size = JSON.stringify(examples[name]).length / 1024;
    return { name, size };
  });
  
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  
  for (const { name, size } of exampleSizes) {
    if (currentSize + size > CHUNK_SIZE_KB && currentChunk.length > 0) {
      chunks.push({ names: currentChunk, size: currentSize });
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(name);
    currentSize += size;
  }
  if (currentChunk.length > 0) {
    chunks.push({ names: currentChunk, size: currentSize });
  }
  
  addLine(ctx, `  Total: ${names.length} examples in ${chunks.length} chunks (~${CHUNK_SIZE_KB}KB each):`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const preview = chunk.names.slice(0, 5).join(', ') + (chunk.names.length > 5 ? ` ... +${chunk.names.length - 5}` : '');
    const refKey = `examples.chunk${i}`;
    refs.set(refKey, { path: `components.examples[${chunk.names.join(',')}]`, size: Math.round(chunk.size * 1024) });
    if (!addLine(ctx, `    ${i}: ${preview} (${chunk.size.toFixed(1)}KB) @ref:${refKey}`)) break;
  }
}

function addResponsesDetail(ctx) {
  const { obj, lines, refs, tokenBudget, tokenCount, tokenizer } = ctx;
  if (!obj.components?.responses) return;

  addLine(ctx, '');
  addLine(ctx, 'Shared Responses:');
  
  const responses = obj.components.responses;
  const names = Object.keys(responses);
  
  const CHUNK_SIZE_KB = 10;
  const respSizes = names.map(name => {
    const size = JSON.stringify(responses[name]).length / 1024;
    return { name, size };
  });
  
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  
  for (const { name, size } of respSizes) {
    if (currentSize + size > CHUNK_SIZE_KB && currentChunk.length > 0) {
      chunks.push({ names: currentChunk, size: currentSize });
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(name);
    currentSize += size;
  }
  if (currentChunk.length > 0) {
    chunks.push({ names: currentChunk, size: currentSize });
  }
  
  addLine(ctx, `  Total: ${names.length} responses in ${chunks.length} chunks (~${CHUNK_SIZE_KB}KB each):`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const preview = chunk.names.slice(0, 5).join(', ') + (chunk.names.length > 5 ? ` ... +${chunk.names.length - 5}` : '');
    const refKey = `responses.chunk${i}`;
    refs.set(refKey, { path: `components.responses[${chunk.names.join(',')}]`, size: Math.round(chunk.size * 1024) });
    if (!addLine(ctx, `    ${i}: ${preview} (${chunk.size.toFixed(1)}KB) @ref:${refKey}`)) break;
    
    // Show response details for first 2 in chunk
    for (let j = 0; j < Math.min(2, chunk.names.length); j++) {
      const respName = chunk.names[j];
      const resp = responses[respName];
      if (resp?.description) {
        if (!addLine(ctx, `      ${respName}: ${resp.description.substring(0, 120)}`)) break;
      }
      if (resp?.content) {
        const contentTypes = Object.keys(resp.content);
        if (!addLine(ctx, `        content: ${contentTypes.join(', ')}`)) break;
      }
      if (resp?.headers) {
        const headerNames = Object.keys(resp.headers).slice(0, 10);
        if (!addLine(ctx, `        headers: ${headerNames.join(', ')}${Object.keys(resp.headers).length > 10 ? '...' : ''}`)) break;
      }
    }
  }
}

function addParametersDetail(ctx) {
  const { obj, lines, refs, tokenBudget, tokenCount, tokenizer } = ctx;
  if (!obj.components?.parameters) return;

  addLine(ctx, '');
  addLine(ctx, 'Shared Parameters:');
  
  const parameters = obj.components.parameters;
  const names = Object.keys(parameters);
  
  const CHUNK_SIZE_KB = 10;
  const paramSizes = names.map(name => {
    const size = JSON.stringify(parameters[name]).length / 1024;
    return { name, size };
  });
  
  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  
  for (const { name, size } of paramSizes) {
    if (currentSize + size > CHUNK_SIZE_KB && currentChunk.length > 0) {
      chunks.push({ names: currentChunk, size: currentSize });
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(name);
    currentSize += size;
  }
  if (currentChunk.length > 0) {
    chunks.push({ names: currentChunk, size: currentSize });
  }
  
  addLine(ctx, `  Total: ${names.length} parameters in ${chunks.length} chunks (~${CHUNK_SIZE_KB}KB each):`);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const preview = chunk.names.slice(0, 5).join(', ') + (chunk.names.length > 5 ? ` ... +${chunk.names.length - 5}` : '');
    const refKey = `parameters.chunk${i}`;
    refs.set(refKey, { path: `components.parameters[${chunk.names.join(',')}]`, size: Math.round(chunk.size * 1024) });
    if (!addLine(ctx, `    ${i}: ${preview} (${chunk.size.toFixed(1)}KB) @ref:${refKey}`)) break;
    
    // Show parameter details for first 3 in chunk
    for (let j = 0; j < Math.min(3, chunk.names.length); j++) {
      const paramName = chunk.names[j];
      const param = parameters[paramName];
      if (param?.in && param?.schema) {
        const type = param.schema.type || param.schema.$ref || 'object';
        const desc = param.description ? ` - ${param.description.substring(0, 80)}` : '';
        if (!addLine(ctx, `      ${paramName}: ${param.in} ${type}${desc}`)) break;
      }
    }
  }
}

function estimateTokens(text, tokenizer) {
  // Rough estimate: ~4 chars/token for code/JSON (more accurate)
  return Math.ceil(text.length / 4);
}

function estimateSize(obj) {
  try {
    return JSON.stringify(obj).length;
  } catch {
    return 0;
  }
}

function formatSize(chars) {
  if (chars < 1024) return chars + ' chars';
  if (chars < 1024 * 1024) return (chars / 1024).toFixed(1) + ' KB';
  return (chars / (1024 * 1024)).toFixed(1) + ' MB';
}

function hashSource(source) {
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}