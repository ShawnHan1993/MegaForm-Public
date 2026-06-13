/**
 * ResponseArea — 回答展示 & 文本选择追问核心组件
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 职责:
 *   1. 渲染模型回答 (Markdown), 支持流式输出实时更新
 *   2. 模型切换栏 (单模型)
 *   3. 嵌入追问卡片 — 按 Nut 锚点劈开原文分段渲染
 *   4. 文本选择追问 — 选中文字 → Portal tooltip → 追问输入弹窗
 *      - 桌面端: 浮动弹窗 (morphing 动画)
 *      - 移动端: 全宽底部栏 (替换原输入栏)
 *   5. 选中高亮保持 — CSS Custom Highlight API + useLayoutEffect 恢复
 *   6. 滚动跟随 — viewportX/Y 坐标 + scrollTop 补偿
 *
 * 关键机制:
 *   - document 级别 mouseup/touchend/selectionchange 事件监听
 *   - isTouching 标记: 阻止移动端触摸过程中的 selectionchange 干扰
 *   - selectionInfoRef: 防止 tooltip 显示时重复检测导致 re-render 循环
 *   - lastTouchTimeRef: 500ms 防移动端合成 mousedown 误清除 tooltip
 *   - React.memo on MarkdownContent: 防止 setSelectionInfo 导致的 text 节点替换
 */

import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '../store/appStore';
import { getThinkingDepthClass, getThinkingLevels, type ThinkingLevel } from '../data/thinkingPresets';
import type { Response as RespType, Node, Nut } from '../types';
import MarkdownContent from './MarkdownContent';
import NodeCard from './NodeCard';
import { ArrowRightFromLine, Search, Activity, X, Pin, PinOff, AlertTriangle, CheckCircle2, Plus, ArrowUp } from 'lucide-react';
import { localizeThinkingDescription, localizeThinkingLabel, useLanguage, useT } from '../i18n';

/** 将文本中所有裸 URL 替换为 Markdown 超链接（缩略展示，最多两层 path） */
function formatUrlsInText(text: string): string {
  const urlRegex = /(?<!\]\()https?:\/\/[^\s,\n\)]+/g;
  return text.replace(urlRegex, (url) => {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const display = parts.length <= 2
        ? `${u.host}/${parts.join('/')}`
        : `${u.host}/\u2026/${parts[parts.length - 1]}`;
      return `[${display}](${url})`;
    } catch { return url; }
  });
}

function isScrolledToBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 4;
}

function ThinkingSection({
  thinking,
  isThinking,
  label,
}: {
  thinking: string;
  isThinking: boolean;
  label: string;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || !shouldStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [thinking]);

  const handleThinkingScroll = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    shouldStickToBottomRef.current = isScrolledToBottom(el);
  }, []);

  return (
    <div className="streaming-status-bar">
      <div className="thinking-section">
        <details open={isThinking} className="thinking-details">
          <summary className="thinking-summary">
            <Activity size={14} style={{verticalAlign:'-2px',marginRight:4}} /> {label}
            {isThinking && <span className="thinking-cursor">▌</span>}
          </summary>
          <div
            ref={contentRef}
            className="thinking-content"
            onScroll={handleThinkingScroll}
          >
            <MarkdownContent content={formatUrlsInText(thinking)} />
          </div>
        </details>
      </div>
    </div>
  );
}

function rangeIntersectsNode(range: Range, node: globalThis.Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function isHiddenKatexNode(element: Element): boolean {
  return Boolean(
    element.closest('.katex-mathml') ||
    element.closest('[aria-hidden="true"]')
  );
}

function getFollowupSelectionText(selection: Selection): string {
  const fallback = selection.toString().trim();
  if (!selection.rangeCount) return fallback;

  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!(root instanceof Element)) return fallback;

  const closestLatex = root.closest<HTMLElement>('.latex-source[data-latex-source]');
  const latexElements = [
    ...(closestLatex ? [closestLatex] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('.latex-source[data-latex-source]')),
  ]
    .filter(el => rangeIntersectsNode(range, el));
  if (latexElements.length === 0) return fallback;

  const chunks: string[] = [];
  const seenLatex = new Set<HTMLElement>();

  const walk = (node: globalThis.Node) => {
    if (!rangeIntersectsNode(range, node)) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (isHiddenKatexNode(element)) return;

      if (element instanceof HTMLElement && element.matches('.latex-source[data-latex-source]')) {
        if (!seenLatex.has(element)) {
          chunks.push(element.dataset.latexSource || '');
          seenLatex.add(element);
        }
        return;
      }

      element.childNodes.forEach(walk);
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (!parent || parent.closest('.latex-source') || isHiddenKatexNode(parent)) return;

      let start = 0;
      let end = node.textContent?.length || 0;
      if (node === range.startContainer) start = range.startOffset;
      if (node === range.endContainer) end = range.endOffset;
      if (start < end) chunks.push((node.textContent || '').slice(start, end));
    }
  };

  walk(root);
  return chunks.join('').replace(/\s+/g, ' ').trim() || fallback;
}

function hasLatex(text: string): boolean {
  return /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/.test(text);
}

function getFollowupLabelPreview(text: string): string {
  if (hasLatex(text)) return text;
  const chars = Array.from(text);
  return chars.length > 30 ? chars.slice(0, 30).join('') + '...' : text;
}

interface Props {
  nodeId: string;
  responses: RespType[];
  followupChildren: Node[];
  immersive?: boolean;
  /** 流式响应数据（{modelId: StreamingResponse}），非空时表示该节点正在流式输出 */
  streamingResponses?: Record<string, import('../types').StreamingResponse>;
  /** 当前节点是否正在流式 */
  isStreamingNode?: boolean;
  /** 相机下钻提交帧：禁用 model chip 的 mount/layout 动画 */
  suppressModelChipAnimation?: boolean;
}

/**
 * 将 response content 按 nut 位置分段，返回交替的 [markdown, followup, markdown, ...] 序列
 * 
 * 切割策略：
 * 1. 在 nut.end_seek 处找到当前行的末尾（同一行的文本归入 before 段）
 * 2. 如果 nut 落在 Markdown 表格内，找到表格结束位置再插入 followup
 * 3. 同一表格内的多个 nut，其 followup 在表格结束后依次排列
 * 4. followup 卡片插入在当前行末尾之后、下一行之前
 */
interface MarkdownSegment {
  type: 'markdown';
  content: string;
  startOffset: number; // 该 segment 在原始 content 中的起始位置
}

interface FollowupSegment {
  type: 'followup';
  nodes: Node[];
  nut: Nut;
}

type Segment = MarkdownSegment | FollowupSegment;

/**
 * 将 response content 按 nut 位置分段，返回交替的 [markdown, followup, markdown, ...] 序列
 * 
 * 切割策略：
 * 1. 在 nut.end_seek 处找到当前行的末尾（同一行的文本归入 before 段）
 * 2. 如果 nut 落在 Markdown 表格内，找到表格结束位置再插入 followup
 * 3. 同一表格内的多个 nut，其 followup 在表格结束后依次排列
 * 4. followup 卡片插入在当前行末尾之后、下一行之前
 */
