/**
 * ChatArea — 聊天主区域
 * 
 * 职责：
 * - 面包屑导航：展示当前聚焦节点在问题树中的路径
 * - 冻结区 (FrozenModelBar)：模型 tab 栏冻结在面包屑下方
 * - 聚焦节点切换动画（淡入淡出）
 * - 聚焦渲染：从 rootTree 中取出 focusedNodeId 对应的 NodeCard
 * - 流式新问题树时的临时卡片渲染
 * - 空状态提示
 */
import React, { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BookmarkPlus,
  CornerUpLeft,
  GitBranch,
  MessageSquare,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import NodeCard from './NodeCard';
import TreeOverview, { TreeOverviewMiniMap } from './TreeOverview';
import FrozenModelBar, { type FrozenEntry } from './FrozenModelBar';
import MarkdownContent from './MarkdownContent';
import ReferencePreview from './ReferencePreview';
import type { Node, Nut } from '../types';
import { useT } from '../i18n';
import { getNutReferenceText } from '../utils/referenceText';
import { useMiniMapEnabled } from '../utils/uiPreferences';

const FREEZE_ENTER_OFFSET = 8;
const FREEZE_EXIT_OFFSET = 2;
type DrillDirection = 'drill-in' | 'drill-out' | 'replace';
type DrillMotionCustom = { direction: DrillDirection; skip: boolean };
type CameraPan = { x: number; y: number } | null;
type FocusReadingKeyPoint = { progress: number; hits: number };
type FocusReadingStoredState = {
  maxProgress: number;
  hitCounts: Array<[number, number]>;
  keyPoints: FocusReadingKeyPoint[];
};
type FocusReadingTextSize = 'low' | 'medium' | 'high';
type FocusReadingFont = 'system' | 'modern-sans' | 'book-serif' | 'academic-serif';
type FocusReadingWidth = 'low' | 'medium' | 'high';
type FocusReadingPreferences = {
  textSize: FocusReadingTextSize;
  font: FocusReadingFont;
  width: FocusReadingWidth;
};
type ArrowShortcutSequence = {
  key: 'ArrowUp' | 'ArrowDown' | null;
  count: number;
  lastAt: number;
};

const DRILL_EASE: [number, number, number, number] = [0.2, 0, 0, 1];
const CAMERA_PAN_MS = 260;
const BREADCRUMB_FIXED_HEIGHT = 60;
const FROZEN_BAR_FIXED_HEIGHT = 44;
const OVERLAY_GAP = 8;
const CHAT_AREA_FIXED_TOP_PADDING = BREADCRUMB_FIXED_HEIGHT + FROZEN_BAR_FIXED_HEIGHT + OVERLAY_GAP;
const FOCUS_READING_HIT_DURATION_MS = 3000;
const FOCUS_READING_KEY_POINT_HITS = 3;
const FOCUS_READING_MAX_KEY_POINTS = 3;
const FOCUS_READING_ARROW_SEQUENCE_MS = 360;
const FOCUS_READING_KEY_POINT_SCROLL_MS = 220;
const FOCUS_READING_SESSION_STORAGE_KEY = 'megaform-focus-reading-state-v1';
const FOCUS_READING_PREFERENCES_STORAGE_KEY = 'megaform-focus-reading-preferences-v1';
const DEFAULT_FOCUS_READING_PREFERENCES: FocusReadingPreferences = {
  textSize: 'medium',
  font: 'book-serif',
  width: 'medium',
};
const FOCUS_READING_TEXT_SIZES: Record<FocusReadingTextSize, string> = {
  low: '16px',
  medium: '17px',
  high: '18px',
};
const FOCUS_READING_WIDTHS: Record<FocusReadingWidth, string> = {
  low: '640px',
  medium: '740px',
  high: '860px',
};
const FOCUS_READING_FONT_STACKS: Record<FocusReadingFont, string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif',
  'modern-sans': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", Inter, "Helvetica Neue", Arial, sans-serif',
  'book-serif': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, "Times New Roman", serif',
  'academic-serif': 'FangSong, STFangsong, "Noto Serif SC", "Times New Roman", Georgia, serif',
};

