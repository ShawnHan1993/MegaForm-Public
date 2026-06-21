/**
 * renderLatex — 预处理文本中的 LaTeX 数学表达式，转成 KaTeX HTML
 *
 * 支持四种分隔符：
 *   $$ ... $$       块级公式（display mode）
 *   \[ ... \]       块级公式（display mode，LaTeX 标准）
 *   $ ... $         行内公式（inline mode）
 *   \( ... \)       行内公式（inline mode，LaTeX 标准）
 *
 * 边界保护：
 *   - $100 类金额不触发渲染（纯数字跳过）
 *   - 无内容的 $$ / \[\] 不触发
 *   - 渲染失败时回退显示原始文本
 */
import katex from 'katex';

export interface LatexRange {
  start: number;
  end: number;
}

export interface LatexPlaceholderResult {
  content: string;
  html: string[];
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderLatexWithSource(source: string, math: string, displayMode: boolean): string {
  const rendered = katex.renderToString(math, {
    displayMode,
    throwOnError: false,
    strict: false,
  });
  return `<span class="latex-source" data-latex-source="${escapeAttr(source)}">${rendered}</span>`;
}

function collectLatexRanges(content: string, pattern: RegExp, shouldKeep: (math: string) => boolean = () => true): LatexRange[] {
  const ranges: LatexRange[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const math = match[1] || '';
    if (math.trim() && shouldKeep(math.trim())) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return ranges;
}

export function findLatexRanges(content: string): LatexRange[] {
  const ranges = [
    ...collectLatexRanges(content, /\\\[([\s\S]*?)\\\]/g),
    ...collectLatexRanges(content, /\$\$([\s\S]*?)\$\$/g),
    ...collectLatexRanges(content, /\\\(([\s\S]*?)\\\)/g),
    ...collectLatexRanges(content, /\$([^$\n]{1,500}?)\$/g, (math) => !/^\d+(\.\d+)?$/.test(math)),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  const nonOverlapping: LatexRange[] = [];
  let lastEnd = -1;
  for (const range of ranges) {
    if (range.start >= lastEnd) {
      nonOverlapping.push(range);
      lastEnd = range.end;
    }
  }

  return nonOverlapping;
}

export function renderLatexToPlaceholders(content: string): LatexPlaceholderResult {
  const html: string[] = [];
  let result = content;

  const renderPlaceholder = (match: string, math: string, displayMode: boolean, shouldKeep: (trimmed: string) => boolean = () => true): string => {
    const trimmed = math.trim();
    if (!trimmed || !shouldKeep(trimmed)) return match;
    try {
      const index = html.length;
      html.push(renderLatexWithSource(match, trimmed, displayMode));
      return `MEGAFORM_LATEX_PLACEHOLDER_${index}`;
    } catch {
      return match;
    }
  };

  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (match, math: string) => {
    return renderPlaceholder(match, math, true);
  });

  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (match, math: string) => {
    return renderPlaceholder(match, math, true);
  });

  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (match, math: string) => {
    return renderPlaceholder(match, math, false);
  });

  result = result.replace(/\$([^$\n]{1,500}?)\$/g, (match, math: string) => {
    return renderPlaceholder(match, math, false, (trimmed) => !/^\d+(\.\d+)?$/.test(trimmed));
  });

  return { content: result, html };
}

export function restoreLatexPlaceholders(content: string, html: string[]): string {
  return content.replace(/MEGAFORM_LATEX_PLACEHOLDER_(\d+)/g, (match, index: string) => {
    return html[Number(index)] ?? match;
  });
}

export function renderLatex(content: string): string {
  let result = content;

  // ── Step 1: 块级公式 \[...\]（LaTeX 标准 display） ──
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return match;
    try {
      return renderLatexWithSource(match, trimmed, true);
    } catch {
      return match;
    }
  });

  // ── Step 2: 块级公式 $$...$$（允许跨行） ──
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return match;
    try {
      return renderLatexWithSource(match, trimmed, true);
    } catch {
      return match;
    }
  });

  // ── Step 3: 行内公式 \(...\)（LaTeX 标准 inline） ──
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return match;
    try {
      return renderLatexWithSource(match, trimmed, false);
    } catch {
      return match;
    }
  });

  // ── Step 4: 行内公式 $...$ ──
  // 匹配单 $ 包裹的内容，排除 $$ 和纯数字金额
  result = result.replace(/\$([^$\n]{1,500}?)\$/g, (match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return match;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return match; // $100 / $3.50
    try {
      return renderLatexWithSource(match, trimmed, false);
    } catch {
      return match;
    }
  });

  return result;
}