// ═══════════════════════════════════════════════════════════════
// splitContentAtNuts — 将回答按 Nut 锚点劈开成分段序列
// ═══════════════════════════════════════════════════════════════
// 返回交替的 [MarkdownSegment, FollowupSegment, MarkdownSegment, ...]
// 处理表格内 Nut: 统一在表格结束后插入 Followup 卡片
function splitContentAtNuts(
  content: string,
  nuts: Nut[],
  followupByNutId: Map<string, Node[]>,
): Segment[] {
  if (!nuts.length) {
    return [{ type: 'markdown', content, startOffset: 0 }];
  }

  // 只处理有 followup 节点的 nuts
  const activeNuts = nuts
    .filter(nut => followupByNutId.has(nut.id))
    .sort((a, b) => a.end_seek - b.end_seek); // 按位置正序

  if (!activeNuts.length) {
    return [{ type: 'markdown', content, startOffset: 0 }];
  }

  const segments: Segment[] = [];
  let lastEnd = 0;

  // 判断某个位置是否在 Markdown 表格内
  const isInTable = (pos: number): boolean => {
    let lineStart = content.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = content.indexOf('\n', pos);
    const line = content.slice(lineStart, lineEnd >= 0 ? lineEnd : content.length).trim();
    return line.startsWith('|');
  };

  // 找到表格结束位置（表格最后一行之后的 \n\n）
  const findTableEnd = (pos: number): number => {
    let searchFrom = pos;
    while (searchFrom < content.length) {
      const nextNewline = content.indexOf('\n', searchFrom);
      if (nextNewline < 0) break;
      const nextLine = content.slice(nextNewline + 1).trimStart();
      if (!nextLine.startsWith('|')) {
        // 表格结束，找到段落分隔符
        const paraEnd = content.indexOf('\n\n', nextNewline);
        return paraEnd >= 0 ? paraEnd + 2 : nextNewline + 1;
      }
      searchFrom = nextNewline + 1;
    }
    return content.length;
  };

  // 找到当前行末尾位置
  const findLineEnd = (pos: number): number => {
    for (let i = pos; i < content.length; i++) {
      if (content[i] === '\n') return i;
    }
    return content.length;
  };

  // 收集同一表格内所有 nut，统一在表格结束位置插入
  // 算法：先扫描所有 activeNuts，标记哪些在表格内，
  // 然后按组处理——同一表格内的 nut 共享一个 splitPoint
  interface NutGroup {
    nuts: Nut[];
    splitPoint: number;
    inTable: boolean;
  }

  const groups: NutGroup[] = [];
  let i = 0;
  while (i < activeNuts.length) {
    const nut = activeNuts[i];
    const nutEnd = Math.min(nut.end_seek, content.length);

    if (isInTable(nutEnd)) {
      // 找到表格结束位置
      const tableEnd = findTableEnd(nutEnd);
      // 收集同一表格内的后续 nut
      const tableNuts = [nut];
      let j = i + 1;
      while (j < activeNuts.length) {
        const nextNutEnd = Math.min(activeNuts[j].end_seek, content.length);
        if (nextNutEnd <= tableEnd && isInTable(nextNutEnd)) {
          tableNuts.push(activeNuts[j]);
          j++;
        } else {
          break;
        }
      }
      groups.push({ nuts: tableNuts, splitPoint: tableEnd, inTable: true });
      i = j;
    } else {
      groups.push({ nuts: [nut], splitPoint: findLineEnd(nutEnd), inTable: false });
      i++;
    }
  }

  // 按组生成 segments
  for (const group of groups) {
    const before = content.slice(lastEnd, group.splitPoint);
    if (before.trim()) {
      segments.push({ type: 'markdown', content: before, startOffset: lastEnd });
    }

    // 同一组内的所有 followup 依次排列
    for (const nut of group.nuts) {
      const followupNodes = followupByNutId.get(nut.id) || [];
      if (followupNodes.length > 0) {
        segments.push({ type: 'followup', nodes: followupNodes, nut });
      }
    }

    lastEnd = group.splitPoint;
  }

  // 尾部 markdown
  const tail = content.slice(lastEnd);
  if (tail.trim()) {
    segments.push({ type: 'markdown', content: tail, startOffset: lastEnd });
  }

  return segments;
}

/**
 * 在 markdown 原文中查找选中文本的位置
 * 策略1：直接搜索 → 策略2：去格式搜索
 */
// ═══════════════════════════════════════════════════════════════
// findTextPosition — 在 Markdown 原文中查找选中文本位置
// ═══════════════════════════════════════════════════════════════
// 策略1: 直接搜索 → 策略2: 去格式字符后搜索 (plain text 映射)
function findTextPosition(rawContent: string, selectedText: string): { start: number; end: number } | null {
  // 策略1：直接搜索
  const directIdx = rawContent.indexOf(selectedText);
  if (directIdx >= 0) return { start: directIdx, end: directIdx + selectedText.length };

  // 策略2：去格式搜索 — 构建 plain↔raw 映射
  const formatChars = new Set(['#', '*', '[', ']', '(', ')', '>', '_', '~', '`', '|', '!']);
  const plainToRaw: number[] = [];
  let lastPlainWasSpace = false;
  let plain = '';

  for (let rawIdx = 0; rawIdx < rawContent.length; rawIdx++) {
    const ch = rawContent[rawIdx];
    if (formatChars.has(ch)) continue;
    if (ch === ' ' || ch === '\n' || ch === '\t') {
      if (lastPlainWasSpace) continue;
      plainToRaw.push(rawIdx);
      plain += ' ';
      lastPlainWasSpace = true;
    } else {
      plainToRaw.push(rawIdx);
      plain += ch;
      lastPlainWasSpace = false;
    }
  }

  const plainIdx = plain.indexOf(selectedText);
  if (plainIdx < 0) return null;

  const startRaw = plainToRaw[plainIdx];
  const endRaw = plainToRaw[plainIdx + selectedText.length - 1];
  if (startRaw === undefined || endRaw === undefined) return null;

  return { start: startRaw, end: endRaw + 1 };
}

// 虚拟 nut/followup 的固定 ID
const PENDING_NUT_ID = '__pending_nut__';
const PENDING_FOLLOWUP_ID = '__pending_followup__';

