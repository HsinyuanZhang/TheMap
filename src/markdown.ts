import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { escapeRawHtml } from './content-format';

export async function renderSafeMarkdown(markdown: string): Promise<string> {
  const html = await marked.parse(escapeRawHtml(markdown));
  return DOMPurify.sanitize(html);
}
