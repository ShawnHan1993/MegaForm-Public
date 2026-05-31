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

export function renderLatex(content: string): string {
  let result = content;

  // ── Step 1: 块级公式 \[...\]（LaTeX 标准 display） ──
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return _match;
    try {
      return katex.renderToString(trimmed, {
        displayMode: true,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return _match;
    }
  });

  // ── Step 2: 块级公式 $$...$$（允许跨行） ──
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return _match;
    try {
      return katex.renderToString(trimmed, {
        displayMode: true,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return _match;
    }
  });

  // ── Step 3: 行内公式 \(...\)（LaTeX 标准 inline） ──
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return _match;
    try {
      return katex.renderToString(trimmed, {
        displayMode: false,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return _match;
    }
  });

  // ── Step 4: 行内公式 $...$ ──
  // 匹配单 $ 包裹的内容，排除 $$ 和纯数字金额
  result = result.replace(/\$([^$\n]{1,500}?)\$/g, (match, math: string) => {
    const trimmed = math.trim();
    if (!trimmed) return match;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return match; // $100 / $3.50
    try {
      return katex.renderToString(trimmed, {
        displayMode: false,
        throwOnError: false,
        strict: false,
      });
    } catch {
      return match;
    }
  });

  return result;
}
