/**
 * ChatArea — 聊天主区域
 * 
 * 职责：
 * - 面包屑导航：展示当前聚焦节点在问题树中的路径
 * - 冻结区 (FrozenModelBar)：模型 tab 栏冻结在面包屑下方
 * - 聚焦节点切换动画（淡入淡出）
 * - 聚焦渲染：从 rootTree 中取出 focusedNodeId 对应的 NodeCard
 * - 折叠全部/展开全部 切换按钮
 * - 流式新问题树时的临时卡片渲染
 * - 空状态提示
 */
import React, { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ListChevronsDownUp } from 'lucide-react';
import { useAppStore } from '../store/appStore';
import NodeCard from './NodeCard';
import FrozenModelBar, { type FrozenEntry } from './FrozenModelBar';
import MarkdownContent from './MarkdownContent';
import type { Node, Nut } from '../types';
import { useT } from '../i18n';

const FREEZE_ENTER_OFFSET = 8;
const FREEZE_EXIT_OFFSET = 2;
type DrillDirection = 'drill-in' | 'drill-out' | 'replace';
type DrillMotionCustom = { direction: DrillDirection; skip: boolean };
type CameraPan = { x: number; y: number } | null;

const DRILL_EASE: [number, number, number, number] = [0.2, 0, 0, 1];
const CAMERA_PAN_MS = 260;
const BREADCRUMB_FIXED_HEIGHT = 60;
const FROZEN_BAR_FIXED_HEIGHT = 44;
const OVERLAY_GAP = 8;
const CHAT_AREA_FIXED_TOP_PADDING = BREADCRUMB_FIXED_HEIGHT + FROZEN_BAR_FIXED_HEIGHT + OVERLAY_GAP;

function getDrillX(direction: DrillDirection, phase: 'enter' | 'exit') {
  if (direction === 'drill-in') return phase === 'enter' ? 28 : -34;
  if (direction === 'drill-out') return phase === 'enter' ? -24 : 30;
  return 0;
}

function getDrillY(direction: DrillDirection, phase: 'enter' | 'exit') {
  if (direction === 'drill-in') return phase === 'enter' ? 8 : -10;
  if (direction === 'drill-out') return phase === 'enter' ? -6 : 8;
  return phase === 'enter' ? 6 : 6;
}

function isPrefixPath(prefix: string[], path: string[]) {
  if (prefix.length > path.length) return false;
  return prefix.every((id, index) => id === path[index]);
}

const drillVariants = {
  initial: ({ direction, skip }: DrillMotionCustom) => ({
    opacity: 1,
    x: skip ? 0 : getDrillX(direction, 'enter'),
    y: skip ? 0 : getDrillY(direction, 'enter'),
  }),
  animate: {
    opacity: 1,
    x: 0,
    y: 0,
  },
  exit: ({ direction, skip }: DrillMotionCustom) => ({
    opacity: 0,
    x: skip ? 0 : getDrillX(direction, 'exit'),
    y: skip ? 0 : getDrillY(direction, 'exit'),
  }),
};

const cameraPanStyle = (cameraPan: CameraPan): React.CSSProperties => ({
  transform: cameraPan ? `translate3d(${cameraPan.x}px, ${cameraPan.y}px, 0)` : 'translate3d(0, 0, 0)',
  transition: cameraPan
    ? `transform ${CAMERA_PAN_MS}ms cubic-bezier(0.2, 0, 0, 1)`
    : 'none',
});