function readFocusReadingPreferences(): FocusReadingPreferences {
  try {
    const raw = sessionStorage.getItem(FOCUS_READING_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_FOCUS_READING_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<FocusReadingPreferences>;
    return {
      textSize: parsed.textSize === 'low' || parsed.textSize === 'high'
        ? parsed.textSize
        : 'medium',
      font: (
        parsed.font === 'modern-sans'
        || parsed.font === 'book-serif'
        || parsed.font === 'academic-serif'
      ) ? parsed.font : 'system',
      width: parsed.width === 'low' || parsed.width === 'high'
        ? parsed.width
        : 'medium',
    };
  } catch {
    return DEFAULT_FOCUS_READING_PREFERENCES;
  }
}

function persistFocusReadingPreferences(preferences: FocusReadingPreferences) {
  try {
    sessionStorage.setItem(
      FOCUS_READING_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Keep the preferences in memory when storage is unavailable.
  }
}

function normalizeStoredProgress(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function normalizeStoredHits(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

function readFocusReadingStoredState(nodeId: string): FocusReadingStoredState | null {
  try {
    const raw = sessionStorage.getItem(FOCUS_READING_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const sessions = parsed as Record<string, unknown>;
    const stored = sessions?.[nodeId];
    if (!stored || typeof stored !== 'object') return null;

    const candidate = stored as Partial<FocusReadingStoredState>;
    const maxProgress = normalizeStoredProgress(candidate.maxProgress) ?? 0;
    const hitCounts = Array.isArray(candidate.hitCounts)
      ? candidate.hitCounts.flatMap(entry => {
          if (!Array.isArray(entry) || entry.length !== 2) return [];
          const progress = normalizeStoredProgress(entry[0]);
          const hits = normalizeStoredHits(entry[1]);
          return progress === null || hits === null ? [] : [[progress, hits] as [number, number]];
        })
      : [];
    const keyPoints = Array.isArray(candidate.keyPoints)
      ? candidate.keyPoints.flatMap(point => {
          if (!point || typeof point !== 'object') return [];
          const progress = normalizeStoredProgress((point as FocusReadingKeyPoint).progress);
          const hits = normalizeStoredHits((point as FocusReadingKeyPoint).hits);
          return progress === null || hits === null || hits < FOCUS_READING_KEY_POINT_HITS
            ? []
            : [{ progress, hits }];
        }).slice(-FOCUS_READING_MAX_KEY_POINTS)
      : [];

    return { maxProgress, hitCounts, keyPoints };
  } catch {
    return null;
  }
}

function persistFocusReadingStoredState(
  nodeId: string,
  maxProgress: number,
  hitCounts: Map<number, number>,
  keyPoints: FocusReadingKeyPoint[],
) {
  try {
    const raw = sessionStorage.getItem(FOCUS_READING_SESSION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const sessions = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, FocusReadingStoredState>
      : {};
    sessions[nodeId] = {
      maxProgress,
      hitCounts: [...hitCounts.entries()],
      keyPoints,
    };
    sessionStorage.setItem(FOCUS_READING_SESSION_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Storage can be unavailable in restricted browser contexts; reading still works in memory.
  }
}

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
  const miniMapEnabled = useMiniMapEnabled();
  const focusReadingNodeId = useAppStore(s => s.focusReadingNodeId);
  const setFocusReadingNode = useAppStore(s => s.setFocusReadingNode);
  const focusReadingActive = Boolean(focusReadingNodeId);
  const rootTree = useAppStore(s => s.rootTree);
  const focusedNodeId = useAppStore(s => s.focusedNodeId);
  const getNodePath = useAppStore(s => s.getNodePath);
  const getNodeById = useAppStore(s => s.getNodeById);
  const focusNode = useAppStore(s => s.focusNode);
  const currentRootId = useAppStore(s => s.currentRootId);
  const roots = useAppStore(s => s.roots);
  const collapsedSet = useAppStore(s => s.collapsedSet);
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
  const [overviewMode, setOverviewMode] = useState(false);
  const [miniMapRingNodeId, setMiniMapRingNodeId] = useState<string | null>(null);
  const [focusReadingProgress, setFocusReadingProgress] = useState(0);
  const [focusReadingMaxProgress, setFocusReadingMaxProgress] = useState(0);
  const [focusReadingKeyPoints, setFocusReadingKeyPoints] = useState<FocusReadingKeyPoint[]>([]);
  const [focusReadingMenuOpen, setFocusReadingMenuOpen] = useState(false);
  const [focusReadingPreferences, setFocusReadingPreferences] = useState(
    readFocusReadingPreferences,
  );
  const focusReadingProgressRef = useRef(0);
  const focusReadingMaxProgressRef = useRef(0);
  const focusReadingHitCountsRef = useRef(new Map<number, number>());
  const focusReadingKeyPointsRef = useRef<FocusReadingKeyPoint[]>([]);
  const focusReadingStateNodeIdRef = useRef<string | null>(null);
  const focusReadingMaxRecordingSuspendedNodeRef = useRef<string | null>(null);
  const arrowShortcutSequenceRef = useRef<ArrowShortcutSequence>({ key: null, count: 0, lastAt: 0 });
  const arrowDownShortcutTimerRef = useRef<number | null>(null);
  const focusReadingScrollAnimationRef = useRef<number | null>(null);
  const focusReadingMenuRef = useRef<HTMLDivElement | null>(null);

  // ── 冻结区状态 ──
  const [frozenEntries, setFrozenEntries] = useState<FrozenEntry[]>([]);
  const [frozenStackDepth, setFrozenStackDepth] = useState(0);
  const [frozenExitMode, setFrozenExitMode] = useState<'none' | 'pop-out'>('none');

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

  useEffect(() => {
    persistFocusReadingPreferences(focusReadingPreferences);
  }, [focusReadingPreferences]);

  useEffect(() => {
    setFocusReadingMenuOpen(false);
  }, [focusReadingNodeId]);

  useEffect(() => {
    if (!focusReadingMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!focusReadingMenuRef.current?.contains(event.target as globalThis.Node)) {
        setFocusReadingMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusReadingMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [focusReadingMenuOpen]);

  // FLIP 动画：捕获原 model-bar 芯片位置
  type FlipCaptures = import('./FrozenModelBar').FlipCaptures;
  const flipCapturesRef = useRef<FlipCaptures>({});
  const prevFrozenNodeIdsRef = useRef<Set<string>>(new Set());
  const frozenStackRef = useRef<FrozenEntry[]>([]);
  const activeFrozenViewIdRef = useRef<string | null>(focusedNodeId);
  const clearFrozenStack = useCallback(() => {
    setFrozenEntries([]);
    setFrozenStackDepth(0);
    setFrozenExitMode('none');
    prevFrozenNodeIdsRef.current = new Set();
    frozenStackRef.current = [];
    flipCapturesRef.current = {};
  }, []);

  // 获取聚焦节点的路径（用于面包屑）
  const path = focusedNodeId ? getNodePath(focusedNodeId) : [];
  const currentRoot = roots.find(t => t.id === currentRootId);
  const focusReadingNode = focusReadingNodeId ? getNodeById(focusReadingNodeId) : null;
  const focusReadingParentNode = focusReadingNode?.parent_id
    ? getNodeById(focusReadingNode.parent_id)
    : null;

  // 跳过根节点（第一个 path 节点与根问题重复）
  const breadcrumbNodes = path.length > 1 ? path.slice(1) : [];

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
    const previousStack = frozenStackRef.current;
    const previousStackIds = new Set(previousStack.map(entry => entry.nodeId));

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
    const nextExitMode = stack.length < previousStack.length ? 'pop-out' : 'none';
    frozenStackRef.current = stack;
    prevFrozenNodeIdsRef.current = new Set(topEntry.map(e => e.nodeId));
    setFrozenStackDepth(prev => prev === stack.length ? prev : stack.length);
    setFrozenExitMode(prev => prev === nextExitMode ? prev : nextExitMode);
    setFrozenEntries(prev => {
      if (JSON.stringify(prev) === JSON.stringify(topEntry)) return prev;
      return topEntry;
    });
  }, [collapsedSet]);

  const updateMiniMapRingNode = useCallback(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea || overviewMode || isMobile || !miniMapEnabled) {
      setMiniMapRingNodeId(prev => prev === null ? prev : null);
      return;
    }

    const containerRect = chatArea.getBoundingClientRect();
    const threshold = containerRect.height * (2 / 3);
    const activeViewId = activeFrozenViewIdRef.current;
    const cards = Array.from(
      chatArea.querySelectorAll<HTMLElement>('[data-node-card-id]:not(.is-collapsed)')
    ).filter(card => {
      if (!activeViewId) return true;
      const view = card.closest<HTMLElement>('[data-drill-view-id]');
      return view?.dataset.drillViewId === activeViewId;
    });

    let nextNodeId: string | null = null;
    let bestVisibleHeight = 0;
    let bestDepth = -1;

    cards.forEach(card => {
      const inlineContainer = card.classList.contains('node-followup')
        ? card.closest<HTMLElement>('.followup-inline')
        : null;
      const ownBlocks = inlineContainer ? [inlineContainer] : [
        card.querySelector<HTMLElement>(':scope > .question-block'),
        card.querySelector<HTMLElement>(':scope > .node-content-wrapper > .node-content-inner > .node-responses-collapsible'),
      ].filter((block): block is HTMLElement => Boolean(block));

      const ownRects = ownBlocks.length > 0
        ? ownBlocks.map(block => block.getBoundingClientRect())
        : [card.getBoundingClientRect()];

      const visibleHeight = ownRects.reduce((total, rect) => (
        total + Math.max(0, Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top))
      ), 0);
      let depth = 0;
      let ancestor = card.parentElement?.closest<HTMLElement>('[data-node-card-id]') ?? null;
      while (ancestor) {
        depth += 1;
        ancestor = ancestor.parentElement?.closest<HTMLElement>('[data-node-card-id]') ?? null;
      }

      if (
        visibleHeight >= threshold
        && (depth > bestDepth || (depth === bestDepth && visibleHeight > bestVisibleHeight))
      ) {
        bestVisibleHeight = visibleHeight;
        bestDepth = depth;
        nextNodeId = card.dataset.nodeCardId || null;
      }
    });

    setMiniMapRingNodeId(prev => prev === nextNodeId ? prev : nextNodeId);
  }, [isMobile, miniMapEnabled, overviewMode]);

  const getFocusReadingScrollEnd = useCallback((chatArea: HTMLDivElement) => {
    if (!focusReadingNodeId || focusedNodeId !== focusReadingNodeId) return null;
    const activeView = chatArea.querySelector<HTMLElement>(
      `[data-drill-view-id="${focusReadingNodeId}"]`,
    );
    const targetCard = activeView?.querySelector<HTMLElement>(
      `[data-node-card-id="${focusReadingNodeId}"]`,
    );
    if (!targetCard) return null;
    return (
      targetCard.getBoundingClientRect().bottom
      - chatArea.getBoundingClientRect().top
      + chatArea.scrollTop
      - chatArea.clientHeight
      + 24
    );
  }, [focusReadingNodeId, focusedNodeId]);

  const updateFocusReadingProgress = useCallback(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea || !focusReadingNodeId) {
      setFocusReadingProgress(prev => prev === 0 ? prev : 0);
      return;
    }
    if (focusReadingStateNodeIdRef.current !== focusReadingNodeId) return;

    const readingEnd = getFocusReadingScrollEnd(chatArea);
    if (readingEnd === null) return;
    const nextProgress = readingEnd <= 0
      ? 100
      : Math.round(Math.max(0, Math.min(1, chatArea.scrollTop / readingEnd)) * 100);

    const previousMaxProgress = focusReadingMaxProgressRef.current;
    const shouldRecordMax = (
      focusReadingMaxRecordingSuspendedNodeRef.current !== focusReadingNodeId
    );
    const nextMaxProgress = shouldRecordMax
      ? Math.max(previousMaxProgress, nextProgress)
      : previousMaxProgress;
    focusReadingProgressRef.current = nextProgress;
    focusReadingMaxProgressRef.current = nextMaxProgress;
    setFocusReadingProgress(prev => prev === nextProgress ? prev : nextProgress);
    setFocusReadingMaxProgress(nextMaxProgress);
    if (nextMaxProgress > previousMaxProgress) {
      persistFocusReadingStoredState(
        focusReadingNodeId,
        nextMaxProgress,
        focusReadingHitCountsRef.current,
        focusReadingKeyPointsRef.current,
      );
    }
  }, [focusReadingNodeId, getFocusReadingScrollEnd]);

  const jumpToFocusReadingProgress = useCallback((progress: number, durationMs?: number) => {
    const chatArea = chatAreaRef.current;
    if (
      !chatArea
      || !focusReadingNodeId
      || focusReadingStateNodeIdRef.current !== focusReadingNodeId
    ) return;
    const readingEnd = getFocusReadingScrollEnd(chatArea);
    if (readingEnd === null) return;
    const targetTop = Math.max(0, readingEnd * (Math.max(0, Math.min(100, progress)) / 100));
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (focusReadingScrollAnimationRef.current !== null) {
      cancelAnimationFrame(focusReadingScrollAnimationRef.current);
      focusReadingScrollAnimationRef.current = null;
    }

    if (reduceMotion || durationMs === undefined) {
      chatArea.scrollTo({
        top: targetTop,
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
      return;
    }

    const startTop = chatArea.scrollTop;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 1) return;
    const startedAt = performance.now();
    const animateScroll = (now: number) => {
      const elapsed = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - elapsed, 3);
      chatArea.scrollTop = startTop + distance * eased;
      if (elapsed < 1) {
        focusReadingScrollAnimationRef.current = requestAnimationFrame(animateScroll);
      } else {
        focusReadingScrollAnimationRef.current = null;
      }
    };
    focusReadingScrollAnimationRef.current = requestAnimationFrame(animateScroll);
  }, [focusReadingNodeId, getFocusReadingScrollEnd]);

  const jumpToFocusReadingMax = useCallback(() => {
    if (
      !focusReadingNodeId
      || focusReadingStateNodeIdRef.current !== focusReadingNodeId
    ) return;
    const maxProgress = focusReadingMaxProgressRef.current;
    if (maxProgress <= 0) return;
    jumpToFocusReadingProgress(maxProgress);
  }, [focusReadingNodeId, jumpToFocusReadingProgress]);

  const jumpToAdjacentKeyPoint = useCallback((direction: -1 | 1) => {
    const currentProgress = focusReadingProgressRef.current;
    const orderedProgress = focusReadingKeyPointsRef.current
      .map(point => point.progress)
      .sort((a, b) => a - b);
    const targetProgress = direction < 0
      ? [...orderedProgress].reverse().find(progress => progress < currentProgress)
      : orderedProgress.find(progress => progress > currentProgress);
    if (targetProgress !== undefined) {
      jumpToFocusReadingProgress(targetProgress, FOCUS_READING_KEY_POINT_SCROLL_MS);
      return;
    }

    const lastKeyPoint = orderedProgress[orderedProgress.length - 1];
    if (direction > 0 && lastKeyPoint !== undefined && currentProgress >= lastKeyPoint) {
      jumpToFocusReadingMax();
    }
  }, [jumpToFocusReadingMax, jumpToFocusReadingProgress]);

  const upsertFocusReadingKeyPoint = useCallback((progress: number, hits: number) => {
    if (
      !focusReadingNodeId
      || focusReadingStateNodeIdRef.current !== focusReadingNodeId
    ) return;

    setFocusReadingKeyPoints(previous => {
      if (focusReadingStateNodeIdRef.current !== focusReadingNodeId) return previous;
      const existingIndex = previous.findIndex(point => point.progress === progress);
      const next = existingIndex >= 0
        ? previous.map((point, index) => (
            index === existingIndex ? { ...point, hits: Math.max(point.hits, hits) } : point
          ))
        : [...previous, { progress, hits }];
      const retained = next.length > FOCUS_READING_MAX_KEY_POINTS
        ? next.slice(next.length - FOCUS_READING_MAX_KEY_POINTS)
        : next;
      focusReadingKeyPointsRef.current = retained;
      persistFocusReadingStoredState(
        focusReadingNodeId,
        focusReadingMaxProgressRef.current,
        focusReadingHitCountsRef.current,
        retained,
      );
      return retained;
    });
  }, [focusReadingNodeId]);

  const handleAddFocusReadingKeyPoint = useCallback(() => {
    if (
      !focusReadingNodeId
      || focusReadingStateNodeIdRef.current !== focusReadingNodeId
    ) return;
    const progress = focusReadingProgressRef.current;
    const hits = Math.max(
      focusReadingHitCountsRef.current.get(progress) ?? 0,
      FOCUS_READING_KEY_POINT_HITS,
    );
    focusReadingHitCountsRef.current.set(progress, hits);
    upsertFocusReadingKeyPoint(progress, hits);
    setFocusReadingMenuOpen(false);
  }, [focusReadingNodeId, upsertFocusReadingKeyPoint]);

  useEffect(() => {
    arrowShortcutSequenceRef.current = { key: null, count: 0, lastAt: 0 };
    if (arrowDownShortcutTimerRef.current !== null) {
      window.clearTimeout(arrowDownShortcutTimerRef.current);
      arrowDownShortcutTimerRef.current = null;
    }
    if (!focusReadingNodeId) return;

    const clearPendingDownJump = () => {
      if (arrowDownShortcutTimerRef.current !== null) {
        window.clearTimeout(arrowDownShortcutTimerRef.current);
        arrowDownShortcutTimerRef.current = null;
      }
    };

    const resetSequence = () => {
      clearPendingDownJump();
      arrowShortcutSequenceRef.current = { key: null, count: 0, lastAt: 0 };
    };

    const handleArrowShortcut = (event: KeyboardEvent) => {
      const isArrowKey = event.key === 'ArrowUp' || event.key === 'ArrowDown';
      if (!isArrowKey || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
        if (event.key !== 'Shift') resetSequence();
        return;
      }

      const target = event.target;
      if (
        (
          target instanceof HTMLElement
          && (
            target.matches('input, textarea, select')
            || target.isContentEditable
            || Boolean(target.closest('.focus-reading-settings-popover'))
          )
        )
        || document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        resetSequence();
        return;
      }

      const key = event.key as 'ArrowUp' | 'ArrowDown';
      const now = performance.now();
      const previous = arrowShortcutSequenceRef.current;
      const continuesSequence = previous.key === key
        && now - previous.lastAt <= FOCUS_READING_ARROW_SEQUENCE_MS;

      if (!continuesSequence) clearPendingDownJump();
      const count = continuesSequence ? previous.count + 1 : 1;
      arrowShortcutSequenceRef.current = { key, count, lastAt: now };

      if (key === 'ArrowUp' && count === 2) {
        event.preventDefault();
        arrowShortcutSequenceRef.current = { key: null, count: 0, lastAt: 0 };
        jumpToAdjacentKeyPoint(-1);
        return;
      }

      if (key === 'ArrowDown' && count === 2) {
        event.preventDefault();
        clearPendingDownJump();
        arrowDownShortcutTimerRef.current = window.setTimeout(() => {
          arrowDownShortcutTimerRef.current = null;
          arrowShortcutSequenceRef.current = { key: null, count: 0, lastAt: 0 };
          jumpToAdjacentKeyPoint(1);
        }, FOCUS_READING_ARROW_SEQUENCE_MS);
        return;
      }

      if (key === 'ArrowDown' && count >= 3) {
        event.preventDefault();
        resetSequence();
        jumpToFocusReadingMax();
      }
    };

    window.addEventListener('keydown', handleArrowShortcut);
    return () => {
      window.removeEventListener('keydown', handleArrowShortcut);
      resetSequence();
    };
  }, [focusReadingNodeId, jumpToAdjacentKeyPoint, jumpToFocusReadingMax]);

  // 监听滚动（兼容桌面和移动端）
  useEffect(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;
    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        handleChatScroll();
        updateMiniMapRingNode();
        updateFocusReadingProgress();
      });
    };
    chatArea.addEventListener('scroll', onScroll, { passive: true });
    chatArea.addEventListener('touchmove', onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(onScroll);
    resizeObserver.observe(chatArea);
    handleChatScroll(); // 初始检测
    updateMiniMapRingNode();
    updateFocusReadingProgress();
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      chatArea.removeEventListener('scroll', onScroll);
      chatArea.removeEventListener('touchmove', onScroll);
    };
  }, [handleChatScroll, updateFocusReadingProgress, updateMiniMapRingNode]);

  useEffect(() => {
    if (focusReadingScrollAnimationRef.current !== null) {
      cancelAnimationFrame(focusReadingScrollAnimationRef.current);
      focusReadingScrollAnimationRef.current = null;
    }
    if (
      focusReadingMaxRecordingSuspendedNodeRef.current
      && focusReadingMaxRecordingSuspendedNodeRef.current !== focusReadingNodeId
    ) {
      focusReadingMaxRecordingSuspendedNodeRef.current = null;
    }
    focusReadingStateNodeIdRef.current = null;
    focusReadingProgressRef.current = 0;
    focusReadingMaxProgressRef.current = 0;
    focusReadingHitCountsRef.current = new Map();
    focusReadingKeyPointsRef.current = [];
    setFocusReadingProgress(0);
    setFocusReadingMaxProgress(0);
    setFocusReadingKeyPoints([]);
    if (!focusReadingNodeId) {
      return;
    }

    const stored = readFocusReadingStoredState(focusReadingNodeId);
    const restoredKeyPoints = stored?.keyPoints ?? [];
    const restoredHitCounts = new Map(stored?.hitCounts ?? []);
    restoredKeyPoints.forEach(point => {
      restoredHitCounts.set(
        point.progress,
        Math.max(restoredHitCounts.get(point.progress) ?? 0, point.hits),
      );
    });
    const restoredMaxProgress = Math.max(
      stored?.maxProgress ?? 0,
      ...restoredKeyPoints.map(point => point.progress),
    );
    focusReadingMaxProgressRef.current = restoredMaxProgress;
    focusReadingHitCountsRef.current = restoredHitCounts;
    focusReadingKeyPointsRef.current = restoredKeyPoints;
    setFocusReadingMaxProgress(restoredMaxProgress);
    setFocusReadingKeyPoints(restoredKeyPoints);

    clearFrozenStack();
    setOverviewMode(false);
    let progressFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      const chatArea = chatAreaRef.current;
      if (!chatArea) return;
      chatArea.scrollTop = 0;
      focusReadingStateNodeIdRef.current = focusReadingNodeId;
      progressFrame = requestAnimationFrame(updateFocusReadingProgress);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (progressFrame !== null) cancelAnimationFrame(progressFrame);
      if (focusReadingStateNodeIdRef.current === focusReadingNodeId) {
        focusReadingStateNodeIdRef.current = null;
      }
    };
  }, [clearFrozenStack, focusReadingNodeId, updateFocusReadingProgress]);

  useEffect(() => {
    if (
      !focusReadingNodeId
      || focusReadingStateNodeIdRef.current !== focusReadingNodeId
    ) return;

    const progress = focusReadingProgress;
    let hitTimer: number | null = null;

    const stopHitTimer = () => {
      if (hitTimer === null) return;
      window.clearTimeout(hitTimer);
      hitTimer = null;
    };

    const startHitTimer = () => {
      stopHitTimer();
      if (document.visibilityState !== 'visible') return;

      hitTimer = window.setTimeout(() => {
        hitTimer = null;
        if (focusReadingStateNodeIdRef.current !== focusReadingNodeId) return;
        const hits = (focusReadingHitCountsRef.current.get(progress) ?? 0) + 1;
        focusReadingHitCountsRef.current.set(progress, hits);
        if (hits < FOCUS_READING_KEY_POINT_HITS) {
          persistFocusReadingStoredState(
            focusReadingNodeId,
            focusReadingMaxProgressRef.current,
            focusReadingHitCountsRef.current,
            focusReadingKeyPointsRef.current,
          );
          return;
        }
        upsertFocusReadingKeyPoint(progress, hits);
      }, FOCUS_READING_HIT_DURATION_MS);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startHitTimer();
      else stopHitTimer();
    };

    startHitTimer();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopHitTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [focusReadingNodeId, focusReadingProgress, upsertFocusReadingKeyPoint]);

  useEffect(() => {
    const rafId = requestAnimationFrame(updateMiniMapRingNode);
    return () => cancelAnimationFrame(rafId);
  }, [collapsedSet, focusedNodeId, rootTree, updateMiniMapRingNode]);

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
        if (nut) return getNutReferenceText(resp.content, nut, nut.label || '');
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
  const pendingFocusReadingParentAnchorRef = useRef<{
    parentNodeId: string;
    nutId: string;
  } | null>(null);
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

  const lockFocusReadingAnchorLanding = useCallback((
    anchor: HTMLElement,
    view: HTMLElement,
    nodeId: string,
  ) => {
    clearLandingLock();

    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const rafs: number[] = [];
    const observers: ResizeObserver[] = [];

    const align = () => {
      const chatArea = chatAreaRef.current;
      if (stopped || !chatArea || !anchor.isConnected || !view.isConnected) return;

      const anchorRect = anchor.getBoundingClientRect();
      const containerRect = chatArea.getBoundingClientRect();
      const targetTop = (
        chatArea.scrollTop
        + anchorRect.top
        - containerRect.top
        - chatArea.clientHeight / 3
      );
      setChatAreaScrollTopInstant(Math.max(0, targetTop));
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
      if (focusReadingMaxRecordingSuspendedNodeRef.current === nodeId) {
        focusReadingMaxRecordingSuspendedNodeRef.current = null;
      }
    };
  }, [clearLandingLock, setChatAreaScrollTopInstant]);

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

  const handleFocusReadingParent = useCallback(() => {
    if (!focusReadingParentNode) return;
    setFocusReadingMenuOpen(false);
    const followupNutId = focusReadingNode?.relation === 'followup'
      && focusReadingNode.parent_id === focusReadingParentNode.id
      ? focusReadingNode.nut_id
      : null;
    pendingFocusReadingParentAnchorRef.current = followupNutId
      ? {
          parentNodeId: focusReadingParentNode.id,
          nutId: followupNutId,
        }
      : null;
    focusBreadcrumbNode(
      focusReadingParentNode.id,
      followupNutId ? null : focusReadingNodeId,
      focusReadingParentNode.parent_id
        ? `/node/${focusReadingParentNode.id}`
        : `/root/${focusReadingParentNode.root_id}`,
    );
    focusReadingMaxRecordingSuspendedNodeRef.current = followupNutId
      ? focusReadingParentNode.id
      : null;
    if (followupNutId) setSkipFocusAnimation(true);
    setFocusReadingNode(focusReadingParentNode.id);
  }, [
    focusBreadcrumbNode,
    focusReadingNodeId,
    focusReadingNode,
    focusReadingParentNode,
    setFocusReadingNode,
  ]);

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

  useEffect(() => {
    const pendingAnchor = pendingFocusReadingParentAnchorRef.current;
    if (
      !pendingAnchor
      || pendingAnchor.parentNodeId !== focusedNodeId
      || pendingAnchor.parentNodeId !== focusReadingNodeId
    ) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const tryLocateAnchor = () => {
      if (cancelled) return;
      const chatArea = chatAreaRef.current;
      if (!chatArea) return;

      const view = chatArea.querySelector<HTMLElement>(
        `[data-drill-view-id="${pendingAnchor.parentNodeId}"]`,
      );
      const parentCard = (view || chatArea).querySelector<HTMLElement>(
        `[data-node-card-id="${pendingAnchor.parentNodeId}"]`,
      );
      const anchor = Array.from(
        parentCard?.querySelectorAll<HTMLElement>('.nut-focus-anchor[data-nut-id]') ?? [],
      ).find(element => element.dataset.nutId === pendingAnchor.nutId);

      if (anchor && view) {
        lockFocusReadingAnchorLanding(anchor, view, pendingAnchor.parentNodeId);
        pendingFocusReadingParentAnchorRef.current = null;
        requestAnimationFrame(updateFocusReadingProgress);
        return;
      }

      attempts += 1;
      if (attempts < 10) {
        retryTimer = setTimeout(tryLocateAnchor, 50);
      } else {
        if (
          focusReadingMaxRecordingSuspendedNodeRef.current
          === pendingAnchor.parentNodeId
        ) {
          focusReadingMaxRecordingSuspendedNodeRef.current = null;
        }
        pendingFocusReadingParentAnchorRef.current = null;
      }
    };

    const firstFrame = requestAnimationFrame(tryLocateAnchor);
    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    focusReadingNodeId,
    focusedNodeId,
    lockFocusReadingAnchorLanding,
    updateFocusReadingProgress,
  ]);

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

  const handleOverviewSelectNode = useCallback((node: Node) => {
    setOverviewMode(false);
    focusBreadcrumbNode(
      node.id,
      null,
      node.parent_id ? '/node/' + node.id : '/root/' + node.root_id,
    );
  }, [focusBreadcrumbNode]);

  const handleMiniMapSelectNode = useCallback((node: Node) => {
    if (node.id === focusedNodeId) {
      setChatAreaScrollTopInstant(0);
      return;
    }

    const targetPath = getNodePath(node.id).map(item => item.id);
    const isInFocusedSubtree = Boolean(
      focusedNodeId &&
      targetPath.includes(focusedNodeId) &&
      targetPath[targetPath.length - 1] === node.id,
    );
    const targetCard = chatAreaRef.current?.querySelector<HTMLElement>(
      `[data-scroll-anchor="${node.id}"]`
    );
    if (isInFocusedSubtree && targetCard) {
      scrollElementToSafeTop(targetCard, { reserveFrozen: true });
      return;
    }

    const currentPath = focusedNodeId ? getNodePath(focusedNodeId).map(item => item.id) : [];
    const isAncestorJump = Boolean(
      focusedNodeId &&
      targetPath.length < currentPath.length &&
      targetPath.every((id, index) => currentPath[index] === id),
    );

    focusBreadcrumbNode(
      node.id,
      isAncestorJump ? focusedNodeId : null,
      node.parent_id ? '/node/' + node.id : '/root/' + node.root_id,
    );
  }, [focusBreadcrumbNode, focusedNodeId, getNodePath, scrollElementToSafeTop, setChatAreaScrollTopInstant]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1',
        minHeight: 0,
        '--focus-reading-content-width': FOCUS_READING_WIDTHS[focusReadingPreferences.width],
        '--focus-reading-font-size': FOCUS_READING_TEXT_SIZES[focusReadingPreferences.textSize],
        '--focus-reading-font-family': FOCUS_READING_FONT_STACKS[focusReadingPreferences.font],
      } as React.CSSProperties}
    >
      {/* Inner wrapper: 面包屑 + 冻结区悬浮在 chat-area 上方，不挤占布局 */}
      <div style={{ position: 'relative', flex: '1', minHeight: 0, display: 'flex', flexDirection: 'column' }}>

      {focusReadingActive && (
        <div className="focus-reading-toolbar" aria-label={t('focusReading')}>
          <span className="focus-reading-toolbar-label">{t('focusReading')}</span>
          <div className="focus-reading-progress">
            <span className="focus-reading-progress-track">
              <span
                className="focus-reading-progress-value"
                style={{ width: `${focusReadingProgress}%` }}
                role="progressbar"
                aria-label={t('focusReadingProgress', { progress: focusReadingProgress })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={focusReadingProgress}
              />
              {focusReadingKeyPoints.map(point => (
                <button
                  key={point.progress}
                  type="button"
                  className="focus-reading-key-point-marker"
                  data-level={Math.min(5, point.hits - FOCUS_READING_KEY_POINT_HITS + 1)}
                  style={{ left: `${point.progress}%` }}
                  onClick={() => jumpToFocusReadingProgress(
                    point.progress,
                    FOCUS_READING_KEY_POINT_SCROLL_MS,
                  )}
                  aria-label={t('focusReadingKeyPoint', {
                    progress: point.progress,
                    hits: point.hits,
                  })}
                  title={t('focusReadingKeyPoint', {
                    progress: point.progress,
                    hits: point.hits,
                  })}
                />
              ))}
              {focusReadingMaxProgress > 0 && (
                <button
                  type="button"
                  className="focus-reading-progress-marker"
                  style={{ left: `${focusReadingMaxProgress}%` }}
                  onClick={jumpToFocusReadingMax}
                  aria-label={t('focusReadingResume', { progress: focusReadingMaxProgress })}
                  title={t('focusReadingResume', { progress: focusReadingMaxProgress })}
                />
              )}
            </span>
            <span className="focus-reading-progress-text">{focusReadingProgress}%</span>
          </div>
          <div className="focus-reading-settings" ref={focusReadingMenuRef}>
            <button
              type="button"
              className={`focus-reading-toolbar-btn${focusReadingMenuOpen ? ' is-active' : ''}`}
              onClick={() => setFocusReadingMenuOpen(open => !open)}
              aria-haspopup="dialog"
              aria-expanded={focusReadingMenuOpen}
              aria-label={t('focusReadingSettings')}
              title={t('focusReadingSettings')}
            >
              <SlidersHorizontal size={16} />
            </button>
            {focusReadingMenuOpen && (
              <div
                className="focus-reading-settings-popover"
                role="dialog"
                aria-label={t('focusReadingSettings')}
              >
                <button
                  type="button"
                  className="focus-reading-settings-action"
                  onClick={handleAddFocusReadingKeyPoint}
                >
                  <BookmarkPlus size={15} />
                  <span>{t('focusReadingAddKeyPoint')}</span>
                  <span className="focus-reading-settings-value">{focusReadingProgress}%</span>
                </button>

                <section className="focus-reading-settings-section">
                  <h3>{t('focusReadingTextSize')}</h3>
                  <div
                    className="focus-reading-settings-options is-three"
                    role="group"
                    aria-label={t('focusReadingTextSize')}
                  >
                    {([
                      ['low', 'focusReadingLevelLow'],
                      ['medium', 'focusReadingLevelMedium'],
                      ['high', 'focusReadingLevelHigh'],
                    ] as const).map(([value, labelKey]) => (
                      <button
                        key={value}
                        type="button"
                        className={focusReadingPreferences.textSize === value ? 'is-active' : ''}
                        onClick={() => setFocusReadingPreferences(previous => ({
                          ...previous,
                          textSize: value,
                        }))}
                        aria-pressed={focusReadingPreferences.textSize === value}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="focus-reading-settings-section">
                  <h3>{t('focusReadingFont')}</h3>
                  <div
                    className="focus-reading-settings-options is-font-grid"
                    role="group"
                    aria-label={t('focusReadingFont')}
                  >
                    {([
                      ['system', 'focusReadingFontSystem'],
                      ['modern-sans', 'focusReadingFontModernSans'],
                      ['book-serif', 'focusReadingFontBookSerif'],
                      ['academic-serif', 'focusReadingFontAcademicSerif'],
                    ] as const).map(([value, labelKey]) => (
                      <button
                        key={value}
                        type="button"
                        className={focusReadingPreferences.font === value ? 'is-active' : ''}
                        style={{ fontFamily: FOCUS_READING_FONT_STACKS[value] }}
                        onClick={() => setFocusReadingPreferences(previous => ({
                          ...previous,
                          font: value,
                        }))}
                        aria-pressed={focusReadingPreferences.font === value}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="focus-reading-settings-section">
                  <h3>{t('focusReadingContentWidth')}</h3>
                  <div
                    className="focus-reading-settings-options is-three"
                    role="group"
                    aria-label={t('focusReadingContentWidth')}
                  >
                    {([
                      ['low', 'focusReadingWidthLow'],
                      ['medium', 'focusReadingWidthMedium'],
                      ['high', 'focusReadingWidthHigh'],
                    ] as const).map(([value, labelKey]) => (
                      <button
                        key={value}
                        type="button"
                        className={focusReadingPreferences.width === value ? 'is-active' : ''}
                        onClick={() => setFocusReadingPreferences(previous => ({
                          ...previous,
                          width: value,
                        }))}
                        aria-pressed={focusReadingPreferences.width === value}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                </section>

                {focusReadingParentNode && (
                  <button
                    type="button"
                    className="focus-reading-settings-action is-parent"
                    onClick={handleFocusReadingParent}
                  >
                    <CornerUpLeft size={15} />
                    <span>{t('focusReadingParentNode')}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="focus-reading-toolbar-btn"
            onClick={() => setFocusReadingNode(null)}
            aria-label={t('exitFocusReading')}
            title={t('exitFocusReading')}
          >
            <X size={16} />
          </button>
        </div>
      )}

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
                    <span className="followup-quote"><ReferencePreview text={quote} /></span>
                    <span className="followup-question">{formatBreadcrumbText(getBreadcrumbText(node))}</span>
                  </>
                ) : (
                  formatBreadcrumbText(getBreadcrumbText(node))
                )}
              </span>
            </React.Fragment>
          );
        })}

        {currentRootId && rootTree && rootTree.length > 0 && (
          <span className="breadcrumb-actions">
            <button
              className={`overview-toggle-btn${overviewMode ? ' is-active' : ''}`}
              onClick={() => {
                clearFrozenStack();
                setOverviewMode(value => !value);
              }}
              title={overviewMode ? t('readingMode') : t('overviewMode')}
            >
              {overviewMode ? <MessageSquare size={18} /> : <GitBranch size={18} />}
            </button>
          </span>
        )}
      </div>
      </div>

      <FrozenModelBar
        entries={frozenEntries}
        stackDepth={frozenStackDepth}
        exitMode={frozenExitMode}
        flipCapturesRef={flipCapturesRef}
        top={BREADCRUMB_FIXED_HEIGHT}
        visible={(isMobile ? breadcrumbVisible : true) && !overviewMode && !focusReadingActive}
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

      {miniMapEnabled && !isMobile && !overviewMode && !focusReadingActive && rootTree && rootTree.length > 0 && (
        <TreeOverviewMiniMap
          rootTree={rootTree}
          focusedNodeId={focusedNodeId}
          ringNodeId={miniMapRingNodeId}
          streamingNodeIds={streamingNodeIds}
          onSelectNode={handleMiniMapSelectNode}
        />
      )}

      {/* Chat content — 带 Workflowy 式下钻/返回动画 */}
      <div
        ref={chatAreaRef}
        className={`chat-area${overviewMode ? ' is-overview-mode' : ''}${isDrillCommitSwapping ? ' is-drill-commit-swapping' : ''}`}
        style={{
          paddingTop: overviewMode ? 0 : focusReadingActive ? '68px' : `${CHAT_AREA_FIXED_TOP_PADDING}px`,
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
        ) : overviewMode && rootTree && rootTree.length > 0 ? (
          <TreeOverview
            rootTree={rootTree}
            focusedNodeId={focusedNodeId}
            streamingNodeIds={streamingNodeIds}
            onSelectNode={handleOverviewSelectNode}
          />
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
        {!overviewMode && <div className="chat-area-spacer" />}
      </div>
      </div>
    </div>
  );
}
