/**
 * MarkdownContent — Markdown 渲染组件 (React.memo 优化)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 使用 marked.js 将 Markdown 转 HTML, 通过 dangerouslySetInnerHTML 渲染。
 *
 * Nut 高亮机制:
 *   - highlightedNuts: 普通高亮 (蓝色背景)
 *   - collapsedNutIds: 波浪线下划线 (折叠态)
 *   - pendingNutIds: 脉冲动画高亮 (追问等待中)
 *   - hoveredNutId: hover 态高亮
 *
 * 代码块增强:
 *   - VS Code 风格容器 (语言标签 + 复制按钮)
 *   - highlight.js 语法高亮
 *   - 复制按钮 (Lucide Copy 图标)
 *
 * React.memo 比较器:
 *   比较 content / contentOffset / hover 状态，以及 nut 与 Set 的内容。
 *   Set 按内容比较，避免父组件新建 Set 导致无意义重渲染。
 */

import { marked, Renderer } from 'marked';
import type { Nut } from '../types';
import type { Tokens } from 'marked';
import { getLanguage, tr } from '../i18n';
import { useMemo, memo, useEffect, useRef, useCallback, useState } from 'react';
import { renderLatex } from '../utils/latex';

interface Props {
  content: string;
  contentOffset?: number;
  highlightedNuts?: Nut[];
  hoveredNutId?: string | null;
  collapsedNutIds?: Set<string>;
  pendingNutIds?: Set<string>;
  onCollapsedNutClick?: (nutId: string) => void;
  /** 是否处于流式输出状态（启用防抖减少闪跳） */
  streaming?: boolean;
}

// 配置 marked 支持 GFM
marked.setOptions({
  gfm: true,
  breaks: false,
});

// ── 内联 SVG 图标 (避免额外依赖, 24x24 → 16x16 缩放) ──
const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

/** execCommand 降级方案（兼容旧浏览器 / 非安全上下文） */
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 语言名 → 显示名映射 (常见语言缩写展开)
 */
const LANG_DISPLAY: Record<string, string> = {
  js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python',
  rb: 'Ruby', ruby: 'Ruby',
  rs: 'Rust', rust: 'Rust',
  go: 'Go', golang: 'Go',
  java: 'Java', kotlin: 'Kotlin',
  c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', 'c#': 'C#',
  swift: 'Swift',
  sql: 'SQL', mysql: 'MySQL', pgsql: 'PostgreSQL',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh',
  html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML', toml: 'TOML',
  md: 'Markdown', markdown: 'Markdown',
  dockerfile: 'Dockerfile', docker: 'Docker',
  graphql: 'GraphQL', gql: 'GraphQL',
  tf: 'Terraform', hcl: 'HCL',
  proto: 'Protobuf', protobuf: 'Protobuf',
  makefile: 'Makefile', cmake: 'CMake',
  text: 'Plain Text', plaintext: 'Plain Text', txt: 'Plain Text',
};

