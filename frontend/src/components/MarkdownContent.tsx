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
import { createPortal } from 'react-dom';
import { findLatexRanges, renderLatexToPlaceholders, restoreLatexPlaceholders } from '../utils/latex';

interface Props {
  content: string;
  contentOffset?: number;
  highlightedNuts?: Nut[];
  hoveredNutId?: string | null;
  collapsedNutIds?: Set<string>;
  pendingNutIds?: Set<string>;
  focusNutIds?: Set<string>;
  onCollapsedNutClick?: (nutId: string) => void;
  onFocusNutOpen?: (nutId: string) => void;
  /** 是否处于流式输出状态（启用防抖减少闪跳） */
  streaming?: boolean;
  /** 搜索命中词：渲染后包裹第一个匹配文本节点，供 ChatArea 精确滚动 */
  searchQuery?: string;
  searchHitId?: string;
  /** 在标签、面包屑等短文本中以内联元素渲染 */
  inline?: boolean;
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

const IMPLICIT_CAPTION_PATTERN = /^(?:Figure|Table)\b/i;
const IMPLICIT_CAPTION_CLASS = 'markdown-implicit-caption';

function isWhitespaceOrBreak(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return !(node.textContent || '').trim();
  }
  return node instanceof HTMLElement && node.matches('br');
}

function getInlineLineText(nodes: Node[], start: number): string {
  let text = '';
  for (let index = start; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node instanceof HTMLElement && node.matches('br')) break;
    if (
      node instanceof HTMLElement
      && (node.matches('img') || Boolean(node.querySelector('img')))
    ) {
      return '';
    }
    text += node.textContent || '';
  }
  return text.trimStart();
}

function markInlineCaptionLine(paragraph: HTMLParagraphElement): boolean {
  const nodes = Array.from(paragraph.childNodes);

  for (let breakIndex = 0; breakIndex < nodes.length; breakIndex += 1) {
    const lineBreak = nodes[breakIndex];
    if (!(lineBreak instanceof HTMLElement) || !lineBreak.matches('br')) continue;

    let captionIndex = breakIndex + 1;
    while (captionIndex < nodes.length && isWhitespaceOrBreak(nodes[captionIndex])) {
      captionIndex += 1;
    }

    const captionNodes = nodes.slice(captionIndex);
    const captionText = getInlineLineText(nodes, captionIndex);
    if (!IMPLICIT_CAPTION_PATTERN.test(captionText)) continue;

    // A Markdown hard break keeps the caption in its surrounding paragraph.
    // The caption span is block-level, so discard only the redundant separator.
    nodes.slice(breakIndex, captionIndex).forEach(node => node.remove());

    const caption = document.createElement('span');
    caption.className = IMPLICIT_CAPTION_CLASS;
    captionNodes.forEach(node => caption.appendChild(node));
    paragraph.appendChild(caption);
    paragraph.classList.add('markdown-has-inline-caption');
    return true;
  }

  return false;
}

function isMediaBlock(element: Element): boolean {
  if (element.matches('table, img')) return true;
  if (element.matches('figure')) return Boolean(element.querySelector('img'));
  return element.matches('p')
    && Boolean(element.querySelector('img'))
    && !(element.textContent || '').trim();
}

function isWhitespaceOnlyBlock(element: Element): boolean {
  return element.matches('p, div')
    && !(element.textContent || '').trim()
    && !element.querySelector('img, table, pre, hr, svg, video, audio');
}

function previousSignificantElement(element: Element): Element | null {
  let previous = element.previousElementSibling;
  while (previous && isWhitespaceOnlyBlock(previous)) {
    previous = previous.previousElementSibling;
  }
  return previous;
}

/**
 * MinerU/PDF Markdown may leave captions as ordinary paragraphs. Mark a paragraph
 * as a caption whenever it starts with Figure/Table. If it immediately follows
 * an image or table, also mark that media block so CSS can remove the gap.
 */
function annotateImplicitCaptions(html: string): string {
  if (typeof document === 'undefined') return html;

  const template = document.createElement('template');
  template.innerHTML = html;

  const paragraphs = Array.from(template.content.querySelectorAll<HTMLParagraphElement>('p'));
  paragraphs.forEach(markInlineCaptionLine);

  paragraphs.forEach(paragraph => {
    if (paragraph.classList.contains('markdown-has-inline-caption')) return;
    if (!IMPLICIT_CAPTION_PATTERN.test((paragraph.textContent || '').trimStart())) return;

    const previous = previousSignificantElement(paragraph);
    if (previous && isMediaBlock(previous)) {
      previous.classList.add('markdown-captioned-media');
    }
    paragraph.classList.add(IMPLICIT_CAPTION_CLASS);
  });

  return template.innerHTML;
}