export default function ChatArea() {
  const t = useT();
  const rootTree = useAppStore(s => s.rootTree);
  const focusedNodeId = useAppStore(s => s.focusedNodeId);
  const getNodePath = useAppStore(s => s.getNodePath);
  const focusNode = useAppStore(s => s.focusNode);
  const currentRootId = useAppStore(s => s.currentRootId);
  const roots = useAppStore(s => s.roots);
  const collapsedSet = useAppStore(s => s.collapsedSet);
  const collapseAll = useAppStore(s => s.collapseAll);
  const streamingNodeIds = useAppStore(s => s.streamingNodeIds);
  const streamingContent = useAppStore(s => s.streamingContent);
  const streamingRelation = useAppStore(s => s.streamingRelation);

  // Derive primary streaming node info for UI (pending placeholder etc.)
  const streamingNodeId = (() => {
    if (streamingNodeIds.size === 0) return null;
    // Prefer pending nodes, then followup nodes, then any
    const arr = [...streamingNodeIds];
    const pending = arr.find(id => id.startsWith('pending-'));
    if (pending) return pending;
    return arr[0];
  })();
  const curStreamContent = streamingNodeId ? (streamingContent[streamingNodeId] || '') : '';
  const curStreamRelation = streamingNodeId ? (streamingRelation[streamingNodeId] || null) : null;
  const treeLoading = useAppStore(s => s.treeLoading);
  const loading = useAppStore(s => s.loading);
  const scrollToNodeId = useAppStore(s => s.scrollToNodeId);
  const clearScrollToNodeId = useAppStore(s => s.clearScrollToNodeId);
  const searchScrollTarget = useAppStore(s => s.searchScrollTarget);
  const clearSearchScrollTarget = useAppStore(s => s.clearSearchScrollTarget);

  // ── 冻结区状态 ──
  const [frozenEntries, setFrozenEntries] = useState<FrozenEntry[]>([]);

  // ── 移动端面包屑自动显隐 ──
  const [breadcrumbVisible, setBreadcrumbVisible] = useState(true);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const lastScrollTopRef2 = useRef(0);
  const isMobileRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    isMobileRef.current = mq.matches;
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => {
      isMobileRef.current = e.matches;
      setIsMobile(e.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // FLIP 动画：捕获原 model-bar 芯片位置
  type FlipCaptures = import('./FrozenModelBar').FlipCaptures;
  const flipCapturesRef = useRef<FlipCaptures>({});
  const prevFrozenNodeIdsRef = useRef<Set<string>>(new Set());
  const frozenStackRef = useRef<FrozenEntry[]>([]);
  const activeFrozenViewIdRef = useRef<string | null>(focusedNodeId);
  const clearFrozenStack = useCallback(() => {
    setFrozenEntries([]);
    prevFrozenNodeIdsRef.current = new Set();
    frozenStackRef.current = [];
    flipCapturesRef.current = {};
  }, []);

  // 获取聚焦节点的路径（用于面包屑）
  const path = focusedNodeId ? getNodePath(focusedNodeId) : [];
  const currentRoot = roots.find(t => t.id === currentRootId);

  // 跳过根节点（第一个 path 节点与根问题重复）
  const breadcrumbNodes = path.length > 1 ? path.slice(1) : [];

  // 判断是否所有可折叠节点都已折叠
  const allNodesCollapsed = (() => {
    if (!rootTree) return false;
    const isLogicalNode = (node: any) => {
      try {
        return JSON.parse(node.meta || '{}').kind === 'logic';
      } catch {
        return false;
      }
    };
    let allCollapsible = 0;
    let allCollapsed = 0;
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        const canCollapse = isLogicalNode(n) || (n.children && n.children.length > 0) || (n.responses && n.responses.length > 0);
        if (canCollapse) {
          allCollapsible++;
          if (collapsedSet.has(n.id)) allCollapsed++;
        }
        if (n.children) walk(n.children);
      }
    };
    walk(rootTree);
    return allCollapsible > 0 && allCollapsible === allCollapsed;
  })();

  // 从 rootTree 中查找指定节点（DFS 递归）
  const findNode = (nodes: any[], id: string): any => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children?.length) {
        const found = findNode(n.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  // 构建节点关系查找表 (id → Node)
  const nodeMapRef = useRef<Record<string, any>>({});

  useEffect(() => {
    const map: Record<string, any> = {};
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        map[n.id] = n;
        if (n.children?.length) walk(n.children);
      }
    };
    if (rootTree) walk(rootTree);
    nodeMapRef.current = map;
  }, [rootTree]);

  // ── 冻结区滚动跟踪 ──
  const handleChatScroll = useCallback(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    // 收集所有锚点
    const anchors = chatArea.querySelectorAll<HTMLElement>('[data-frozen-anchor]');
    const stack: FrozenEntry[] = [];
    const nodeMap = nodeMapRef.current;
    const containerRect = chatArea.getBoundingClientRect();
    const freezeLineY = BREADCRUMB_FIXED_HEIGHT;
    const previousStackIds = new Set(frozenStackRef.current.map(entry => entry.nodeId));

    // 按 DOM 顺序遍历（即树的前序遍历）。聚焦切换动画期间旧视图仍会短暂留在 DOM，
    // 只读取当前聚焦视图里的锚点，避免旧父节点冻结区被滚动回调重新算回来。
    const activeViewId = activeFrozenViewIdRef.current;
    const anchorList = Array.from(anchors).filter(anchor => {
      if (!activeViewId) return true;
      const view = anchor.closest<HTMLElement>('[data-drill-view-id]');
      return view?.dataset.drillViewId === activeViewId;
    });
    anchorList.forEach((anchor) => {
      const nodeId = anchor.dataset.frozenAnchor;
      if (!nodeId) return;
      const node = nodeMap[nodeId];
      if (!node) return;

      // 折叠节点不显示冻结条
      if (collapsedSet.has(nodeId)) return;

      const rect = anchor.getBoundingClientRect();
      const anchorTop = rect.top - containerRect.top;
      const collapsible = anchor.closest<HTMLElement>('.node-responses-collapsible');
      const collapsibleBottom = collapsible
        ? collapsible.getBoundingClientRect().bottom - containerRect.top
        : Infinity;
      const wasInStack = previousStackIds.has(nodeId);
      const enterOffset = wasInStack ? -FREEZE_EXIT_OFFSET : FREEZE_ENTER_OFFSET;
      const exitOffset = wasInStack ? FREEZE_EXIT_OFFSET : 0;

      const modelBarPassedFreezeLine = anchorTop <= freezeLineY - enterOffset;
      const responseBottomStillBelowFreezeLine = collapsibleBottom > freezeLineY + exitOffset;
      if (!modelBarPassedFreezeLine || !responseBottomStillBelowFreezeLine) return;

      // 收集该节点的模型 ID
      const modelIds: string[] = [];
      if (node.responses) {
        for (const resp of node.responses) {
          if (resp.model_id && !modelIds.includes(resp.model_id)) {
            modelIds.push(resp.model_id);
          }
        }
      }

      if (modelIds.length === 0) return;

      const entry: FrozenEntry = {
        nodeId,
        question: node.content || '',
        modelIds,
        relation: (node.relation as 'followup' | 'progression') || 'progression',
      };

      // FLIP 捕获：新入栈节点的芯片在原始 model-bar 中的位置
      if (!previousStackIds.has(nodeId)) {
        const capture: Record<string, DOMRect> = {};
        const chips = anchor.querySelectorAll<HTMLElement>('.model-chip[data-model-id]');
        chips.forEach(chip => {
          const mid = chip.dataset.modelId;
          if (mid) capture[mid] = chip.getBoundingClientRect();
        });
        if (Object.keys(capture).length > 0) {
          flipCapturesRef.current[nodeId] = capture;
        }
      }

      stack.push(entry);
    });

    const topEntry = stack.length > 0 ? [stack[stack.length - 1]] : [];
    frozenStackRef.current = stack;
    prevFrozenNodeIdsRef.current = new Set(topEntry.map(e => e.nodeId));
    setFrozenEntries(prev => {
      if (JSON.stringify(prev) === JSON.stringify(topEntry)) return prev;
      return topEntry;
    });
  }, [collapsedSet]);

  // 监听滚动（兼容桌面和移动端）
  useEffect(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;
    let lastRun = 0;
    const THROTTLE = 100; // ms
    const onScroll = () => {
      const now = Date.now();
      if (now - lastRun < THROTTLE) return;
      lastRun = now;
      handleChatScroll();
    };
    chatArea.addEventListener('scroll', onScroll, { passive: true });
    chatArea.addEventListener('touchmove', onScroll, { passive: true });
    handleChatScroll(); // 初始检测
    return () => {
      chatArea.removeEventListener('scroll', onScroll);
      chatArea.removeEventListener('touchmove', onScroll);
    };
  }, [handleChatScroll]);

  // 问题切换时重置冻结区
  useEffect(() => {
    clearFrozenStack();
  }, [clearFrozenStack, currentRootId]);

  // ── 移动端：滚动方向检测，控制面包屑显隐 ──
  useEffect(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    const onScroll = () => {
      if (!isMobileRef.current) return;
      const st = chatArea.scrollTop;
      if (st < 5) {
        setBreadcrumbVisible(true);
      } else if (st > lastScrollTopRef2.current + 5) {
        setBreadcrumbVisible(false);
      } else if (st < lastScrollTopRef2.current - 15) {
        setBreadcrumbVisible(true);
      }
      lastScrollTopRef2.current = st;
    };

    chatArea.addEventListener('scroll', onScroll, { passive: true });
    return () => chatArea.removeEventListener('scroll', onScroll);
  }, []);

  // 聚焦节点
  const focusedNode = focusedNodeId && rootTree ? findNode(rootTree, focusedNodeId) : null;

  /** 
   * 查找追问节点在父回复中引用的文字
   */
  const getFollowupQuote = (node: Node): string | null => {
    if (node.relation !== 'followup' || !node.nut_id) return null;
    const parent = node.parent_id && rootTree
      ? findNode(rootTree, node.parent_id)
      : null;
    if (!parent?.responses) return null;
    for (const resp of parent.responses) {
      if (resp.nuts) {
        const nut = resp.nuts.find((n: Nut) => n.id === node.nut_id);
        if (nut?.label) return nut.label;
      }
    }
    return null;
  };

  const breadcrumbTextMaxLen = isMobile ? 5 : 10;

  const getBreadcrumbText = (node: Pick<Node, 'summary' | 'content'>): string =>
    node.summary || node.content;

  // 截断文本
  const truncate = (text: string, maxLen: number): string =>
    Array.from(text).length > maxLen ? Array.from(text).slice(0, maxLen).join('') + '...' : text;

  const hasLatex = (text: string): boolean =>
    /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/.test(text);

  const formatBreadcrumbText = (text: string): string =>
    hasLatex(text) ? text : truncate(text, breadcrumbTextMaxLen);

  const prevFocusedRef = useRef<string | null>(null);
  const [drillDirection, setDrillDirection] = useState<DrillDirection>('replace');
  const [cameraPan, setCameraPan] = useState<CameraPan>(null);
  const [skipFocusAnimation, setSkipFocusAnimation] = useState(false);
  const [suppressNodeEnterAnimation, setSuppressNodeEnterAnimation] = useState(false);
  const [isDrillCommitSwapping, setIsDrillCommitSwapping] = useState(false);
  const prevPathIdsRef = useRef<string[]>([]);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const pendingBreadcrumbScrollRef = useRef<{ targetNodeId: string; anchorNodeId: string } | null>(null);
  const prevStreamingNodeIdRef = useRef<string | null>(null);
  const cameraCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drillCommitSwapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNodeEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitCloneRef = useRef<HTMLElement | null>(null);
  const commitCloneTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const drillReferenceFadeElsRef = useRef<HTMLElement[]>([]);
  const landingLockCleanupRef = useRef<(() => void) | null>(null);
  const pathIdsKey = path.map(node => node.id).join('\u001f');
  const pathIds = React.useMemo(
    () => pathIdsKey ? pathIdsKey.split('\u001f') : [],
    [pathIdsKey],
  );
  const breadcrumbVisibleRef = useRef(breadcrumbVisible);
  const focusedNodeIdRef = useRef(focusedNodeId);
  const pathIdsRef = useRef(pathIds);
  const focusNodeRef = useRef(focusNode);
  const getNodePathRef = useRef(getNodePath);

  const getTopOverlayOffset = useCallback((_reserveFrozen = false) => CHAT_AREA_FIXED_TOP_PADDING, []);

  const clearCommitClone = useCallback(() => {
    commitCloneRef.current?.remove();
    commitCloneRef.current = null;
    commitCloneTimersRef.current.forEach(timer => clearTimeout(timer));
    commitCloneTimersRef.current = [];
  }, []);

  const clearLandingLock = useCallback(() => {
    landingLockCleanupRef.current?.();
    landingLockCleanupRef.current = null;
  }, []);

  const clearDrillReferenceFade = useCallback(() => {
    drillReferenceFadeElsRef.current.forEach(el => {
      el.classList.remove('is-drill-reference-fading');
    });
    drillReferenceFadeElsRef.current = [];
  }, []);

  const startDrillReferenceFade = useCallback((targetCard: HTMLElement) => {
    clearDrillReferenceFade();
    if (!targetCard.classList.contains('node-followup')) return;

    const followupInline = targetCard.closest<HTMLElement>('.followup-inline');
    const elements = [targetCard, followupInline].filter((el): el is HTMLElement => Boolean(el));
    elements.forEach(el => el.classList.add('is-drill-reference-fading'));
    drillReferenceFadeElsRef.current = elements;
  }, [clearDrillReferenceFade]);

  const finishDrillCommitSwap = useCallback(() => {
    if (drillCommitSwapTimerRef.current) {
      clearTimeout(drillCommitSwapTimerRef.current);
      drillCommitSwapTimerRef.current = null;
    }
    setIsDrillCommitSwapping(false);
    setSkipFocusAnimation(false);
  }, []);

  const suppressNodeEnterFor = useCallback((duration: number) => {
    if (suppressNodeEnterTimerRef.current) {
      clearTimeout(suppressNodeEnterTimerRef.current);
      suppressNodeEnterTimerRef.current = null;
    }
    setSuppressNodeEnterAnimation(true);
    suppressNodeEnterTimerRef.current = setTimeout(() => {
      setSuppressNodeEnterAnimation(false);
      suppressNodeEnterTimerRef.current = null;
    }, duration);
  }, []);

  const coverCommitWithClone = useCallback((source: HTMLElement) => {
    clearCommitClone();
    const rect = source.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const clone = source.cloneNode(true) as HTMLElement;
    clone.classList.add('drill-commit-clone');
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    document.body.appendChild(clone);
    commitCloneRef.current = clone;

    const fadeTimer = setTimeout(() => {
      clone.classList.add('is-fading');
    }, 220);
    const removeTimer = setTimeout(() => {
      if (commitCloneRef.current === clone) commitCloneRef.current = null;
      clone.remove();
    }, 340);
    commitCloneTimersRef.current = [fadeTimer, removeTimer];
  }, [clearCommitClone]);

  const setChatAreaScrollTopInstant = useCallback((top: number) => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    const previousScrollBehavior = chatArea.style.scrollBehavior;
    chatArea.style.scrollBehavior = 'auto';
    chatArea.scrollTo({ top, behavior: 'auto' });
    chatArea.scrollTop = top;

    requestAnimationFrame(() => {
      chatArea.scrollTop = top;
      chatArea.style.scrollBehavior = previousScrollBehavior;
    });
  }, []);

  const scrollElementToSafeTop = useCallback((el: HTMLElement, options?: { reserveFrozen?: boolean; behavior?: ScrollBehavior | 'instant' }) => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;
    const rect = el.getBoundingClientRect();
    const containerRect = chatArea.getBoundingClientRect();
    const topOffset = getTopOverlayOffset(options?.reserveFrozen);
    const scrollTarget = chatArea.scrollTop + rect.top - containerRect.top - topOffset;
    const nextScrollTop = Math.max(0, scrollTarget);
    if (options?.behavior === 'instant') {
      setChatAreaScrollTopInstant(nextScrollTop);
      return;
    }
    chatArea.scrollTo({ top: nextScrollTop, behavior: options?.behavior || 'smooth' });
  }, [getTopOverlayOffset, setChatAreaScrollTopInstant]);

  const scrollQuestionAnchorToTop = useCallback((el: HTMLElement) => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    const rect = el.getBoundingClientRect();
    const containerRect = chatArea.getBoundingClientRect();
    const scrollTarget = chatArea.scrollTop + rect.top - containerRect.top - getTopOverlayOffset(false);
    setChatAreaScrollTopInstant(Math.max(0, scrollTarget));
  }, [getTopOverlayOffset, setChatAreaScrollTopInstant]);

  const lockQuestionAnchorLanding = useCallback((anchor: HTMLElement, view: HTMLElement) => {
    clearLandingLock();

    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const rafs: number[] = [];
    const observers: ResizeObserver[] = [];

    const align = () => {
      if (stopped || !anchor.isConnected || !view.isConnected) return;
      scrollQuestionAnchorToTop(anchor);
    };

    const scheduleAlign = () => {
      if (stopped) return;
      const raf = requestAnimationFrame(() => {
        const nested = requestAnimationFrame(align);
        rafs.push(nested);
      });
      rafs.push(raf);
    };

    align();
    scheduleAlign();
    [40, 90, 160, 260, 420, 680, 960].forEach(delay => {
      timers.push(setTimeout(scheduleAlign, delay));
    });

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(scheduleAlign);
      observer.observe(view);
      observer.observe(anchor);
      const parentCard = anchor.closest<HTMLElement>('[data-node-card-id]');
      if (parentCard) observer.observe(parentCard);
      observers.push(observer);
    }

    timers.push(setTimeout(() => {
      landingLockCleanupRef.current?.();
      landingLockCleanupRef.current = null;
    }, 1200));

    landingLockCleanupRef.current = () => {
      stopped = true;
      timers.forEach(timer => clearTimeout(timer));
      rafs.forEach(raf => cancelAnimationFrame(raf));
      observers.forEach(observer => observer.disconnect());
    };
  }, [clearLandingLock, scrollQuestionAnchorToTop]);

  const focusBreadcrumbNode = useCallback((targetNodeId: string, anchorNodeId?: string | null, url?: string) => {
    if (cameraCommitTimerRef.current) {
      clearTimeout(cameraCommitTimerRef.current);
      cameraCommitTimerRef.current = null;
    }
    clearCommitClone();
    clearLandingLock();
    clearDrillReferenceFade();
    finishDrillCommitSwap();
    setCameraPan(null);
    setDrillDirection('drill-out');
    pendingBreadcrumbScrollRef.current = anchorNodeId
      ? { targetNodeId, anchorNodeId }
      : null;
    setSkipFocusAnimation(false);
    suppressNodeEnterFor(420);
    activeFrozenViewIdRef.current = targetNodeId;
    focusedNodeIdRef.current = targetNodeId;
    clearFrozenStack();
    focusNode(targetNodeId);
    if (url) window.history.pushState(null, '', url);
  }, [clearCommitClone, clearDrillReferenceFade, clearFrozenStack, clearLandingLock, finishDrillCommitSwap, focusNode, suppressNodeEnterFor]);

  const getBreadcrumbLandingAnchor = useCallback((targetNodeId: string): string | null => {
    if (!focusedNodeId || focusedNodeId === targetNodeId) return null;
    return focusedNodeId;
  }, [focusedNodeId]);

  useEffect(() => {
    breadcrumbVisibleRef.current = breadcrumbVisible;
  }, [breadcrumbVisible]);

  useLayoutEffect(() => {
    focusedNodeIdRef.current = focusedNodeId;
    activeFrozenViewIdRef.current = focusedNodeId;
  }, [focusedNodeId]);

  useEffect(() => {
    pathIdsRef.current = pathIds;
  }, [pathIds]);

  useEffect(() => {
    focusNodeRef.current = focusNode;
  }, [focusNode]);

  useEffect(() => {
    getNodePathRef.current = getNodePath;
  }, [getNodePath]);

  useEffect(() => {
    const handleDrillNode = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
      if (!nodeId) return;

      if (cameraCommitTimerRef.current) {
        clearTimeout(cameraCommitTimerRef.current);
        cameraCommitTimerRef.current = null;
      }
      clearDrillReferenceFade();

      if (nodeId === focusedNodeIdRef.current) {
        window.history.pushState(null, '', '/node/' + nodeId);
        return;
      }

      const currentPathIds = pathIdsRef.current;
      const targetPathIds = getNodePathRef.current(nodeId).map(node => node.id);
      let nextDirection: DrillDirection = 'replace';
      if (currentPathIds.length > 0 && targetPathIds.length > 0) {
        if (targetPathIds.length > currentPathIds.length && isPrefixPath(currentPathIds, targetPathIds)) {
          nextDirection = 'drill-in';
        } else if (currentPathIds.length > targetPathIds.length && isPrefixPath(targetPathIds, currentPathIds)) {
          nextDirection = 'drill-out';
        }
      }

      const chatArea = chatAreaRef.current;
      const targetCard = chatArea?.querySelector<HTMLElement>(`[data-node-card-id="${nodeId}"]`);
      if (!chatArea || !targetCard) {
        setDrillDirection(nextDirection);
        activeFrozenViewIdRef.current = nodeId;
        focusedNodeIdRef.current = nodeId;
        clearFrozenStack();
        focusNodeRef.current(nodeId);
        window.history.pushState(null, '', '/node/' + nodeId);
        return;
      }

      const containerRect = chatArea.getBoundingClientRect();
      const targetRect = targetCard.getBoundingClientRect();
      const chatAreaStyle = window.getComputedStyle(chatArea);
      const targetLeft = containerRect.left + parseFloat(chatAreaStyle.paddingLeft || '0');
      const targetTop = containerRect.top + parseFloat(chatAreaStyle.paddingTop || '0');

      setDrillDirection(nextDirection);
      activeFrozenViewIdRef.current = nodeId;
      focusedNodeIdRef.current = nodeId;
      clearFrozenStack();
      if (nextDirection === 'drill-in') {
        startDrillReferenceFade(targetCard);
      }
      setCameraPan({
        x: targetLeft - targetRect.left,
        y: targetTop - targetRect.top,
      });

      cameraCommitTimerRef.current = setTimeout(() => {
        coverCommitWithClone(targetCard);
        setSkipFocusAnimation(true);
        setIsDrillCommitSwapping(true);
        setCameraPan(null);
        activeFrozenViewIdRef.current = nodeId;
        focusedNodeIdRef.current = nodeId;
        clearFrozenStack();
        focusNodeRef.current(nodeId);
        clearDrillReferenceFade();
        window.history.pushState(null, '', '/node/' + nodeId);
        cameraCommitTimerRef.current = null;
        drillCommitSwapTimerRef.current = setTimeout(finishDrillCommitSwap, 320);
      }, CAMERA_PAN_MS);
    };

    window.addEventListener('megaform:drill-node', handleDrillNode);
    return () => {
      window.removeEventListener('megaform:drill-node', handleDrillNode);
      clearCommitClone();
      clearLandingLock();
      clearDrillReferenceFade();
      if (cameraCommitTimerRef.current) {
        clearTimeout(cameraCommitTimerRef.current);
        cameraCommitTimerRef.current = null;
      }
      if (suppressNodeEnterTimerRef.current) {
        clearTimeout(suppressNodeEnterTimerRef.current);
        suppressNodeEnterTimerRef.current = null;
      }
      setSuppressNodeEnterAnimation(false);
      finishDrillCommitSwap();
    };
  }, [clearCommitClone, clearDrillReferenceFade, clearFrozenStack, clearLandingLock, coverCommitWithClone, finishDrillCommitSwap, startDrillReferenceFade]);

  useLayoutEffect(() => {
    if (focusedNodeId === prevFocusedRef.current) {
      if (pathIds.length > 0) prevPathIdsRef.current = pathIds;
      return;
    }

    const previousPathIds = prevPathIdsRef.current;
    let nextDirection: DrillDirection = 'replace';
    if (previousPathIds.length > 0 && pathIds.length > 0) {
      if (pathIds.length > previousPathIds.length && isPrefixPath(previousPathIds, pathIds)) {
        nextDirection = 'drill-in';
      } else if (previousPathIds.length > pathIds.length && isPrefixPath(pathIds, previousPathIds)) {
        nextDirection = 'drill-out';
      }
    }

    setDrillDirection(nextDirection);
    clearFrozenStack();

    const pendingBreadcrumbScroll = pendingBreadcrumbScrollRef.current;
    if (!pendingBreadcrumbScroll || pendingBreadcrumbScroll.targetNodeId !== focusedNodeId) {
      setChatAreaScrollTopInstant(0);
    }

    prevFocusedRef.current = focusedNodeId;
    prevPathIdsRef.current = pathIds;
  }, [clearFrozenStack, focusedNodeId, pathIds, setChatAreaScrollTopInstant]);

  useEffect(() => {
    const pendingBreadcrumbScroll = pendingBreadcrumbScrollRef.current;
    if (!pendingBreadcrumbScroll || pendingBreadcrumbScroll.targetNodeId !== focusedNodeId) return;
    if (!focusedNode || focusedNode.id !== focusedNodeId) return;

    let cancelled = false;
    let attempts = 0;

    const tryScroll = () => {
      if (cancelled || !chatAreaRef.current) return;

      const view = chatAreaRef.current.querySelector<HTMLElement>(
        `[data-drill-view-id="${pendingBreadcrumbScroll.targetNodeId}"]`
      );
      const anchor = view?.querySelector<HTMLElement>(
        `[data-question-anchor="${pendingBreadcrumbScroll.anchorNodeId}"]`
      );
      if (anchor && view) {
        lockQuestionAnchorLanding(anchor, view);
        pendingBreadcrumbScrollRef.current = null;
        return;
      }

      // const anchor = chatAreaRef.current.querySelector<HTMLElement>(
      //   `[data-scroll-anchor="${pendingBreadcrumbScroll.anchorNodeId}"]`
      // );
      // if (anchor) {
      //   scrollElementToSafeTop(anchor, { reserveFrozen: true, behavior: 'instant' });
      //   pendingBreadcrumbScrollRef.current = null;
      //   return;
      // }

      attempts += 1;
      if (attempts < 8) {
        setTimeout(tryScroll, 80);
        return;
      }

      setChatAreaScrollTopInstant(0);
      pendingBreadcrumbScrollRef.current = null;
    };

    const timer = setTimeout(tryScroll, 40);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [focusedNode, focusedNodeId, lockQuestionAnchorLanding, setChatAreaScrollTopInstant]);

  // 追问：流式开始时（null → pending）立即滚动到顶部，展示新节点的问题卡片
  // 推演：不滚动，由 scrollToNodeId 效果精确控制
  useEffect(() => {
    if (streamingNodeId && !prevStreamingNodeIdRef.current) {
      if (curStreamRelation === 'followup') {
        requestAnimationFrame(() => {
          chatAreaRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
    }
    prevStreamingNodeIdRef.current = streamingNodeId;
  }, [streamingNodeId, curStreamRelation]);

  // 推演子节点创建后，滚动到新节点位置（不切换聚焦）
  useEffect(() => {
    if (!scrollToNodeId || !chatAreaRef.current) return;
    // 等 React 渲染完新的 DOM（NodeCard 渲染 + 动画）
    const timer = setTimeout(() => {
      const el = chatAreaRef.current?.querySelector<HTMLElement>(
        `[data-scroll-anchor="${scrollToNodeId}"]`
      );
      if (el) {
        scrollElementToSafeTop(el, { reserveFrozen: true });
      }
      clearScrollToNodeId();
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToNodeId, clearScrollToNodeId, scrollElementToSafeTop]);

  // 选中侧边栏搜索结果后，滚动到命中词在原文里的位置。
  useEffect(() => {
    if (!searchScrollTarget || !chatAreaRef.current) return;

    let cancelled = false;
    let attempts = 0;
    const hitId = `search-${searchScrollTarget.requestId}`;

    const tryScroll = () => {
      if (cancelled || !chatAreaRef.current) return;

      const hit = chatAreaRef.current.querySelector<HTMLElement>(
        `[data-search-hit="${hitId}"]`
      );
      if (hit) {
        const reserveFrozen = searchScrollTarget.type === 'response';
        scrollElementToSafeTop(hit, { reserveFrozen });
        setTimeout(() => {
          if (!cancelled) scrollElementToSafeTop(hit, { reserveFrozen });
          clearSearchScrollTarget();
        }, 420);
        return;
      }

      attempts += 1;
      if (attempts < 12) {
        setTimeout(tryScroll, 80);
        return;
      }

      const fallbackSelector = searchScrollTarget.type === 'response' && searchScrollTarget.modelId
        ? `[data-response-anchor="${searchScrollTarget.nodeId}:${searchScrollTarget.modelId}"]`
        : `[data-scroll-anchor="${searchScrollTarget.nodeId}"]`;
      const fallback = chatAreaRef.current.querySelector<HTMLElement>(fallbackSelector);
      if (fallback) scrollElementToSafeTop(fallback, { reserveFrozen: searchScrollTarget.type === 'response' });
      clearSearchScrollTarget();
    };

    const timer = setTimeout(tryScroll, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchScrollTarget, clearSearchScrollTarget, focusedNode, scrollElementToSafeTop]);

  // 是否处于流式输出中
  const isStreamingActive = streamingNodeIds.size > 0;
  // 追问 / 新问题树：展示流式占位卡片 + 滚动到顶
  // 推演（已有父节点）：展示实际树（父节点 + streaming 子节点）
  const showStreamingPlaceholder = isStreamingActive && (
    curStreamRelation === 'followup' || !rootTree || rootTree.length === 0
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1', minHeight: 0 }}>
      {/* Inner wrapper: 面包屑 + 冻结区悬浮在 chat-area 上方，不挤占布局 */}
      <div style={{ position: 'relative', flex: '1', minHeight: 0, display: 'flex', flexDirection: 'column' }}>

      {/* Breadcrumb + Collapse toggle — 悬浮在 chatArea 上方，移动端随下滑淡出 */}
      <div
        ref={breadcrumbRef}
        className={`breadcrumb-wrapper${breadcrumbVisible ? '' : ' hidden'}`}
      >
      <div className="breadcrumb">
        {currentRoot && (
          <span
            className="breadcrumb-item"
            onClick={() => {
              if (rootTree?.length) {
                const targetNodeId = rootTree[0].id;
                focusBreadcrumbNode(
                  targetNodeId,
                  getBreadcrumbLandingAnchor(targetNodeId),
                  '/root/' + currentRootId,
                );
              }
            }}
          >
            {formatBreadcrumbText(getBreadcrumbText(currentRoot))}
          </span>
        )}
        {breadcrumbNodes.map((node, i) => {
          const isLast = i === breadcrumbNodes.length - 1;
          const isFollowup = node.relation === 'followup';
          const quote = isFollowup ? getFollowupQuote(node) : null;
          return (
            <React.Fragment key={node.id}>
              <span className="breadcrumb-separator">›</span>
              <span
                className={`breadcrumb-item${isLast ? ' current' : ''}${isFollowup && quote ? ' followup' : ''}`}
                onClick={isLast ? undefined : () => {
                  focusBreadcrumbNode(
                    node.id,
                    getBreadcrumbLandingAnchor(node.id),
                    '/node/' + node.id,
                  );
                }}
                title={quote ? `${t('quotePrefix')}: ${quote}` : undefined}
              >
                {isFollowup && quote ? (
                  <>
                    <span className="followup-quote">
                      <MarkdownContent content={formatBreadcrumbText(quote)} inline />
                    </span>
                    <span className="followup-question">{formatBreadcrumbText(getBreadcrumbText(node))}</span>
                  </>
                ) : (
                  formatBreadcrumbText(getBreadcrumbText(node))
                )}
              </span>
            </React.Fragment>
          );
        })}

        {/* 折叠全部按钮（仅折叠，不提供展开） */}
        {currentRootId && rootTree && rootTree.length > 0 && (
          <button
            className={`collapse-all-btn${allNodesCollapsed ? ' is-disabled' : ''}`}
            onClick={allNodesCollapsed ? undefined : collapseAll}
            title={t('collapseAllNodes')}
            disabled={allNodesCollapsed}
          >
            <ListChevronsDownUp size={18} />
          </button>
        )}
      </div>
      </div>

      <FrozenModelBar
        entries={frozenEntries}
        flipCapturesRef={flipCapturesRef}
        top={BREADCRUMB_FIXED_HEIGHT}
        visible={breadcrumbVisible}
        onSelectModel={(nodeId, modelId) => {
          const chatArea = chatAreaRef.current;
          if (!chatArea) return;
          // 等待 React 渲染新模型回复后再滚动
          requestAnimationFrame(() => {
            const anchor = chatArea.querySelector<HTMLElement>(
              `[data-response-anchor="${nodeId}:${modelId}"]`
            );
            if (anchor) {
              scrollElementToSafeTop(anchor, { reserveFrozen: true });
            }
          });
        }}
      />

      {/* Chat content — 带 Workflowy 式下钻/返回动画 */}
      <div
        ref={chatAreaRef}
        className={`chat-area${isDrillCommitSwapping ? ' is-drill-commit-swapping' : ''}`}
        style={{
          paddingTop: `${CHAT_AREA_FIXED_TOP_PADDING}px`,
        }}
      >
        {showStreamingPlaceholder ? (
          <NodeCard
            node={{
              id: streamingNodeId,
              root_id: currentRootId || '',
              parent_id: null,
              child_order: 0,
              content: curStreamContent,
              relation: 'followup',
              nut_id: null,
              parent_model_id: null,
              search_enabled: null,
              attachments: '[]',
              summary: '',
              pinned: 0,
              archived: 0,
              group_id: null,
              group_order: null,
              meta: '{}',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              responses: [],
              children: [],
            } as Node}
            depth={0}
          />
        ) : loading || (treeLoading && !focusedNode) ? (
          <div className="empty-state">
            <p>{t('loadingTree')}</p>
          </div>
        ) : focusedNode ? (
          <AnimatePresence
            initial={false}
            mode="sync"
            custom={{ direction: drillDirection, skip: skipFocusAnimation }}
            onExitComplete={finishDrillCommitSwap}
          >
            <motion.div
              key={focusedNode.id}
              className="drill-transition-shell"
              data-drill-view-id={focusedNode.id}
              custom={{ direction: drillDirection, skip: skipFocusAnimation }}
              variants={drillVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: skipFocusAnimation ? 0 : 0.2, ease: DRILL_EASE }}
            >
              <div className="camera-pan-layer" style={cameraPanStyle(cameraPan)}>
                <NodeCard
                  node={focusedNode}
                  depth={0}
                  suppressEnterAnimation={skipFocusAnimation || suppressNodeEnterAnimation}
                />
              </div>
            </motion.div>
          </AnimatePresence>
        ) : currentRootId ? (
          <div className="empty-state">
            <p>{t('startBelow')}</p>
          </div>
        ) : (
          <div className="empty-state">
            <p>{t('chooseQuestionStart')}</p>
          </div>
        )}
        {/* 底部空白区：保证最后一个卡片能 scroll 到顶部 */}
        <div className="chat-area-spacer" />
      </div>
      </div>
    </div>
  );
}
