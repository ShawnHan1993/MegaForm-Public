import type { Nut } from '../types';
import { findLatexRanges } from './latex';

export function toInlineLatexPreview(text: string): string {
  const trimmed = text.trim();
  const displayBracket = trimmed.match(/^\\\[([\s\S]*)\\\]$/);
  if (displayBracket) return `\\(${displayBracket[1].trim()}\\)`;

  const displayDollar = trimmed.match(/^\$\$([\s\S]*)\$\$$/);
  if (displayDollar) return `\\(${displayDollar[1].trim()}\\)`;

  return trimmed;
}

export function getNutReferenceText(content: string, nut: Nut, fallback = ''): string {
  const latexRanges = findLatexRanges(content);
  let start = Math.max(0, Math.min(nut.seek, content.length));
  let end = Math.max(start, Math.min(nut.end_seek, content.length));

  for (const range of latexRanges) {
    if (start < range.end && end > range.start) {
      start = Math.min(start, range.start);
      end = Math.max(end, range.end);
    }
  }

  return content.slice(start, end).trim() || fallback.trim();
}