function langLabel(lang: string | null): string {
  if (!lang) return 'code';
  return LANG_DISPLAY[lang.toLowerCase()] || lang;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

const markdownRenderer = new Renderer();

markdownRenderer.code = ({ text, lang, escaped }: Tokens.Code): string => {
  const rawLang = (lang || '').match(/^\S+/)?.[0] || null;
  const code = (escaped ? text : escapeHtml(text)).replace(/\n$/, '') + '\n';
  const langClass = rawLang ? ` class="language-${escapeAttr(rawLang)}"` : '';

  return `<div class="code-block-wrapper">
    <div class="code-block-header">
      <span class="code-block-lang">${escapeHtml(langLabel(rawLang))}</span>
      <button class="code-block-copy" title="${escapeAttr(tr('copyCode', undefined, getLanguage()))}">${COPY_ICON}</button>
    </div>
    <pre><code${langClass}>${code}</code></pre>
  </div>
`;
};

function setEquals<T>(a?: Set<T>, b?: Set<T>): boolean {
  if (a === b) return true;
  if (!a || !b) return (!a || a.size === 0) && (!b || b.size === 0);
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function nutsEqual(a?: Nut[], b?: Nut[]): boolean {
  if (a === b) return true;
  if (!a || !b) return (!a || a.length === 0) && (!b || b.length === 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.seek !== right.seek ||
      left.end_seek !== right.end_seek
    ) {
      return false;
    }
  }
  return true;
}

// ━━━ MarkdownContent 组件 (React.memo) ━━━
const MarkdownContent = memo(function MarkdownContent({
  content,
  contentOffset = 0,
  highlightedNuts = [],
  hoveredNutId,
  collapsedNutIds,
  pendingNutIds,
  onCollapsedNutClick,
  streaming = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // ── 流式渲染策略 ──
  // 粒度：setTimeout(0) → 几乎逐 token 渲染，但同事件循环内 batched
  // 代码块防抖：不通过延迟渲染，而是跳过开放代码块的 highlight.js 高亮
  // 原理：开放代码块以纯文本 <pre><code> 渲染，不做语法高亮 →
  //       DOM 结构稳定（无 hljs 异步 class 注入），不会抖动。
  //      代码块闭合的瞬间（``` 出现），最后一次渲染触发高亮，一次性完成。
  const [debouncedContent, setDebouncedContent] = useState(content);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // 非流式模式（已完成的回复）直接同步更新
    if (!streaming) {
      clearTimeout(debounceTimerRef.current);
      setDebouncedContent(content);
      return;
    }

    // 流式模式：setTimeout(0) 不做积攒，同一事件循环内的多个 chunk
    // 会因 clearTimeout 而只触发一次渲染。chunk 到达间隔 >4ms 则逐次渲染。
    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedContent(content);
    }, 0);  // 微任务延迟，不积攒 chunk，但让 React 批量同步

    return () => clearTimeout(debounceTimerRef.current);
  }, [content, streaming]);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => clearTimeout(debounceTimerRef.current);
  }, []);

  // 将 Markdown + Nut 高亮标记 转为 HTML (useMemo 缓存，基于防抖后的 content)
  const html = useMemo(() => {
    if (!debouncedContent) return '';

    let processedContent = debouncedContent;

    const allNutsToMark: { nut: Nut; type: 'collapsed' | 'highlighted' | 'pending' }[] = [];

    if (collapsedNutIds && collapsedNutIds.size > 0) {
      for (const nut of highlightedNuts) {
        if (collapsedNutIds.has(nut.id)) {
          allNutsToMark.push({ nut, type: 'collapsed' });
        }
      }
    }

    if (pendingNutIds && pendingNutIds.size > 0) {
      for (const nut of highlightedNuts) {
        if (pendingNutIds.has(nut.id)) {
          const existing = allNutsToMark.find(x => x.nut.id === nut.id);
          if (!existing) {
            allNutsToMark.push({ nut, type: 'pending' });
          }
        }
      }
    }

    if (hoveredNutId) {
      const hoveredNut = highlightedNuts.find(n => n.id === hoveredNutId);
      if (hoveredNut) {
        const existing = allNutsToMark.find(x => x.nut.id === hoveredNutId);
        if (!existing) {
          allNutsToMark.push({ nut: hoveredNut, type: 'highlighted' });
        }
      }
    }

    allNutsToMark.sort((a, b) => b.nut.seek - a.nut.seek);

    for (const { nut, type } of allNutsToMark) {
      const localSeek = nut.seek - contentOffset;
      const localEndSeek = nut.end_seek - contentOffset;

      if (localSeek < 0 || localEndSeek > processedContent.length || localSeek >= localEndSeek) continue;

      const className = type === 'collapsed' ? 'nut-collapsed' : type === 'pending' ? 'nut-pending' : 'nut-highlight';
      const dataAttr = `data-nut-id="${nut.id}"`;
      const clickAttr = type === 'collapsed' ? 'data-nut-collapsed="true"' : '';

      processedContent =
        processedContent.slice(0, localSeek) +
        `<span class="${className}" ${dataAttr} ${clickAttr}>` +
        processedContent.slice(localSeek, localEndSeek) +
        '</span>' +
        processedContent.slice(localEndSeek);
    }

    try {
      const latexRendered = renderLatex(processedContent);
      return marked.parse(latexRendered, { renderer: markdownRenderer }) as string;
    } catch {
      return `<p>${processedContent}</p>`;
    }
  }, [debouncedContent, contentOffset, highlightedNuts, hoveredNutId, collapsedNutIds, pendingNutIds]);

  // ── 代码块增强 ──
  // wrapper 由 marked renderer 直接生成；这里只负责 highlight.js 语法高亮。
  const prevHtmlRef = useRef<string>('');
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 跳过 html 未变化的重复渲染（React memo 可能仍触发 useEffect）
    if (html === prevHtmlRef.current) return;
    prevHtmlRef.current = html;

    // ── highlight.js 语法高亮（仅未高亮且已闭合的 code block） ──
    import('highlight.js/lib/common').then(({ default: hljs }) => {
      const codeBlocks = container.querySelectorAll<HTMLElement>('pre code');

      // 流式 + 有开放代码块时，跳过最后一个 code block（它正在流式中变化）
      const fenceCount = (content.match(/```/g) || []).length;
      const hasOpenBlock = streaming && fenceCount % 2 !== 0;

      codeBlocks.forEach((block, i) => {
        // 跳过已高亮的 code block，避免重复高亮导致 DOM 闪跳
        if (block.classList.contains('hljs')) return;
        // 跳过正在流式中的最后一个开放代码块（不抖动的关键）
        if (hasOpenBlock && i === codeBlocks.length - 1) return;
        try {
          hljs.highlightElement(block);
        } catch {
          // 不支持的语言跳过
        }
      });
    });
  }, [html, content, streaming]);

  // ── 事件委托: 折叠 nut 点击 + 复制按钮点击 ──
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // 复制按钮
    const copyBtn = target.closest('.code-block-copy') as HTMLElement | null;
    if (copyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const wrapper = copyBtn.closest('.code-block-wrapper');
      const codeEl = wrapper?.querySelector('code');
      if (codeEl) {
        const text = codeEl.textContent || '';
        const doCopy = () => {
          copyBtn.innerHTML = CHECK_ICON;
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.innerHTML = COPY_ICON;
            copyBtn.classList.remove('copied');
          }, 2000);
        };
        // 优先 Clipboard API，失败则降级到 execCommand
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(doCopy).catch(() => {
            if (fallbackCopy(text)) doCopy();
          });
        } else {
          if (fallbackCopy(text)) doCopy();
        }
      }
      return;
    }

    // 折叠 nut 点击
    const collapsedEl = target.closest('[data-nut-collapsed="true"]');
    if (collapsedEl) {
      const nutId = collapsedEl.getAttribute('data-nut-id');
      if (nutId && onCollapsedNutClick) {
        e.preventDefault();
        e.stopPropagation();
        onCollapsedNutClick(nutId);
      }
    }
  }, [onCollapsedNutClick]);

  if (!content) return null;

  return (
    <div
      ref={containerRef}
      className={`markdown-body${streaming ? ' markdown-body-streaming' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}, (prevProps, nextProps) => {
  return prevProps.content === nextProps.content
    && prevProps.contentOffset === nextProps.contentOffset
    && prevProps.hoveredNutId === nextProps.hoveredNutId
    && prevProps.streaming === nextProps.streaming
    && nutsEqual(prevProps.highlightedNuts, nextProps.highlightedNuts)
    && setEquals(prevProps.collapsedNutIds, nextProps.collapsedNutIds)
    && setEquals(prevProps.pendingNutIds, nextProps.pendingNutIds);
});

export default MarkdownContent;