// ═══════════════════════════════════════════════════════════════
// ResponseArea 主组件
// ═══════════════════════════════════════════════════════════════
export default function ResponseArea({
  nodeId,
  responses,
  followupChildren,
  immersive,
  streamingResponses,
  isStreamingNode,
  suppressModelChipAnimation = false,
}: Props) {
  const language = useLanguage();
  const t = useT();
  const models = useAppStore(s => s.models);
  const visibleModels = (() => {
    return models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => model.deleted !== 1)
      .sort((a, b) => {
        const usageDiff = (b.model.recent_usage_count || 0) - (a.model.recent_usage_count || 0);
        if (usageDiff !== 0) return usageDiff;
        const tokenDiff = (b.model.recent_token_usage || 0) - (a.model.recent_token_usage || 0);
        if (tokenDiff !== 0) return tokenDiff;
        return a.index - b.index;
      })
      .map(({ model }) => model);
  })();
  const activeModelId = useAppStore(s => s.activeModelId);
  const setActiveModelId = useAppStore(s => s.setActiveModelId);
  const sendingMessage = useAppStore(s => s.sendingMessage);
  const sendMessage = useAppStore(s => s.sendMessage);
  const currentRootId = useAppStore(s => s.currentRootId);
  const selectedModelIds = useAppStore(s => s.selectedModelIds);
  const setSelectedModelIds = useAppStore(s => s.setSelectedModelIds);
  const followupVisibleModels = useMemo(() => {
    const selectedIds = new Set(selectedModelIds);
    return models
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => model.deleted !== 1)
      .sort((a, b) => {
        const selectedDiff = Number(selectedIds.has(b.model.id)) - Number(selectedIds.has(a.model.id));
        if (selectedDiff !== 0) return selectedDiff;
        const usageDiff = (b.model.recent_usage_count || 0) - (a.model.recent_usage_count || 0);
        if (usageDiff !== 0) return usageDiff;
        const tokenDiff = (b.model.recent_token_usage || 0) - (a.model.recent_token_usage || 0);
        if (tokenDiff !== 0) return tokenDiff;
        return a.index - b.index;
      })
      .map(({ model }) => model);
  }, [models, selectedModelIds]);
  const webSearchEnabled = useAppStore(s => s.webSearchEnabled);
  const setWebSearchEnabled = useAppStore(s => s.setWebSearchEnabled);
  const thinkingBudgets = useAppStore(s => s.thinkingBudgets);
  const setThinkingBudget = useAppStore(s => s.setThinkingBudget);
  const addModelToNode = useAppStore(s => s.addModelToNode);
  const deleteResponse = useAppStore(s => s.deleteResponse);
  const deleteNode = useAppStore(s => s.deleteNode);
  const collapsedSet = useAppStore(s => s.collapsedSet);
  const toggleCollapse = useAppStore(s => s.toggleCollapse);
  const focusNode = useAppStore(s => s.focusNode);
  const getDeepestPathModels = useAppStore(s => s.getDeepestPathModels);
  const searchScrollTarget = useAppStore(s => s.searchScrollTarget);

  // ━━━ 文本选择追问状态 ━━━
  // selectionInfo: 当前选中文字的位置+元信息
  // showFollowupInput: 是否展开追问输入框 (tooltip → popup)
  // savedSelectionRef: 保存原始 Range 用于 useLayoutEffect 恢复选区
  // selectionInfoRef: Ref 版 selectionInfo, 避免 useEffect 闭包过期
  // scrollTick: 滚动计数器, 触发 tooltip 位置跟随重算
  // lastTouchTimeRef: 移动端 touchend 时间, 防合成 mousedown 误清除
  // 选中文本追问状态
  const [selectionInfo, setSelectionInfo] = useState<{
    text: string;
    viewportX: number;          // 选区末尾字符的视口 X（固定不变）
    viewportY: number;          // 选区末尾字符的视口 Y（需+滚动偏移补偿）
    scrollTopAtSelect: number;  // 选中时的 scrollTop，用于滚动补偿
    responseId: string;
    modelId: string;
  } | null>(null);
  const [followupInput, setFollowupInput] = useState('');
  const [showFollowupInput, setShowFollowupInput] = useState(false);
  const responseAreaRef = useRef<HTMLDivElement>(null);
  const pendingHighlightRef = useRef<Range | null>(null);
  const [sendingFollowup, setSendingFollowup] = useState(false);
  const [thinkingPopoverFor, setThinkingPopoverFor] = useState<string | null>(null);
  const [thinkingPopoverPosition, setThinkingPopoverPosition] = useState<{ left: number; bottom: number } | null>(null);
  const [showAddModelMenu, setShowAddModelMenu] = useState(false);
  const [deletingResponseId, setDeletingResponseId] = useState<string | null>(null);
  const addModelMenuRef = useRef<HTMLDivElement>(null);
  const addModelBtnRef = useRef<HTMLButtonElement>(null);
  const followupToolRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const previousFollowupToolLayoutRef = useRef<{
    rects: Map<string, DOMRect>;
    order: Map<string, number>;
    selectedIds: Set<string>;
  } | null>(null);

  const [addModelMenuPos, setAddModelMenuPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const currentRects = new Map<string, DOMRect>();
    const currentOrder = new Map<string, number>();

    followupVisibleModels.forEach((model, index) => {
      const element = followupToolRefs.current.get(model.id);
      if (!element) return;
      currentRects.set(model.id, element.getBoundingClientRect());
      currentOrder.set(model.id, index);
    });

    const previousLayout = previousFollowupToolLayoutRef.current;
    const currentSelectedIds = new Set(selectedModelIds);
    if (previousLayout) {
      const selectionChanged =
        previousLayout.selectedIds.size !== currentSelectedIds.size ||
        selectedModelIds.some(id => !previousLayout.selectedIds.has(id));

      if (selectionChanged) {
        followupVisibleModels.forEach((model, index) => {
          const previousIndex = previousLayout.order.get(model.id);
          if (previousIndex === undefined || previousIndex === index) return;

          const element = followupToolRefs.current.get(model.id);
          const previousRect = previousLayout.rects.get(model.id);
          const currentRect = currentRects.get(model.id);
          if (!element || !previousRect || !currentRect) return;

          const deltaX = previousRect.left - currentRect.left;
          if (deltaX === 0) return;

          element.getAnimations().forEach(animation => animation.cancel());
          element.animate(
            [
              { transform: `translateX(${deltaX}px)` },
              { transform: 'translateX(0)' },
            ],
            {
              duration: 320,
              easing: 'cubic-bezier(0.2, 0, 0, 1)',
            },
          );
        });
      }
    }

    previousFollowupToolLayoutRef.current = {
      rects: currentRects,
      order: currentOrder,
      selectedIds: currentSelectedIds,
    };
  }, [followupVisibleModels, selectedModelIds]);

  useEffect(() => {
    if (showAddModelMenu && addModelBtnRef.current) {
      const updatePos = () => {
        if (addModelBtnRef.current) {
          const rect = addModelBtnRef.current.getBoundingClientRect();
          const estWidth = 260;
          const margin = 8;
          const left = Math.min(rect.left, window.innerWidth - estWidth - margin);
          setAddModelMenuPos({ top: rect.bottom + 4, left: Math.max(margin, left) });
        }
      };
      updatePos();
      const chatArea = responseAreaRef.current?.closest('.chat-area');
      if (chatArea) chatArea.addEventListener('scroll', updatePos, { passive: true });
      window.addEventListener('scroll', updatePos, { passive: true });
      window.addEventListener('resize', updatePos, { passive: true });
      return () => {
        if (chatArea) chatArea.removeEventListener('scroll', updatePos);
        window.removeEventListener('scroll', updatePos);
        window.removeEventListener('resize', updatePos);
      };
    }
  }, [showAddModelMenu]);

  // 关闭下拉菜单（点击外部）
  useEffect(() => {
    if (!showAddModelMenu) return;
    const handler = (e: MouseEvent) => {
      if (addModelMenuRef.current && !addModelMenuRef.current.contains(e.target as HTMLElement) &&
          addModelBtnRef.current && !addModelBtnRef.current.contains(e.target as HTMLElement)) {
        setShowAddModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddModelMenu]);
  const popoverRef = useRef<HTMLDivElement>(null);
  const thinkingPopoverTriggerRef = useRef<HTMLElement | null>(null);
  const suppressNextFollowupThinkingClickRef = useRef(false);

  // 点击外部 → 关闭 popover
  useEffect(() => {
    if (!thinkingPopoverFor) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        !thinkingPopoverTriggerRef.current?.contains(target)
      ) {
        thinkingPopoverTriggerRef.current = null;
        setThinkingPopoverFor(null);
        setThinkingPopoverPosition(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [thinkingPopoverFor]);

  const getMobileThinkingPopoverPosition = (target: HTMLElement) => {
    if (!isMobile) return null;
    const rect = target.getBoundingClientRect();
    const popoverHalfWidth = 100;
    const edgePadding = 14;
    const left = Math.min(
      window.innerWidth - edgePadding - popoverHalfWidth,
      Math.max(edgePadding + popoverHalfWidth, rect.left + rect.width / 2),
    );
    return {
      left,
      bottom: Math.max(92, window.innerHeight - rect.top + 8),
    };
  };

  const toggleThinkingPopover = (modelId: string, target: HTMLElement) => {
    const isClosing = thinkingPopoverFor === modelId;
    thinkingPopoverTriggerRef.current = isClosing ? null : target;
    setThinkingPopoverFor(isClosing ? null : modelId);
    setThinkingPopoverPosition(isClosing ? null : getMobileThinkingPopoverPosition(target));
  };

  const openFollowupThinkingPopoverFromTouch = (modelId: string, target: HTMLElement) => {
    suppressNextFollowupThinkingClickRef.current = true;
    thinkingPopoverTriggerRef.current = target;
    setThinkingPopoverFor(modelId);
    setThinkingPopoverPosition(getMobileThinkingPopoverPosition(target));
  };

  const getModelThinkingLevels = (model: { provider: string; model_name: string }): ThinkingLevel[] | undefined => {
    return getThinkingLevels(model.provider, model.model_name);
  };

  const renderFollowupThinkingPopover = (
    modelId: string,
    thinkingLevels: ThinkingLevel[],
    currentBudget: number,
  ) => {
    const popover = (
      <div
        className={`thinking-popover${thinkingPopoverPosition ? ' mobile-fixed' : ''}`}
        ref={popoverRef}
        style={thinkingPopoverPosition ? {
          left: thinkingPopoverPosition.left,
          bottom: thinkingPopoverPosition.bottom,
        } : undefined}
      >
        <div className="thinking-popover-title"><Activity size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} /> {t('thinkingDepth')}</div>
        {thinkingLevels.map(level => (
          <button
            key={level.budget}
            className={`thinking-level-btn ${currentBudget === level.budget ? 'active' : ''}`}
            onClick={() => {
              setThinkingBudget(modelId, level.budget);
              thinkingPopoverTriggerRef.current = null;
              setThinkingPopoverFor(null);
              setThinkingPopoverPosition(null);
            }}
          >
            <span className="thinking-level-label">{localizeThinkingLabel(level.label, language)}</span>
            <span className="thinking-level-desc">{localizeThinkingDescription(level.description, language)}</span>
          </button>
        ))}
        <button
          className="thinking-level-btn"
          onClick={() => {
            setThinkingBudget(modelId, 0);
            thinkingPopoverTriggerRef.current = null;
            setThinkingPopoverFor(null);
            setThinkingPopoverPosition(null);
          }}
        >
          <X size={12} style={{ verticalAlign: '-2px', marginRight: 3 }} /> {t('disableThinking')}
        </button>
      </div>
    );

    return thinkingPopoverPosition ? createPortal(popover, document.body) : popover;
  };

  const savedSelectionRef = useRef<Range | null>(null);
  // 用 ref 追踪 selectionInfo，避免在 effect 回调中读取过期闭包值
  const selectionInfoRef = useRef(selectionInfo);
  selectionInfoRef.current = selectionInfo;
  // 滚动时触发重渲染，使 tooltip 位置跟随文字
  const [scrollTick, setScrollTick] = useState(0);

  // ── 流式完成后保留最终态（思考区 + ✓完成 badge） ──
  const [completedStreaming, setCompletedStreaming] = useState<Record<string, import('../types').StreamingResponse>>({});
  useEffect(() => {
    if (streamingResponses) {
      // 记录所有 done/error 的流式响应，清除还在流式的
      const done: Record<string, import('../types').StreamingResponse> = {};
      let hasDone = false;
      for (const [mid, sr] of Object.entries(streamingResponses)) {
        if (sr.status === 'done' || sr.status === 'error') {
          done[mid] = { ...sr };
          hasDone = true;
        }
      }
      if (hasDone) {
        setCompletedStreaming(prev => ({ ...prev, ...done }));
      }
    }
  }, [streamingResponses]);

  // ── 加载已完成回复的思考内容（从 response.meta.thinking_content 提取） ──
  // 流式直播时由 streamingResponses 驱动；侧边栏打开已完成问题树时此处兜底
  useEffect(() => {
    if (!streamingResponses || Object.keys(streamingResponses).length === 0) {
      const completed: Record<string, import('../types').StreamingResponse> = {};
      for (const resp of responses) {
        try {
          const meta = JSON.parse(resp.meta || '{}');
          if (meta.thinking_content) {
            completed[resp.model_id] = {
              thinking: meta.thinking_content,
              content: resp.content,
              status: 'done',
            };
          }
        } catch { /* meta 解析失败跳过 */ }
      }
      if (Object.keys(completed).length > 0) {
        setCompletedStreaming(completed);
      }
    }
  }, [responses, streamingResponses]);

  // ── 移动端：记录最后一次 touchend 时间 ──
  const lastTouchTimeRef = useRef(0);

  // ── 移动端检测 ──
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ── 保持浏览器原生选区：React 重渲染可能清除选区 → 用 useLayoutEffect 恢复 ──
  // ━━━ 保持浏览器原生选区 (React 重渲染可能清除选区) ━━━
  // useLayoutEffect 在 DOM 更新后、浏览器绘制前同步执行
  // 恢复 savedSelectionRef 中的 Range → ::selection CSS 生效 → 蓝色高亮可见
  // 如果 Range 已失效 (text 节点被替换) → 静默失败
  useLayoutEffect(() => {
    if (selectionInfo && savedSelectionRef.current) {
      try {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(savedSelectionRef.current);
        }
      } catch {
        // Range 可能已失效（文本节点被 React 替换），静默失败
      }
    }
  }, [selectionInfo]);

  // ━━━ 滚动跟随 ━━━
  // 监听 .chat-area 滚动, 更新 scrollTick 触发 getTooltipPosition 重新计算
  // 公式: tooltipY = viewportY - (currentScrollTop - scrollTopAtSelect)
  // 监听 .chat-area 滚动，触发 tooltip 位置更新
  useEffect(() => {
    const chatArea = responseAreaRef.current?.closest('.chat-area') as HTMLElement | null;
    if (!chatArea) return;
    const onScroll = () => setScrollTick(t => t + 1);
    chatArea.addEventListener('scroll', onScroll);
    return () => chatArea.removeEventListener('scroll', onScroll);
  }, []);

  // 根据 selectionInfo 计算 tooltip 视口坐标（含滚动补偿）
  // 计算 tooltip 视口坐标 (含滚动补偿: y = viewportY - scrollDelta)
  const getTooltipPosition = useCallback((): { x: number; y: number } => {
    if (!selectionInfo) return { x: 0, y: 0 };
    // 获取当前滚动偏移
    const chatArea = responseAreaRef.current?.closest('.chat-area') as HTMLElement | null;
    const currentScrollTop = chatArea ? chatArea.scrollTop : 0;
    // Y 坐标补偿：滚动时内容的视口 Y = 初始Y - (当前scrollTop - 选中时scrollTop)
    const scrollDelta = currentScrollTop - selectionInfo.scrollTopAtSelect;
    return {
      x: selectionInfo.viewportX,
      y: selectionInfo.viewportY - scrollDelta,
    };
  }, [selectionInfo, scrollTick]); // scrollTick 变化触发重新计算

  // 追问发送后的 pending 状态：保存追问点信息，用于在劈开位置显示 loading
  const [pendingFollowup, setPendingFollowup] = useState<{
    text: string;
    responseId: string;
    modelId: string;
    followupContent: string;
  } | null>(null);

  // 追问框 hover 状态：当前高亮的 nut id
  const [hoveredNutId, setHoveredNutId] = useState<string | null>(null);

  // 获取模型显示名
  const getModelName = (modelId: string) => {
    const model = models.find(m => m.id === modelId);
    return model?.name || modelId;
  };
  const isDeletedModel = (modelId: string) => models.find(m => m.id === modelId)?.deleted === 1;

  // 模型选择栏：保留已有回复顺序，追加中的模型接在末尾。
  const streamingModelIds = streamingResponses ? Object.keys(streamingResponses) : [];
  const savedModelIds = responses.map(r => r.model_id);
  const savedActiveModelIds = savedModelIds.filter(mid => !isDeletedModel(mid));
  const savedDeletedModelIds = savedModelIds.filter(mid => isDeletedModel(mid));
  const streamingOnlyModelIds = streamingModelIds.filter(mid => !savedModelIds.includes(mid));
  const allModelIds = [
    ...new Set([
      ...savedActiveModelIds,
      ...streamingOnlyModelIds,
      ...savedDeletedModelIds,
    ]),
  ];

  // 当前激活的模型（优先 per-node activeModelId，其次排序后的可见顺序）
  const nodeActiveModelId = activeModelId[nodeId];
  const currentModelId = nodeActiveModelId && (
    responses.some(r => r.model_id === nodeActiveModelId) ||
    (streamingResponses && nodeActiveModelId in streamingResponses)
  )
    ? nodeActiveModelId
    : (allModelIds.length > 0 ? allModelIds[0] : null);

  // ── 将 followup 子节点按 parent_model_id 精确分组 ──
  const getFollowupsForModel = (modelId: string): Node[] => {
    return followupChildren.filter(c => c.parent_model_id === modelId);
  };

  // 没有 parent_model_id 的 followup（旧数据兼容）
  const unassignedFollowups = followupChildren.filter(c => !c.parent_model_id);

  // parent_model_id 不匹配任何 response 的孤儿 followup
  const responseModelIds = new Set(responses.map(r => r.model_id));
  const orphanFollowups = followupChildren.filter(
    c => c.parent_model_id && !responseModelIds.has(c.parent_model_id)
  );

  // ── 构建 nut_id → followup nodes 映射 ──
  const buildFollowupByNutId = (modelFollowups: Node[]): Map<string, Node[]> => {
    const map = new Map<string, Node[]>();
    for (const f of modelFollowups) {
      if (f.nut_id) {
        const existing = map.get(f.nut_id) || [];
        existing.push(f);
        map.set(f.nut_id, existing);
      }
    }
    return map;
  };

  // ── 计算被折叠的 followup nut IDs（用于波浪线显示） ──
  // 计算被折叠的 followup nut ID 集合 (用于波浪线显示)
  const getCollapsedNutIds = (modelFollowups: Node[]): Set<string> => {
    const ids = new Set<string>();
    for (const f of modelFollowups) {
      if (f.nut_id && collapsedSet.has(f.id)) {
        ids.add(f.nut_id);
      }
    }
    return ids;
  };

  // ── 折叠 nut 点击回调：展开该节点（不切换聚焦） ──
  const handleCollapsedNutClick = useCallback((nutId: string) => {
    // 找到该 nut 对应的 followup 节点，toggle 其折叠
    const findFollowupByNutId = (nodes: Node[]): Node | null => {
      for (const n of nodes) {
        if (n.nut_id === nutId) return n;
      }
      return null;
    };
    // 在所有 followupChildren 中找
    const node = findFollowupByNutId(followupChildren);
    if (node) {
      toggleCollapse(node.id);
    }
  }, [followupChildren, toggleCollapse]);

  // ── 渲染带嵌入 followup 的 response 内容 ──
  const renderContentWithInlineFollowups = (
    response: RespType,
    modelFollowups: Node[],
  ) => {
    const responseSearchHit = searchScrollTarget?.type === 'response'
      && searchScrollTarget.nodeId === nodeId
      && searchScrollTarget.modelId === response.model_id
      ? {
          query: searchScrollTarget.query,
          hitId: `search-${searchScrollTarget.requestId}`,
        }
      : null;

    let nuts = [...(response.nuts || [])];
    const followupByNutId = buildFollowupByNutId(modelFollowups);
    const collapsedNutIds = getCollapsedNutIds(modelFollowups);
    const pendingNutIds = new Set<string>();

    // ── 处理 pending followup：创建虚拟 nut 劈开原文 ──
    if (pendingFollowup && pendingFollowup.responseId === response.id) {
      const pos = findTextPosition(response.content, pendingFollowup.text);
      if (pos) {
        // 检查是否和已有 nut 重叠
        const overlap = nuts.some(n =>
          (n.seek <= pos.start && n.end_seek > pos.start) ||
          (n.seek < pos.end && n.end_seek >= pos.end)
        );
        if (!overlap) {
          nuts.push({
            id: PENDING_NUT_ID,
            response_id: response.id,
            seek: pos.start,
            end_seek: pos.end,
            label: pendingFollowup.text.slice(0, 50),
            style: null,
            meta: '{}',
            created_at: new Date().toISOString(),
          });
          // 创建虚拟 followup node（用于 loading 显示）
          followupByNutId.set(PENDING_NUT_ID, [{
            id: PENDING_FOLLOWUP_ID,
            content: pendingFollowup.followupContent,
            parent_id: nodeId,
            root_id: currentRootId || '',
            nut_id: PENDING_NUT_ID,
            parent_model_id: pendingFollowup.modelId,
            relation: 'followup',
            child_order: 0,
            search_enabled: null,
            attachments: '[]',
            summary: '',
            pinned: 0,
            archived: 0,
            group_id: null,
            group_order: null,
            meta: '{}',
            updated_at: new Date().toISOString(),
            children: [],
            responses: [],
            created_at: new Date().toISOString(),
          }] as Node[]);
          pendingNutIds.add(PENDING_NUT_ID);
        }
      }
    }

    const segments = splitContentAtNuts(response.content, nuts, followupByNutId);

    // 分离有 nut 和无 nut 的 followup
    const nutIds = new Set(nuts.map(n => n.id));
    const withNut = modelFollowups.filter(f => f.nut_id && nutIds.has(f.nut_id));
    const withoutNut = modelFollowups.filter(f => !f.nut_id || !nutIds.has(f.nut_id));

    return (
      <>
        {segments.map((seg, i) => {
          if (seg.type === 'markdown') {
            const segStart = seg.startOffset;
            const segEnd = seg.startOffset + seg.content.length;
            const nutsInSeg = immersive ? [] : nuts.filter(n => {
              return n.seek >= segStart && n.seek < segEnd;
            });
            return (
              <MarkdownContent
                key={`md-${i}`}
                content={seg.content}
                contentOffset={seg.startOffset}
                highlightedNuts={nutsInSeg}
                hoveredNutId={immersive ? null : hoveredNutId}
                collapsedNutIds={immersive ? new Set() : collapsedNutIds}
                pendingNutIds={immersive ? new Set() : pendingNutIds}
                onCollapsedNutClick={handleCollapsedNutClick}
                searchQuery={responseSearchHit?.query}
                searchHitId={responseSearchHit?.hitId}
              />
            );
          } else {
            const isPending = seg.nut.id === PENDING_NUT_ID;

            // ── pending followup：在劈开位置显示 loading ──
            if (isPending) {
              return (
                <div key={`fu-${i}`} className="followup-inline followup-loading">
                  <div className="followup-inline-anchor">
                    <span className="followup-inline-icon"><ArrowRightFromLine size={14} /></span>
                    <span className="followup-inline-label" style={{ color: 'var(--megaform-text-secondary)', fontStyle: 'italic' }}>
                      正在思考...
                    </span>
                  </div>
                  <div className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              );
            }

            // followup 嵌入块
            const allCollapsed = seg.nodes.every(n => collapsedSet.has(n.id));

            if (allCollapsed) {
              return (
                <div
                  key={`fu-${i}`}
                  className="followup-inline followup-inline-collapsed"
                  data-nut-id={seg.nut.id}
                  onMouseEnter={() => setHoveredNutId(seg.nut.id)}
                  onMouseLeave={() => setHoveredNutId(null)}
                >
                  {seg.nodes.map(child => (
                    <NodeCard
                      key={child.id}
                      node={child}
                      depth={1}
                      suppressEnterAnimation={suppressModelChipAnimation}
                    />
                  ))}
                </div>
              );
            }

            return (
              <div
                key={`fu-${i}`}
                className="followup-inline"
                data-nut-id={seg.nut.id}
                onMouseEnter={() => setHoveredNutId(seg.nut.id)}
                onMouseLeave={() => setHoveredNutId(null)}
              >
                <div className="followup-inline-anchor">
                  <span className="followup-inline-icon"><ArrowRightFromLine size={14} /></span>
                  {seg.nut.label && (
                    <span className="followup-inline-label">
                      「<MarkdownContent content={seg.nut.label} inline />」
                    </span>
                  )}
                  {seg.nodes.length > 0 && seg.nodes[0].parent_model_id && (
                    <span className="followup-inline-model">
                      {getModelName(seg.nodes[0].parent_model_id)}
                    </span>
                  )}
                </div>
                {seg.nodes.map(child => (
                  <NodeCard
                    key={child.id}
                    node={child}
                    depth={1}
                    suppressEnterAnimation={suppressModelChipAnimation}
                  />
                ))}
              </div>
            );
          }
        })}
        {withoutNut.length > 0 && (
          <div className="followup-children">
            {withoutNut.map(child => (
              <NodeCard
                key={child.id}
                node={child}
                depth={1}
                suppressEnterAnimation={suppressModelChipAnimation}
              />
            ))}
          </div>
        )}
      </>
    );
  };

  // ── 监听文本选择（document 级别，避免鼠标在区域外松开时丢失事件） ──
  useEffect(() => {
    if (immersive) return;

    // 标记：是否刚刚设置了 selectionInfo，避免 selectionchange 清除刚设的值
    let justSetSelection = false;

    // ━━━ detectSelection — 核心: 检测文本选择并设置 tooltip 状态 ━━━
    // 仅在选区非空、选区内有文字、选区在当前 ResponseArea 内时激活
    // 记录 viewportX/Y + scrollTopAtSelect 用于后续滚动补偿
    const detectSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        return;
      }

      const selectedText = getFollowupSelectionText(selection);
      if (!selectedText) return;

      const anchorNode = selection.anchorNode;
      if (!anchorNode) return;

      const element = anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
      if (!element) return;

      // 检查选区是否在当前组件的 .response-area 内
      const closestArea = element.closest('.response-area');
      if (!closestArea) return;
      // 用唯一 ID 匹配：确保是当前组件实例的 response-area
      if (closestArea !== responseAreaRef.current) return;

      const responseCard = element.closest('.response-card');
      if (!responseCard) return;

      const modelId = responseCard.getAttribute('data-model-id');
      const responseId = responseCard.getAttribute('data-response-id');
      if (!modelId) return;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      // 获取选区最后一个字符的视口位置（用于定位 tooltip）
      let viewportX = rect.right;
      let viewportY = rect.bottom + 6;
      if (range.endOffset > 0 && range.endContainer.nodeType === Node.TEXT_NODE) {
        try {
          const endRange = document.createRange();
          endRange.setStart(range.endContainer, range.endOffset - 1);
          endRange.setEnd(range.endContainer, range.endOffset);
          const endRect = endRange.getBoundingClientRect();
          if (endRect.width > 0) {
            viewportX = endRect.right;
            viewportY = endRect.bottom + 6;
          }
        } catch {
          // fallback to full rect
        }
      }

      // 获取当前滚动偏移（用于滚动补偿）
      const chatArea = element.closest('.chat-area') as HTMLElement | null;
      const scrollTopAtSelect = chatArea ? chatArea.scrollTop : 0;

      // 用 CSS Custom Highlight API 在不修改 DOM 的情况下高亮选中文字
      try {
        const highlightRange = range.cloneRange();
        const highlight = new Highlight(highlightRange);
        CSS.highlights.set('selection-tooltip-highlight', highlight);
      } catch {
        // 浏览器不支持 Custom Highlight API，回退到浏览器原生的 ::selection 样式
      }

      // 保存选区的 Range 引用，tooltip 显示期间持续恢复选区（防止 React 重渲染清除）
      savedSelectionRef.current = range.cloneRange();

      justSetSelection = true;
      setSelectionInfo({
        text: selectedText,
        viewportX,
        viewportY,
        scrollTopAtSelect,
        responseId: responseId || '',
        modelId,
      });
      // 短暂标记，防止 selectionchange 立刻清除
      setTimeout(() => { justSetSelection = false; }, 100);
    };

    const handleDocMouseUp = () => {
      detectSelection();
    };

    // ━━━ 移动端触摸处理 ━━━
    // touchstart → isTouching=true (阻止 selectionchange 在触摸过程中触发)
    // touchend → 300ms 延迟 → detectSelection() (等浏览器选区稳定)
    // 移动端：触摸选文字后触发 touchend
    let touchTimer: ReturnType<typeof setTimeout> | null = null;
    let isTouching = false;
    const handleTouchStart = () => { isTouching = true; };
    const handleTouchEnd = () => {
      isTouching = false;
      lastTouchTimeRef.current = Date.now();
      // 延迟一小段时间，等选区稳定后再检测
      if (touchTimer) clearTimeout(touchTimer);
      touchTimer = setTimeout(() => {
        detectSelection();
        touchTimer = null;
      }, 300);
    };

    // 备用：selectionchange 事件捕获键盘选中等其他方式
    const handleSelectionChange = () => {
      if (justSetSelection) return;
      // 触摸过程中不处理 — 等 touchend 后再检测，避免频繁 re-render 打断选文字
      if (isTouching) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        // 选区消失 — 不立即清除 tooltip（可能只是 React 重渲染导致暂时消失）
        // 用户点击其他地方时由 handleClick 清除
        return;
      }
      // tooltip 已显示 → 不再触发检测，避免 re-render 循环清除浏览器选区
      if (selectionInfoRef.current) return;
      // 有非空选区且 tooltip 未显示 → 触发检测（兜底桌面端键盘选择等场景）
      detectSelection();
    };

    document.addEventListener('mouseup', handleDocMouseUp);
    document.addEventListener('touchstart', handleTouchStart);
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('mouseup', handleDocMouseUp);
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('selectionchange', handleSelectionChange);
      if (touchTimer) clearTimeout(touchTimer);
    };
  }, [immersive, showFollowupInput]);

  // 点击"追问容器"之外的区域 → 关闭 tooltip 或输入弹窗
  useEffect(() => {
    // 点击追问容器外部 → 关闭 tooltip/popup (移动端 500ms 内忽略合成 mousedown)
    const handleClickAway = (e: MouseEvent) => {
      const target = e.target as Element;
      // 点击追问容器内部时不关闭
      if (target.closest('.followup-container')) return;
      if (target.closest('.followup-input-popup')) return;
      if (target.closest('.thinking-popover')) return;
      // 移动端：touchend 后浏览器会合成 mousedown，在 500ms 内忽略，防止选中文字后 tooltip 被立即清除
      if (Date.now() - lastTouchTimeRef.current < 500) return;
      // 有 selectionInfo 就清除（tooltip 或输入弹窗都统一关闭）
      if (selectionInfo) {
        setSelectionInfo(null);
        setShowFollowupInput(false);
        setFollowupInput('');
        window.getSelection()?.removeAllRanges();
        try { CSS.highlights.delete('selection-tooltip-highlight'); } catch {}
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [selectionInfo]);

  // 追问处理
  // 点击 tooltip → 展开追问输入框
  const handleFollowupAsk = () => {
    if (!selectionInfo) return;
    // CSS Custom Highlight 已在 detectSelection 中设置，只需标记 pending
    pendingHighlightRef.current = true as any;
    setShowFollowupInput(true);
    setFollowupInput('');
  };

  // 清除选区高亮
  const clearPendingHighlight = useCallback(() => {
    // 清除 CSS Custom Highlight
    try { CSS.highlights.delete('selection-tooltip-highlight'); } catch {}
    // 清除旧式的 .selection-pending-highlight span（追问确认时创建的）
    const spans = responseAreaRef.current?.querySelectorAll('.selection-pending-highlight');
    spans?.forEach(span => {
      const parent = span.parentNode;
      if (parent) {
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
      }
    });
    pendingHighlightRef.current = null;
  }, []);

  // 发送追问: 创建 pendingFollowup (loading 态) → API 调用 → 创建 followup 节点
  const submitFollowup = async () => {
    if (!selectionInfo || !currentRootId) return;

    const savedFollowupInput = followupInput.trim()
      ? followupInput
      : t('defaultFollowupExplainMeaning');
    const savedSelectionInfo = { ...selectionInfo };

    setSendingFollowup(true);
    setPendingFollowup({
      text: savedSelectionInfo.text,
      responseId: savedSelectionInfo.responseId,
      modelId: savedSelectionInfo.modelId,
      followupContent: savedFollowupInput,
    });

    // 清除 UI 状态
    clearPendingHighlight();
    setSelectionInfo(null);
    setShowFollowupInput(false);
    setFollowupInput('');

    try {
      await sendMessage(savedFollowupInput, {
        rootId: currentRootId,
        parentId: nodeId,
        relation: 'followup',
        partialContent: savedSelectionInfo.text,
        parentModelId: savedSelectionInfo.modelId,
        modelIds: selectedModelIds.length > 0 ? selectedModelIds : undefined,
        webSearch: webSearchEnabled,
      });
    } finally {
      setSendingFollowup(false);
      setPendingFollowup(null);
    }
  };

  // 渲染单个 response card
  const renderResponseCard = (
    response: RespType,
    modelFollowups: Node[],
    streamingResp?: import('../types').StreamingResponse,
  ) => {
    const s = streamingResp;
    const isStreaming = s?.status === 'thinking' || s?.status === 'responding';
    const isThinking = s?.status === 'thinking';
    const isResponding = s?.status === 'responding';
    const isDone = s?.status === 'done';
    const isError = s?.status === 'error';

    return (
      <div
        className={`response-card ${isDone ? 'response-completed' : ''}`}
        key={response.model_id}
        data-model-id={response.model_id}
        data-response-id={response.id}
        data-response-anchor={`${response.node_id}:${response.model_id}`}
      >
        {/* 流式状态栏：思考过程 */}
        {!!s && s!.thinking && (
          <ThinkingSection
            thinking={s!.thinking}
            isThinking={isThinking}
            label={t('thinkingProcess')}
          />
        )}

        {/* 正文内容：流式/刚完成时用 streaming content，否则用保存的 */}
        <div className="response-content">
          {(isStreaming || isDone) && !response.tokens_input ? (
            <>
              <MarkdownContent content={s!.content} streaming={isThinking || isResponding} />
              {(isThinking || isResponding) && <span className="streaming-cursor-inline">▌</span>}
            </>
          ) : (
            renderContentWithInlineFollowups(response, modelFollowups)
          )}
        </div>

        {/* Token 统计：仅在非流式时显示 */}
        {!isStreaming && (
          <div className="token-stats">
            <span>{t('inputTokens')} {response.tokens_input.toLocaleString()}</span>
            <span>{t('outputTokens')} {response.tokens_output.toLocaleString()}</span>
            {response.latency_ms != null && (
              <span>{(response.latency_ms / 1000).toFixed(1)}s</span>
            )}
          </div>
        )}

        {/* 流式错误信息 */}
        {isError && s!.error && (
          <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{s!.error}</div>
        )}
      </div>
    );
  };

  // 渲染所有 response cards（含流式）
  const renderAllResponses = () => {
    if (!currentModelId) return null;

    // 流式响应
    const streamingResp = streamingResponses?.[currentModelId];
    if (streamingResp) {
      // 流式模型：创建虚拟 response 对象
      const virtualResp: RespType = {
        id: `streaming-${currentModelId}`,
        node_id: nodeId,
        model_id: currentModelId,
        model_name: streamingResp.model_name || getModelName(currentModelId),
        content: streamingResp.content,
        status: streamingResp.status === 'error' ? 'error' : 'completed',
        tokens_input: 0,
        tokens_output: 0,
        latency_ms: null,
        finish_reason: null,
        sources: '[]',
        meta: '{}',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return renderResponseCard(virtualResp, [], streamingResp);
    }

    // 保存的响应
    const activeResponse = responses.find(r => r.model_id === currentModelId);
    if (!activeResponse) return null;

    const activeFollowups = getFollowupsForModel(currentModelId);
    const allFollowups = [...activeFollowups, ...unassignedFollowups, ...orphanFollowups];

    // 若有已完成的流式状态，保留思考区和 ✓完成 badge
    const completed = completedStreaming[currentModelId];
    return renderResponseCard(activeResponse, allFollowups, completed);
  };

  // 默认选中第一个流式模型
  const effectiveCurrentModelId = currentModelId || (allModelIds.length > 0 ? allModelIds[0] : null);

  // 如果 currentModelId 为空且有流式模型，自动设置
  useEffect(() => {
    if (!currentModelId && streamingModelIds.length > 0) {
      setActiveModelId(nodeId, streamingModelIds[0]);
    }
  }, [currentModelId, streamingModelIds, setActiveModelId, nodeId]);

  // 模型名查找（优先 streaming model_name，再查 models store）
  const getModelNameForBar = (modelId: string): string => {
    if (streamingResponses?.[modelId]?.model_name) return streamingResponses[modelId].model_name;
    return getModelName(modelId);
  };

  const handleDeleteResponse = async (response: RespType) => {
    if (deletingResponseId) return;
    const isLastResponse = responses.length <= 1;
    if (isLastResponse && !window.confirm(t('lastResponseDeleteConfirm'))) {
      return;
    }

    setDeletingResponseId(response.id);
    try {
      if (isLastResponse) {
        await deleteNode(nodeId);
      } else {
        await deleteResponse(nodeId, response.id, response.model_id);
      }
    } finally {
      setDeletingResponseId(null);
    }
  };

  // ── 最深路径指示 ──
  // 计算从当前节点出发的最深树路径，用于在 model-chip 上显示橙色小点
  const rootTree = useAppStore(s => s.rootTree);
  const currentTreeNode = useMemo(() => {
    if (!rootTree) return null;
    const queue = [...rootTree];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node.id === nodeId) return node;
      if (node.children?.length) queue.push(...node.children);
    }
    return null;
  }, [nodeId, rootTree]);
  const deepestPathSet = useMemo(() => {
    // 只有节点有子节点时才计算（没有子节点就没有"路径"）
    if (!currentTreeNode?.children?.length) return new Set<string>();
    return getDeepestPathModels(nodeId);
  }, [nodeId, currentTreeNode, getDeepestPathModels]);

  return (
    <div className="response-area" ref={responseAreaRef} style={{ WebkitTouchCallout: 'none' }}>
      {/* 模型选择栏 */}
      <div className="model-bar" data-frozen-anchor={nodeId}>
        <AnimatePresence initial={false} mode="popLayout">
          {allModelIds.map(mid => {
            const isActive = mid === effectiveCurrentModelId || (!effectiveCurrentModelId && mid === allModelIds[0]);
            const isStreamingModel = streamingModelIds.includes(mid);
            const isDeleted = isDeletedModel(mid);
            const savedResponse = responses.find(r => r.model_id === mid);
            const isOnDeepestPath = deepestPathSet.has(`${nodeId}:${mid}`);
            const isActivelyStreaming = isStreamingModel && (
              streamingResponses?.[mid]?.status === 'thinking' ||
              streamingResponses?.[mid]?.status === 'responding'
            );
            return (
              <motion.span
                className="model-chip-wrap"
                key={mid}
                layout={!suppressModelChipAnimation}
                initial={suppressModelChipAnimation ? false : { opacity: 0, scale: 0.92, y: -3 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={suppressModelChipAnimation ? { opacity: 0 } : { opacity: 0, scale: 0.78, y: -8 }}
                transition={suppressModelChipAnimation ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 34, mass: 0.55 }}
              >
                <button
                  data-model-id={mid}
                  className={`model-chip ${isActive ? 'active' : ''} ${isActivelyStreaming ? 'model-streaming' : ''} ${isDeleted ? 'deleted-model' : ''}`}
                  onClick={() => setActiveModelId(nodeId, mid)}
                  title={isDeleted ? t('deletedModelTitle') : undefined}
                >
                  {isActivelyStreaming && (
                    <svg className="model-chip-border" aria-hidden="true" focusable="false">
                      <rect className="model-chip-border-line" pathLength="100" />
                      <rect className="model-chip-border-line model-chip-border-line-alt" pathLength="100" />
                    </svg>
                  )}
                  <span className="model-chip-content">
                    {getModelNameForBar(mid)}
                    {isStreamingModel && (
                      <span className="streaming-dot" style={{
                        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                        background: streamingResponses?.[mid]?.status === 'done' ? 'var(--megaform-stone-600)' :
                                  streamingResponses?.[mid]?.status === 'error' ? '#ef4444' : 'var(--megaform-accent)',
                        marginLeft: 4, animation: streamingResponses?.[mid]?.status === 'done' ? 'none' : 'pulse 1s infinite',
                      }} />
                    )}
                    {!isStreamingModel && isOnDeepestPath && (
                      <span className="deepest-path-dot" title={t('deepestPath')} />
                    )}
                  </span>
                </button>
                {savedResponse && !isStreamingModel && (
                  <button
                    type="button"
                    className="model-chip-delete"
                    title={t('deleteModelResponse')}
                    aria-label={t('deleteModelResponseAria', { model: getModelNameForBar(mid) })}
                    disabled={deletingResponseId === savedResponse.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteResponse(savedResponse);
                    }}
                  >
                    <X size={11} strokeWidth={2.4} />
                  </button>
                )}
              </motion.span>
            );
          })}
        </AnimatePresence>

        {/* ── 追加模型按钮 ── */}
        <div style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          ref={addModelBtnRef}
          className="add-model-btn"
          onClick={() => setShowAddModelMenu(v => !v)}
          title={t('addModelResponse')}
        >
          <Plus size={14} />
        </button>

        {showAddModelMenu && createPortal(
          <div 
            ref={addModelMenuRef} 
            className="add-model-menu"
            style={{
              position: 'fixed',
              top: addModelMenuPos.top,
              left: addModelMenuPos.left,
              zIndex: 10000
            }}
          >
            <div className="add-model-menu-title">
              <span>{t('chooseModelAppend')}</span>
              <button
                className={`add-model-search-btn ${webSearchEnabled ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setWebSearchEnabled(!webSearchEnabled); }}
                title={webSearchEnabled ? t('webSearchEnabled') : t('enableWebSearch')}
              >
                <Search size={14} />
              </button>
            </div>
            {visibleModels
              .filter(m => !allModelIds.includes(m.id))
              .map(m => {
                const levels = getThinkingLevels(m.provider, m.model_name);
                return (
                  <div key={m.id} className="add-model-item">
                    <div
                      className="add-model-name"
                      onClick={() => {
                        const budget = thinkingBudgets[m.id] || 0;
                        addModelToNode(nodeId, m.id, budget, webSearchEnabled);
                        setShowAddModelMenu(false);
                      }}
                    >
                      {m.name}
                    </div>
                    {/* 思考强度选择（仅在有思考级别时显示） */}
                    {levels.length > 0 && (
                      <div className="add-model-thinking">
                        {[{ label: t('off'), budget: 0, description: t('noThinking') }, ...levels].map(lv => (
                          <button
                            key={lv.budget}
                            className={`add-model-thinking-btn ${(thinkingBudgets[m.id] || 0) === lv.budget ? 'selected' : ''}`}
                            title={localizeThinkingDescription(lv.description, language)}
                            onClick={(e) => {
                              e.stopPropagation();
                              setThinkingBudget(m.id, lv.budget);
                            }}
                          >
                            {localizeThinkingLabel(lv.label, language)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            {visibleModels.filter(m => !allModelIds.includes(m.id)).length === 0 && (
              <div className="add-model-empty">{t('allModelsAdded')}</div>
            )}
          </div>,
          document.body
        )}

        </div>

      </div>

      {renderAllResponses()}

      {/* 追问 tooltip + 输入弹窗 — 统一 Portal，变形动画 */}
      {selectionInfo && createPortal(
        (() => {
          const raw = getTooltipPosition();
          const margin = 10;

          // ━━━ 移动端: 追问输入栏渲染到屏幕底部 (全宽 bottom bar) ━━━
          // ── 移动端展开态：渲染到屏幕底部，替代原输入栏 ──
          if (isMobile && showFollowupInput) {
            return (
              <>
                <div className="followup-bottom-bar">
                  <div className="followup-bottom-inner">
                    <div className="followup-input-popup followup-mobile-composer">
                      <div className="followup-input-label">
                        <MarkdownContent content={t('followupFor', { text: getFollowupLabelPreview(selectionInfo.text) })} inline />
                      </div>
                      <textarea
                        value={followupInput}
                        onChange={e => setFollowupInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            submitFollowup();
                          }
                          if (e.key === 'Escape') {
                            clearPendingHighlight();
                            setSelectionInfo(null);
                            setShowFollowupInput(false);
                          }
                        }}
                        placeholder={t('followupPlaceholder')}
                        autoFocus
                        rows={2}
                        className="followup-composer-input"
                      />
                      <div className="followup-composer-toolbar">
                        <div className="followup-composer-tools">
                          {followupVisibleModels.map(m => {
                            const isSelected = selectedModelIds.includes(m.id);
                            const thinkingLevels = getModelThinkingLevels(m);
                            const currentBudget = thinkingBudgets[m.id] || 0;
                            const hasThinking = thinkingLevels && thinkingLevels.length > 0;

                            return (
                              <div
                                key={m.id}
                                className="followup-tool-wrap"
                                ref={(element) => {
                                  if (element) {
                                    followupToolRefs.current.set(m.id, element);
                                  } else {
                                    followupToolRefs.current.delete(m.id);
                                  }
                                }}
                              >
                                <button
                                  className={`model-chip followup-tool-chip ${isSelected ? 'active' : ''}`}
                                  onClick={() => {
                                    if (isSelected) {
                                      setSelectedModelIds(selectedModelIds.filter(id => id !== m.id));
                                    } else {
                                      setSelectedModelIds([...selectedModelIds, m.id]);
                                    }
                                  }}
                                >
                                  {m.name}
                                  {hasThinking && isSelected && currentBudget > 0 && (
                                    <span
                                      className={`thinking-indicator ${getThinkingDepthClass(thinkingLevels, currentBudget)}`}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onPointerUp={(e) => {
                                        if (e.pointerType === 'mouse') return;
                                        e.preventDefault();
                                        e.stopPropagation();
                                        openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                                      }}
                                      onTouchEnd={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (suppressNextFollowupThinkingClickRef.current) {
                                          suppressNextFollowupThinkingClickRef.current = false;
                                          return;
                                        }
                                        toggleThinkingPopover(m.id, e.currentTarget);
                                      }}
                                      title={t('adjustThinkingDepth', { label: localizeThinkingLabel(thinkingLevels?.find(l => l.budget === currentBudget)?.label || String(currentBudget), language) })}
                                    >
                                      <Activity size={13} />
                                    </span>
                                  )}
                                  {hasThinking && isSelected && currentBudget === 0 && (
                                    <span
                                      className="thinking-toggle-hint"
                                      onMouseDown={(e) => e.stopPropagation()}
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onPointerUp={(e) => {
                                        if (e.pointerType === 'mouse') return;
                                        e.preventDefault();
                                        e.stopPropagation();
                                        openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                                      }}
                                      onTouchEnd={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (suppressNextFollowupThinkingClickRef.current) {
                                          suppressNextFollowupThinkingClickRef.current = false;
                                          return;
                                        }
                                        toggleThinkingPopover(m.id, e.currentTarget);
                                      }}
                                      title={t('chooseThinkingDepth')}
                                    >
                                      <Activity size={13} />
                                    </span>
                                  )}
                                </button>

                                {thinkingPopoverFor === m.id && hasThinking && renderFollowupThinkingPopover(m.id, thinkingLevels!, currentBudget)}
                              </div>
                            );
                          })}
                        </div>
                        <div className="followup-composer-actions">
                          <button
                            className="followup-action-btn"
                            onClick={() => {
                              clearPendingHighlight();
                              setSelectionInfo(null);
                              setShowFollowupInput(false);
                            }}
                            title={t('close')}
                          >
                            <X size={16} />
                          </button>
                          <button
                            onClick={submitFollowup}
                            className="followup-send-btn"
                            title={t('send')}
                          >
                            <ArrowUp size={17} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div
                  className="followup-mobile-overlay"
                  onClick={() => {
                    clearPendingHighlight();
                    setSelectionInfo(null);
                    setShowFollowupInput(false);
                  }}
                />
              </>
            );
          }

          // ━━━ 桌面端 / 移动端折叠态: Portal 浮动 tooltip/popup ━━━
          // ── 桌面端 / 移动端折叠态 ──
          const popupWidth = showFollowupInput ? 360 : 100;
          const maxX = window.innerWidth - popupWidth - margin;
          const minX = margin;
          const clampedX = Math.min(Math.max(raw.x, minX), maxX);
          return (
        <div
          className={`followup-container ${showFollowupInput ? 'followup-expanded' : 'followup-collapsed'}`}
          style={{
            left: clampedX,
            top: Math.max(raw.y, margin),
          }}
        >
          {/* 折叠态：tooltip 小按钮 */}
          {!showFollowupInput && (
            <div
              className="selection-tooltip selection-tooltip-enter"
              onClick={handleFollowupAsk}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <ArrowRightFromLine size={14} /> {t('askFollowup')}
            </div>
          )}
          {/* 展开态：输入弹窗 */}
          {showFollowupInput && (
            <div className="followup-input-popup followup-expand-enter">
              <div className="followup-input-label">
                <MarkdownContent content={t('followupFor', { text: getFollowupLabelPreview(selectionInfo.text) })} inline />
              </div>
              <textarea
                value={followupInput}
                onChange={e => setFollowupInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submitFollowup();
                  }
                  if (e.key === 'Escape') {
                    clearPendingHighlight();
                    setSelectionInfo(null);
                    setShowFollowupInput(false);
                  }
                }}
                placeholder={t('followupPlaceholder')}
                autoFocus
                rows={2}
                className="followup-composer-input"
              />
              <div className="followup-composer-toolbar">
                <div className="followup-composer-tools">
                  {followupVisibleModels.map(m => {
                    const isSelected = selectedModelIds.includes(m.id);
                    const thinkingLevels = getModelThinkingLevels(m);
                    const currentBudget = thinkingBudgets[m.id] || 0;
                    const hasThinking = thinkingLevels && thinkingLevels.length > 0;

                    return (
                      <div
                        key={m.id}
                        className="followup-tool-wrap"
                        ref={(element) => {
                          if (element) {
                            followupToolRefs.current.set(m.id, element);
                          } else {
                            followupToolRefs.current.delete(m.id);
                          }
                        }}
                      >
                        <button
                          className={`model-chip followup-tool-chip ${isSelected ? 'active' : ''}`}
                          onClick={() => {
                            if (isSelected) {
                              setSelectedModelIds(selectedModelIds.filter(id => id !== m.id));
                            } else {
                              setSelectedModelIds([...selectedModelIds, m.id]);
                            }
                          }}
                          onContextMenu={(e) => {
                            if (hasThinking && isSelected) {
                              e.preventDefault();
                              toggleThinkingPopover(m.id, e.currentTarget);
                            }
                          }}
                        >
                          {m.name}
                          {hasThinking && isSelected && currentBudget > 0 && (
                            <span
                              className={`thinking-indicator ${getThinkingDepthClass(thinkingLevels, currentBudget)}`}
                              onMouseDown={(e) => e.stopPropagation()}
                              onPointerDown={(e) => e.stopPropagation()}
                              onPointerUp={(e) => {
                                if (e.pointerType === 'mouse') return;
                                e.preventDefault();
                                e.stopPropagation();
                                openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                              }}
                              onTouchEnd={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (suppressNextFollowupThinkingClickRef.current) {
                                  suppressNextFollowupThinkingClickRef.current = false;
                                  return;
                                }
                                toggleThinkingPopover(m.id, e.currentTarget);
                              }}
                              title={t('adjustThinkingDepth', { label: localizeThinkingLabel(thinkingLevels?.find(l => l.budget === currentBudget)?.label || String(currentBudget), language) })}
                            >
                              <Activity size={13} />
                            </span>
                          )}
                          {hasThinking && isSelected && currentBudget === 0 && (
                            <span
                              className="thinking-toggle-hint"
                              onMouseDown={(e) => e.stopPropagation()}
                              onPointerDown={(e) => e.stopPropagation()}
                              onPointerUp={(e) => {
                                if (e.pointerType === 'mouse') return;
                                e.preventDefault();
                                e.stopPropagation();
                                openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                              }}
                              onTouchEnd={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openFollowupThinkingPopoverFromTouch(m.id, e.currentTarget);
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (suppressNextFollowupThinkingClickRef.current) {
                                  suppressNextFollowupThinkingClickRef.current = false;
                                  return;
                                }
                                toggleThinkingPopover(m.id, e.currentTarget);
                              }}
                              title={t('chooseThinkingDepth')}
                              style={{ marginLeft: 2, cursor: 'pointer', opacity: 0.5, fontSize: 11 }}
                            >
                              <Activity size={13} style={{ verticalAlign: '-2px' }} />
                            </span>
                          )}
                        </button>

                        {thinkingPopoverFor === m.id && hasThinking && renderFollowupThinkingPopover(m.id, thinkingLevels!, currentBudget)}
                      </div>
                    );
                  })}
                  <button
                    className={`model-chip followup-tool-chip followup-search-chip ${webSearchEnabled ? 'active' : ''}`}
                    onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                    title={t('webSearch')}
                  >
                    <Search size={14} />
                  </button>
                </div>
                <div className="followup-composer-actions">
                  <button
                    className="followup-action-btn"
                    onClick={() => {
                      clearPendingHighlight();
                      setSelectionInfo(null);
                      setShowFollowupInput(false);
                    }}
                    title={t('close')}
                  >
                    <X size={16} />
                  </button>
                  <button
                    onClick={submitFollowup}
                    className="followup-send-btn"
                    title={t('send')}
                  >
                    <ArrowUp size={17} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
          );
        })(),
        document.body
      )}

      {/* 加载中 — 新消息（无 response 时） */}
      {sendingMessage && responses.length === 0 && !sendingFollowup && (
        <div className="response-card">
          <span style={{ fontSize: 12, color: 'var(--megaform-text-secondary)' }}>
            {t('waitingModel')}
          </span>
        </div>
      )}
    </div>
  );
}