const markdownRenderer = new Renderer();
const STREAMING_RENDER_DEBOUNCE_MS = 100;
let highlightJsPromise: Promise<typeof import('highlight.js/lib/common').default> | null = null;

function loadHighlightJs() {
  highlightJsPromise ||= import('highlight.js/lib/common').then(({ default: hljs }) => hljs);
  return highlightJsPromise;
}

interface CodeReferenceMark {
  start: number;
  end: number;
  className: string;
  nutId: string | null;
  collapsed: boolean;
  focus: boolean;
}

interface FocusedImage {
  src: string;
  alt: string;
}

const MIN_FOCUSED_IMAGE_SCALE = 0.5;
const MAX_FOCUSED_IMAGE_SCALE = 5;

function clampFocusedImageScale(scale: number): number {
  return Math.min(MAX_FOCUSED_IMAGE_SCALE, Math.max(MIN_FOCUSED_IMAGE_SCALE, scale));
}

function getTouchDistance(touches: React.TouchList): number {
  const first = touches.item(0);
  const second = touches.item(1);
  if (!first || !second) return 0;
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function getTextOffset(root: HTMLElement, boundary: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(boundary, offset);
  return range.toString().length;
}

function captureCodeReferenceMarks(block: HTMLElement): CodeReferenceMark[] {
  return Array.from(block.querySelectorAll<HTMLElement>('.nut-highlight, .nut-collapsed, .nut-pending, .nut-focus-anchor'))
    .map(mark => ({
      start: getTextOffset(block, mark, 0),
      end: getTextOffset(block, mark, mark.childNodes.length),
      className: mark.className,
      nutId: mark.getAttribute('data-nut-id'),
      collapsed: mark.getAttribute('data-nut-collapsed') === 'true',
      focus: mark.classList.contains('nut-focus-anchor'),
    }))
    .filter(mark => mark.end > mark.start)
    .sort((a, b) => b.start - a.start);
}

function findTextBoundary(root: HTMLElement, target: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node = walker.nextNode() as Text | null;
  let last: Text | null = null;

  while (node) {
    const length = node.data.length;
    if (target <= consumed + length) {
      return { node, offset: Math.max(0, target - consumed) };
    }
    consumed += length;
    last = node;
    node = walker.nextNode() as Text | null;
  }

  return last && target === consumed ? { node: last, offset: last.data.length } : null;
}

function restoreCodeReferenceMarks(block: HTMLElement, marks: CodeReferenceMark[]) {
  // Reverse source order keeps earlier offsets stable while later ranges are wrapped.
  for (const mark of marks) {
    const start = findTextBoundary(block, mark.start);
    const end = findTextBoundary(block, mark.end);
    if (!start || !end) continue;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);

    const wrapper = document.createElement('span');
    wrapper.className = mark.className;
    if (mark.nutId) wrapper.setAttribute('data-nut-id', mark.nutId);
    if (mark.collapsed) wrapper.setAttribute('data-nut-collapsed', 'true');
    if (mark.focus) {
      wrapper.setAttribute('data-nut-focus', 'true');
      wrapper.setAttribute('role', 'link');
      wrapper.tabIndex = 0;
    }
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  }
}

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

function expandRangeAroundLatex(start: number, end: number, latexRanges: ReturnType<typeof findLatexRanges>): { start: number; end: number } {
  let expandedStart = start;
  let expandedEnd = end;
  let changed = true;

  while (changed) {
    changed = false;
    for (const range of latexRanges) {
      if (expandedStart < range.end && expandedEnd > range.start) {
        const nextStart = Math.min(expandedStart, range.start);
        const nextEnd = Math.max(expandedEnd, range.end);
        if (nextStart !== expandedStart || nextEnd !== expandedEnd) {
          expandedStart = nextStart;
          expandedEnd = nextEnd;
          changed = true;
        }
      }
    }
  }

  return { start: expandedStart, end: expandedEnd };
}

