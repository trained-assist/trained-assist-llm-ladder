export function compressWebPage(html, url, keywords = []) {
  const title = extractTitle(html);
  const headings = extractHeadings(html);
  const markdown = htmlToMarkdown(html);

  const ref = JSON.stringify({ type: 'url', url });

  const compressed = `[COMPRESSED:url:${url}]
Title: ${title}
Headings: ${headings.length > 0 ? headings.join(' | ') : 'none'}

Markdown (${markdown.length} chars):
${markdown}
[/COMPRESSED]
→ get_context: ${ref}`;

  return {
    compressed,
    ref,
    stats: {
      originalChars: html.length,
      compressedChars: compressed.length,
      ratio: (compressed.length / html.length * 100).toFixed(1),
      headings: headings.length,
      markdownChars: markdown.length,
    },
  };
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : 'untitled';
}

function extractHeadings(html) {
  const headings = [];
  const regex = /<h[23][^>]*>([^<]+)<\/h[23]>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    headings.push(match[1].trim());
  }
  return headings.slice(0, 10);
}

function htmlToMarkdown(html) {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);

  return sentences.slice(0, 30).map(s => s.trim()).join('. ');
}