// ━━━ MarkdownContent 组件 (React.memo) ━━━
const MarkdownContent = memo(function MarkdownContent({
  content,
  contentOffset = 0,
  highlightedNuts = [],
  hoveredNutId,
  collapsedNutIds,
  pendingNutIds,
  focusNutIds,
  onCollapsedNutClick,
  onFocusNutOpen,
  streaming = false,
  searchQuery,
  searchHitId,
  inline = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedImage, setFocusedImage] = useState<FocusedImage | null>(null);
  const focusedImageElementRef = useRef<HTMLImageElement>(null);
  const focusedImageScaleRef = useRef(1);
  const focusedImageOffsetRef = useRef({ x: 0, y: 0 });
  const focusedImageFrameRef = useRef<number | null>(null);
  const focusedImageDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const pinchGestureRef = useRef<{ distance: number; scale: number } | null>(null);

  // ── 流式渲染策略 ──
  // 粒度：约 100ms 合并渲染，避免长回答逐 token 反复 Markdown/KaTeX parse。
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

    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedContent(content);
    }, STREAMING_RENDER_DEBOUNCE_MS);

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

    const allNutsToMark: {
      nut: Nut;
      type: 'collapsed' | 'highlighted' | 'pending' | 'focus';
    }[] = [];

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

    if (focusNutIds && focusNutIds.size > 0) {
      for (const nut of highlightedNuts) {
        if (focusNutIds.has(nut.id)) {
          const existing = allNutsToMark.find(x => x.nut.id === nut.id);
          if (!existing) {
            allNutsToMark.push({ nut, type: 'focus' });
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

    const latexRanges = findLatexRanges(processedContent);
    const marks = allNutsToMark
      .map(({ nut, type }) => {
        const localSeek = nut.seek - contentOffset;
        const localEndSeek = nut.end_seek - contentOffset;
        const expanded = expandRangeAroundLatex(localSeek, localEndSeek, latexRanges);
        return { nut, type, localSeek: expanded.start, localEndSeek: expanded.end };
      })
      .sort((a, b) => b.localSeek - a.localSeek);

    const markPlaceholders: Array<{ open: string; close: string; htmlOpen: string }> = [];
    for (const [index, { nut, type, localSeek, localEndSeek }] of marks.entries()) {
      if (localSeek < 0 || localEndSeek > processedContent.length || localSeek >= localEndSeek) continue;

      const className = type === 'collapsed'
        ? 'nut-collapsed'
        : type === 'pending'
          ? 'nut-pending'
          : type === 'focus'
            ? 'nut-focus-anchor'
            : 'nut-highlight';
      const dataAttr = `data-nut-id="${escapeAttr(nut.id)}"`;
      const clickAttr = type === 'collapsed' ? 'data-nut-collapsed="true"' : '';
      const focusAttr = type === 'focus' ? 'data-nut-focus="true" role="link" tabindex="0"' : '';

      // HTML inserted directly into Markdown source is escaped inside code blocks.
      // Plain-text sentinels survive Markdown parsing and are restored afterwards.
      const open = `MEGAFORMNUTOPEN${index}TOKEN`;
      const close = `MEGAFORMNUTCLOSE${index}TOKEN`;
      markPlaceholders.push({
        open,
        close,
        htmlOpen: `<span class="${className}" ${dataAttr} ${clickAttr} ${focusAttr}>`,
      });
      processedContent =
        processedContent.slice(0, localSeek) +
        open +
        processedContent.slice(localSeek, localEndSeek) +
        close +
        processedContent.slice(localEndSeek);
    }

    try {
      const latexRendered = renderLatexToPlaceholders(processedContent);
      const markdownHtml = inline
        ? marked.parseInline(latexRendered.content, { renderer: markdownRenderer }) as string
        : marked.parse(latexRendered.content, { renderer: markdownRenderer }) as string;
      let restored = restoreLatexPlaceholders(markdownHtml, latexRendered.html);
      for (const placeholder of markPlaceholders) {
        restored = restored
          .split(placeholder.open).join(placeholder.htmlOpen)
          .split(placeholder.close).join('</span>');
      }
      return inline || streaming ? restored : annotateImplicitCaptions(restored);
    } catch {
      return inline ? processedContent : `<p>${processedContent}</p>`;
    }
  }, [
    debouncedContent,
    contentOffset,
    highlightedNuts,
    hoveredNutId,
    collapsedNutIds,
    pendingNutIds,
    focusNutIds,
    inline,
    streaming,
  ]);

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
    loadHighlightJs().then(hljs => {
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
          const referenceMarks = captureCodeReferenceMarks(block);
          if (referenceMarks.length > 0) {
            // highlight.js rejects/replaces pre-existing markup. Highlight the plain
            // code first, then restore reference spans over its generated token DOM.
            block.textContent = block.textContent || '';
          }
          hljs.highlightElement(block);
          restoreCodeReferenceMarks(block, referenceMarks);
        } catch {
          // 不支持的语言跳过
        }
      });
    });
  }, [html, content, streaming]);

  // ── 搜索命中锚点：在渲染后的可见文本里包裹第一处匹配 ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.querySelectorAll('.search-hit-anchor').forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });

    const query = searchQuery?.trim();
    if (!query || !searchHitId) return;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script, style, button')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const lowerQuery = query.toLocaleLowerCase();
    let textNode = walker.nextNode() as Text | null;
    while (textNode) {
      const text = textNode.nodeValue || '';
      const idx = text.toLocaleLowerCase().indexOf(lowerQuery);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, idx + query.length);
        const span = document.createElement('span');
        span.className = 'search-hit-anchor';
        span.dataset.searchHit = searchHitId;
        range.surroundContents(span);
        break;
      }
      textNode = walker.nextNode() as Text | null;
    }
  }, [html, searchQuery, searchHitId]);

  const scheduleFocusedImageTransform = useCallback(() => {
    if (focusedImageFrameRef.current !== null) return;

    focusedImageFrameRef.current = requestAnimationFrame(() => {
      focusedImageFrameRef.current = null;
      const image = focusedImageElementRef.current;
      if (image) {
        const { x, y } = focusedImageOffsetRef.current;
        image.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${focusedImageScaleRef.current})`;
      }
    });
  }, []);

  const scheduleFocusedImageScale = useCallback((scale: number) => {
    focusedImageScaleRef.current = clampFocusedImageScale(scale);
    scheduleFocusedImageTransform();
  }, [scheduleFocusedImageTransform]);

  const stopFocusedImageDrag = useCallback((pointerId?: number) => {
    const drag = focusedImageDragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;

    const image = focusedImageElementRef.current;
    if (image?.hasPointerCapture(drag.pointerId)) {
      image.releasePointerCapture(drag.pointerId);
    }
    image?.classList.remove('is-dragging');
    focusedImageDragRef.current = null;
  }, []);

  const closeFocusedImage = useCallback(() => {
    stopFocusedImageDrag();
    pinchGestureRef.current = null;
    focusedImageScaleRef.current = 1;
    focusedImageOffsetRef.current = { x: 0, y: 0 };
    if (focusedImageFrameRef.current !== null) {
      cancelAnimationFrame(focusedImageFrameRef.current);
      focusedImageFrameRef.current = null;
    }
    setFocusedImage(null);
  }, [stopFocusedImageDrag]);

  useEffect(() => () => {
    if (focusedImageFrameRef.current !== null) {
      cancelAnimationFrame(focusedImageFrameRef.current);
    }
  }, []);

  // ── 图片聚焦层：Esc 关闭，并在打开期间锁定页面背景滚动 ──
  useEffect(() => {
    if (!focusedImage) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFocusedImage();
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [focusedImage, closeFocusedImage]);

  const handleFocusedImageWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const boundedDelta = Math.max(-120, Math.min(120, event.deltaY));
    const scaleFactor = Math.exp(-boundedDelta * 0.0015);
    scheduleFocusedImageScale(focusedImageScaleRef.current * scaleFactor);
  }, [scheduleFocusedImageScale]);

  const handleFocusedImageTouchStart = useCallback((event: React.TouchEvent) => {
    if (event.touches.length !== 2) return;
    stopFocusedImageDrag();
    const distance = getTouchDistance(event.touches);
    if (distance <= 0) return;
    event.preventDefault();
    pinchGestureRef.current = { distance, scale: focusedImageScaleRef.current };
  }, [stopFocusedImageDrag]);

  const handleFocusedImageTouchMove = useCallback((event: React.TouchEvent) => {
    const gesture = pinchGestureRef.current;
    if (!gesture || event.touches.length !== 2) return;
    const distance = getTouchDistance(event.touches);
    if (distance <= 0) return;
    event.preventDefault();
    scheduleFocusedImageScale(gesture.scale * distance / gesture.distance);
  }, [scheduleFocusedImageScale]);

  const handleFocusedImageTouchEnd = useCallback((event: React.TouchEvent) => {
    if (event.touches.length < 2) pinchGestureRef.current = null;
  }, []);

  const handleFocusedImagePointerDown = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;

    event.preventDefault();
    event.stopPropagation();
    const { x, y } = focusedImageOffsetRef.current;
    focusedImageDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: x,
      originY: y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('is-dragging');
  }, []);

  const handleFocusedImagePointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const drag = focusedImageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || pinchGestureRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    focusedImageOffsetRef.current = {
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    };
    scheduleFocusedImageTransform();
  }, [scheduleFocusedImageTransform]);

  const handleFocusedImagePointerEnd = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    stopFocusedImageDrag(event.pointerId);
  }, [stopFocusedImageDrag]);

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const focusNut = target.closest<HTMLElement>('.nut-focus-anchor[data-nut-id]');
    if (focusNut && event.currentTarget.contains(focusNut)) {
      const nutId = focusNut.dataset.nutId;
      if (nutId && onFocusNutOpen) {
        event.preventDefault();
        event.stopPropagation();
        onFocusNutOpen(nutId);
      }
      return;
    }

    const image = target.closest<HTMLImageElement>('img');
    if (!image || !event.currentTarget.contains(image)) return;

    event.preventDefault();
    event.stopPropagation();
    focusedImageScaleRef.current = 1;
    focusedImageOffsetRef.current = { x: 0, y: 0 };
    setFocusedImage({
      src: image.currentSrc || image.src,
      alt: image.alt || '',
    });
  }, [onFocusNutOpen]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter') return;
    const target = event.target as HTMLElement;
    const focusNut = target.closest<HTMLElement>('.nut-focus-anchor[data-nut-id]');
    if (!focusNut || !event.currentTarget.contains(focusNut)) return;
    const nutId = focusNut.dataset.nutId;
    if (!nutId || !onFocusNutOpen) return;
    event.preventDefault();
    event.stopPropagation();
    onFocusNutOpen(nutId);
  }, [onFocusNutOpen]);

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

  const className = `markdown-body${streaming ? ' markdown-body-streaming' : ''}${inline ? ' markdown-inline' : ''}`;

  if (inline) {
    return (
      <span
        ref={containerRef}
        className={className}
        data-markdown-offset={contentOffset}
        data-markdown-length={debouncedContent.length}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      />
    );
  }

  return (
    <>
      <div
        ref={containerRef}
        className={className}
        data-markdown-offset={contentOffset}
        data-markdown-length={debouncedContent.length}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      />
      {focusedImage && createPortal(
        <div
          className="markdown-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={focusedImage.alt || 'Focused image'}
          onClick={closeFocusedImage}
          onWheel={handleFocusedImageWheel}
        >
          <button
            type="button"
            className="markdown-image-lightbox-close"
            aria-label="Close image"
            onClick={closeFocusedImage}
            autoFocus
          >
            ×
          </button>
          <figure
            className="markdown-image-lightbox-figure"
            onClick={event => event.stopPropagation()}
            onTouchStart={handleFocusedImageTouchStart}
            onTouchMove={handleFocusedImageTouchMove}
            onTouchEnd={handleFocusedImageTouchEnd}
            onTouchCancel={handleFocusedImageTouchEnd}
          >
            <img
              ref={focusedImageElementRef}
              className="markdown-image-lightbox-image"
              src={focusedImage.src}
              alt={focusedImage.alt}
              draggable={false}
              onPointerDown={handleFocusedImagePointerDown}
              onPointerMove={handleFocusedImagePointerMove}
              onPointerUp={handleFocusedImagePointerEnd}
              onPointerCancel={handleFocusedImagePointerEnd}
            />
            {focusedImage.alt && (
              <figcaption className="markdown-image-lightbox-caption">
                {focusedImage.alt}
              </figcaption>
            )}
          </figure>
        </div>,
        document.body,
      )}
    </>
  );
}, (prevProps, nextProps) => {
  return prevProps.content === nextProps.content
    && prevProps.contentOffset === nextProps.contentOffset
    && prevProps.hoveredNutId === nextProps.hoveredNutId
    && prevProps.streaming === nextProps.streaming
    && prevProps.searchQuery === nextProps.searchQuery
    && prevProps.searchHitId === nextProps.searchHitId
    && prevProps.inline === nextProps.inline
    && nutsEqual(prevProps.highlightedNuts, nextProps.highlightedNuts)
    && setEquals(prevProps.collapsedNutIds, nextProps.collapsedNutIds)
    && setEquals(prevProps.pendingNutIds, nextProps.pendingNutIds)
    && setEquals(prevProps.focusNutIds, nextProps.focusNutIds)
    && prevProps.onFocusNutOpen === nextProps.onFocusNutOpen;
});

export default MarkdownContent;
