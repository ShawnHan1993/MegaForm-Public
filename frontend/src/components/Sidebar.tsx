/**
 * Sidebar — 侧边栏组件
 *
 * 职责：
 * - 展示问题树列表
 * - 支持自定义分组、折叠和跨分组移动
 * - 支持搜索聊天记录
 * - 新问题树按钮（重置当前问题树 + 聚焦输入框）
 * - 问题操作：切换、删除、编辑摘要
 */
import { useState, useRef, useEffect, useMemo, type CSSProperties } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../api/client';
import type { Node, Root, RootGroup } from '../types';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  MoveRight,
  Pencil,
  Presentation,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { getLanguage, useT } from '../i18n';
import ReferencePreview from './ReferencePreview';

// ── 时间格式化 ──

/** ISO 时间戳 → 绝对日期（如 "2026-05-04 16:30"） */
function formatAbsolute(iso: string): string {
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getRootTimeBucket(iso: string, labels: { today: string; yesterday: string; recent: string; month: string }) {
  const date = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const yesterday = new Date(startOfToday);
  yesterday.setDate(yesterday.getDate() - 1);

  if (startOfDate.getTime() === startOfToday.getTime()) {
    return { key: 'today', label: labels.today };
  }
  if (startOfDate.getTime() === yesterday.getTime()) {
    return { key: 'yesterday', label: labels.yesterday };
  }

  const calendarDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  if (calendarDays > 1 && calendarDays < 7) {
    return { key: 'recent', label: labels.recent };
  }
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()) {
    return { key: 'month', label: labels.month };
  }

  const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
  const label = new Intl.DateTimeFormat(getLanguage(), { year: 'numeric', month: 'long' }).format(date);
  return { key, label };
}

interface Props {
  onConfigClick: () => void;
  onRootSelect: () => void;
}

interface SearchResult {
  type: 'node' | 'response';
  id: string;
  node_id?: string;
  root_id?: string | null;
  model_id?: string;
  content?: string;
}

const DEFAULT_GROUP_ID = '__default__';
const LS_RECENT_GROUP_COLLAPSED = 'megaform-recent-group-collapsed';
const DRAG_SCROLL_EDGE_SIZE = 48;
const DRAG_SCROLL_MAX_SPEED = 14;

function persistInBackground(task: Promise<unknown>, label: string) {
  void task.catch(err => console.error(`[sidebar] ${label} failed:`, err));
}

export default function Sidebar({ onConfigClick, onRootSelect }: Props) {
  const t = useT();
  const roots = useAppStore(s => s.roots);
  const rootGroups = useAppStore(s => s.rootGroups);
  const recentNodes = useAppStore(s => s.recentNodes);
  const currentRootId = useAppStore(s => s.currentRootId);
  const openRoot = useAppStore(s => s.openRoot);
  const focusNode = useAppStore(s => s.focusNode);
  const setActiveModelId = useAppStore(s => s.setActiveModelId);
  const setSearchScrollTarget = useAppStore(s => s.setSearchScrollTarget);
  const deleteRoot = useAppStore(s => s.deleteRoot);
  const createRootGroup = useAppStore(s => s.createRootGroup);
  const updateRootGroup = useAppStore(s => s.updateRootGroup);
  const deleteRootGroup = useAppStore(s => s.deleteRootGroup);
  const moveRootToGroup = useAppStore(s => s.moveRootToGroup);
  const triggerInputFocus = useAppStore(s => s.triggerInputFocus);
  const resetRoot = useAppStore(s => s.resetRoot);
  const loadMoreRoots = useAppStore(s => s.loadMoreRoots);
  const rootsHasMore = useAppStore(s => s.rootsHasMore);
  const rootsLoadingMore = useAppStore(s => s.rootsLoadingMore);
  const maxRootNodeCount = useMemo(
    () => Math.max(1, ...roots.map(root => root.node_count ?? 0)),
    [roots],
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [selectedSearchGroupIds, setSelectedSearchGroupIds] = useState<string[]>([]);
  const [dragRootId, setDragRootId] = useState<string | null>(null);
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [moveMenuRootId, setMoveMenuRootId] = useState<string | null>(null);
  const [pendingRootId, setPendingRootId] = useState<string | null>(null);
  const [defaultGroupCollapsed, setDefaultGroupCollapsed] = useState(false);
  const [recentGroupCollapsed, setRecentGroupCollapsed] = useState(
    () => localStorage.getItem(LS_RECENT_GROUP_COLLAPSED) === '1',
  );
  const [exitingRecentNodes, setExitingRecentNodes] = useState<Node[]>([]);

  // ── 摘要编辑状态 ──
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [editingSummaryText, setEditingSummaryText] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const dragImageRef = useRef<HTMLElement | null>(null);
  const sidebarGroupsRef = useRef<HTMLDivElement | null>(null);
  const dragScrollFrameRef = useRef<number | null>(null);
  const dragScrollVelocityRef = useRef(0);
  const previousRecentNodesRef = useRef<Node[]>([]);

  const rootsByGroup = useMemo(() => {
    const map: Record<string, Root[]> = { [DEFAULT_GROUP_ID]: [] };
    for (const group of rootGroups) map[group.id] = [];
    for (const root of roots) {
      const key = root.group_id || DEFAULT_GROUP_ID;
      if (!map[key]) map[key] = [];
      map[key].push(root);
    }
    return map;
  }, [roots, rootGroups]);

  type GroupTreeNode = RootGroup & { children: GroupTreeNode[] };

  const groupTree = useMemo(() => {
    const nodes = new Map<string, GroupTreeNode>();
    const roots: GroupTreeNode[] = [];
    for (const group of rootGroups) {
      nodes.set(group.id, { ...group, children: [] });
    }
    for (const group of rootGroups) {
      const node = nodes.get(group.id)!;
      const parent = group.parent_id ? nodes.get(group.parent_id) : null;
      if (parent && parent.id !== node.id) parent.children.push(node);
      else roots.push(node);
    }
    const sortGroups = (list: GroupTreeNode[]) => {
      list.sort((a, b) => (a.sort_order - b.sort_order) || a.created_at.localeCompare(b.created_at));
      list.forEach(group => sortGroups(group.children));
    };
    sortGroups(roots);
    return roots;
  }, [rootGroups]);

  const searchGroups = useMemo(
    () => [
      ...rootGroups.map(group => ({ id: group.id, name: group.name })),
      { id: DEFAULT_GROUP_ID, name: t('chats') },
    ],
    [rootGroups, t],
  );

  /** 自动聚焦编辑框 */
  useEffect(() => {
    if (editingSummaryId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSummaryId]);

  useEffect(() => {
    const nextIds = new Set(recentNodes.map(n => n.id));
    const removed = previousRecentNodesRef.current.filter(n => !nextIds.has(n.id));
    if (removed.length > 0) {
      const removedIds = new Set(removed.map(n => n.id));
      setExitingRecentNodes(prev => [
        ...prev.filter(n => !removedIds.has(n.id)),
        ...removed,
      ]);
      window.setTimeout(() => {
        setExitingRecentNodes(prev => prev.filter(n => !removedIds.has(n.id)));
      }, 220);
    }
    previousRecentNodesRef.current = recentNodes;
  }, [recentNodes]);

  useEffect(() => () => stopDragAutoScroll(), []);

  const maybeLoadMoreRoots = () => {
    const container = sidebarGroupsRef.current;
    if (!container || !rootsHasMore || rootsLoadingMore) return;
    const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (remaining < 160) {
      loadMoreRoots().catch(err => console.error('[roots] load more failed:', err));
    }
  };

  useEffect(() => {
    const container = sidebarGroupsRef.current;
    if (!container || !rootsHasMore || rootsLoadingMore) return;
    if (container.scrollHeight <= container.clientHeight + 8) {
      loadMoreRoots().catch(err => console.error('[roots] load more failed:', err));
    }
  }, [roots.length, rootsHasMore, rootsLoadingMore, loadMoreRoots]);

  /** 保存摘要 */
  const saveSummary = async (rootId: string) => {
    const text = editingSummaryText.trim();
    setEditingSummaryId(null);
    try {
      await api.updateRoot(rootId, { summary: text } as any);
      const store = useAppStore.getState();
      useAppStore.setState((prev: any) => ({
        recentNodes: (prev.recentNodes || []).map((node: any) =>
          node.id === rootId ? { ...node, summary: text } : node
        ),
        nodeCache: prev.nodeCache?.[rootId]
          ? { ...prev.nodeCache, [rootId]: { ...prev.nodeCache[rootId], summary: text } }
          : prev.nodeCache,
      }));
      store.fetchRoots();
    } catch {
      // 静默失败，下次 fetchRoots 会同步
    }
  };

  const runSearch = async (q: string, groupIds: string[]) => {
    if (q.trim().length < 2) {
      setSearchResults([]);
      setShowSearch(false);
      return;
    }
    try {
      const results = await api.search(q, groupIds) as SearchResult[];
      setSearchResults(results);
      setShowSearch(true);
    } catch {
      setSearchResults([]);
    }
  };

  /** 处理搜索：输入 ≥ 2 个字符时向后端发起搜索请求 */
  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    await runSearch(q, selectedSearchGroupIds);
  };

  const toggleSearchGroup = (groupId: string) => {
    setSelectedSearchGroupIds(prev => {
      const next = prev.includes(groupId)
        ? prev.filter(id => id !== groupId)
        : [...prev, groupId];
      runSearch(searchQuery, next);
      return next;
    });
  };

  /** 选中搜索结果：打开对应树、切换深链接到命中节点，并滚动到命中词 */
  const handleSearchResultSelect = async (r: SearchResult) => {
    const nodeId = r.type === 'response' ? r.node_id : r.id;
    if (!r.root_id || !nodeId) return;

    setShowSearch(false);
    await openRoot(r.root_id, { markRecent: false });
    if (r.type === 'response' && r.model_id) {
      setActiveModelId(nodeId, r.model_id);
    }
    focusNode(nodeId);
    setSearchScrollTarget({
      nodeId,
      type: r.type === 'response' ? 'response' : 'node',
      modelId: r.type === 'response' ? r.model_id : undefined,
      query: searchQuery.trim(),
    });
    window.history.pushState(null, '', '/node/' + nodeId);
    onRootSelect();
  };

  /** 删除问题树（带确认） */
  const handleDeleteRoot = (e: React.MouseEvent, rootId: string) => {
    e.stopPropagation();
    if (confirm(t('deleteRootConfirm'))) {
      persistInBackground(deleteRoot(rootId), 'delete root');
    }
  };

  const handleCreateGroup = async (parentId?: string | null) => {
    const name = prompt(t('newGroupName'), '');
    if (!name?.trim()) return;
    await createRootGroup(name.trim(), parentId || null);
    if (parentId) {
      const parent = rootGroups.find(group => group.id === parentId);
      if (parent?.collapsed) {
        persistInBackground(
          updateRootGroup(parentId, { collapsed: 0 } as Partial<RootGroup>),
          'expand parent group',
        );
      }
    }
  };

  const handleRenameGroup = (groupId: string, currentName: string) => {
    const name = prompt(t('renameGroup'), currentName);
    if (!name?.trim()) return;
    persistInBackground(updateRootGroup(groupId, { name: name.trim() }), 'rename group');
  };

  const handleDeleteGroup = (groupId: string) => {
    if (!confirm(t('deleteGroupConfirm'))) return;
    persistInBackground(deleteRootGroup(groupId), 'delete group');
  };

  const getGroupDragKey = (groupId: string | null) => groupId || DEFAULT_GROUP_ID;

  const isGroupDescendant = (groupId: string, possibleDescendantId: string | null) => {
    if (!possibleDescendantId) return false;
    let current = rootGroups.find(group => group.id === possibleDescendantId) || null;
    while (current?.parent_id) {
      if (current.parent_id === groupId) return true;
      current = rootGroups.find(group => group.id === current?.parent_id) || null;
    }
    return false;
  };

  const stopDragAutoScroll = () => {
    dragScrollVelocityRef.current = 0;
    if (dragScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = null;
    }
  };

  const tickDragAutoScroll = () => {
    const container = sidebarGroupsRef.current;
    const velocity = dragScrollVelocityRef.current;
    if (!container || velocity === 0) {
      dragScrollFrameRef.current = null;
      return;
    }
    container.scrollTop += velocity;
    dragScrollFrameRef.current = window.requestAnimationFrame(tickDragAutoScroll);
  };

  const updateDragAutoScroll = (e: React.DragEvent) => {
    const container = sidebarGroupsRef.current;
    const dragKind = e.dataTransfer.getData('application/x-megaform-drag-kind');
    if (!container || (!dragRootId && !dragGroupId && !dragKind)) {
      stopDragAutoScroll();
      return;
    }
    const rect = container.getBoundingClientRect();
    let velocity = 0;
    if (e.clientY < rect.top + DRAG_SCROLL_EDGE_SIZE) {
      const distance = rect.top + DRAG_SCROLL_EDGE_SIZE - e.clientY;
      velocity = -Math.max(3, Math.min(DRAG_SCROLL_MAX_SPEED, distance / 3));
    } else if (e.clientY > rect.bottom - DRAG_SCROLL_EDGE_SIZE) {
      const distance = e.clientY - (rect.bottom - DRAG_SCROLL_EDGE_SIZE);
      velocity = Math.max(3, Math.min(DRAG_SCROLL_MAX_SPEED, distance / 3));
    }

    dragScrollVelocityRef.current = velocity;
    if (velocity !== 0 && dragScrollFrameRef.current === null) {
      dragScrollFrameRef.current = window.requestAnimationFrame(tickDragAutoScroll);
    } else if (velocity === 0 && dragScrollFrameRef.current !== null) {
      stopDragAutoScroll();
    }
  };

  const handleRootDragStart = (e: React.DragEvent<HTMLDivElement>, root: Root) => {
    e.stopPropagation();
    dragImageRef.current?.remove();
    setDragRootId(root.id);
    setDragGroupId(null);
    setDragOverGroupId(getGroupDragKey(root.group_id || null));
    setMoveMenuRootId(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', root.id);
    e.dataTransfer.setData('application/x-megaform-drag-kind', 'root');

    const source = e.currentTarget;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.classList.add('root-drag-image');
    clone.classList.remove('dragging');
    clone.style.width = `${source.offsetWidth}px`;
    document.body.appendChild(clone);
    dragImageRef.current = clone;
    e.dataTransfer.setDragImage(clone, 18, Math.max(18, source.offsetHeight / 2));
  };

  const handleGroupDragStart = (e: React.DragEvent<HTMLDivElement>, group: RootGroup) => {
    e.stopPropagation();
    dragImageRef.current?.remove();
    setDragGroupId(group.id);
    setDragRootId(null);
    setDragOverGroupId(getGroupDragKey(group.parent_id || null));
    setMoveMenuRootId(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', group.id);
    e.dataTransfer.setData('application/x-megaform-drag-kind', 'group');

    const source = e.currentTarget;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.classList.add('root-drag-image');
    clone.classList.remove('dragging');
    clone.style.width = `${source.offsetWidth}px`;
    document.body.appendChild(clone);
    dragImageRef.current = clone;
    e.dataTransfer.setDragImage(clone, 18, Math.max(18, source.offsetHeight / 2));
  };

  const handleGroupDragOver = (e: React.DragEvent, groupId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const dragKind = e.dataTransfer.getData('application/x-megaform-drag-kind');
    const transferredId = e.dataTransfer.getData('text/plain');
    const draggedGroupId = dragKind === 'group' ? transferredId : dragGroupId;
    const invalidGroupDrop = !!draggedGroupId
      && (draggedGroupId === groupId || isGroupDescendant(draggedGroupId, groupId));
    e.dataTransfer.dropEffect = invalidGroupDrop ? 'none' : 'move';
    setDragOverGroupId(invalidGroupDrop ? null : getGroupDragKey(groupId));
    updateDragAutoScroll(e);
  };

  const handleGroupsDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const dragKind = e.dataTransfer.getData('application/x-megaform-drag-kind');
    if (!dragRootId && !dragGroupId && !dragKind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    updateDragAutoScroll(e);
  };

  const handleGroupsDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = e.relatedTarget as globalThis.Node | null;
    if (!nextTarget || !e.currentTarget.contains(nextTarget)) {
      stopDragAutoScroll();
    }
  };

  const clearDragState = () => {
    dragImageRef.current?.remove();
    dragImageRef.current = null;
    stopDragAutoScroll();
    setDragRootId(null);
    setDragGroupId(null);
    setDragOverGroupId(null);
  };

  const handleDropOnGroup = (
    e: React.DragEvent,
    groupId: string | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const dragKind = e.dataTransfer.getData('application/x-megaform-drag-kind');
    const transferredId = e.dataTransfer.getData('text/plain');
    const droppedRootId = dragKind === 'root' ? transferredId : dragRootId;
    const droppedGroupId = dragKind === 'group' ? transferredId : dragGroupId;
    if (!droppedRootId && !droppedGroupId) {
      clearDragState();
      return;
    }
    clearDragState();
    if (droppedRootId) {
      persistInBackground(moveRootToGroup(droppedRootId, groupId), 'move root');
    } else if (droppedGroupId) {
      if (droppedGroupId !== groupId && !isGroupDescendant(droppedGroupId, groupId)) {
        persistInBackground(
          updateRootGroup(droppedGroupId, { parent_id: groupId } as Partial<RootGroup>),
          'move group',
        );
        if (groupId) {
          const target = rootGroups.find(group => group.id === groupId);
          if (target?.collapsed) {
            persistInBackground(
              updateRootGroup(groupId, { collapsed: 0 } as Partial<RootGroup>),
              'expand drop target',
            );
          }
        }
      }
    }
  };

  const getRootVolumeLevel = (nodeCount = 0) => {
    if (nodeCount <= 1 || maxRootNodeCount <= 1) return 1;
    const normalized = Math.log(nodeCount) / Math.log(maxRootNodeCount);
    return Math.min(4, Math.max(1, Math.ceil(normalized * 4)));
  };

  const truncateTextWithEllipsis = (text: string, maxLen: number): string => {
    const chars = Array.from(text.trim());
    return chars.length > maxLen ? `${chars.slice(0, maxLen).join('')}...` : chars.join('');
  };

  const moveRootFromMenu = (rootId: string, groupId: string | null) => {
    setMoveMenuRootId(null);
    persistInBackground(moveRootToGroup(rootId, groupId), 'move root');
  };

  const handleRecentNodeSelect = async (node: Node) => {
    window.history.pushState(null, '', '/node/' + node.id);
    onRootSelect();
    if (node.root_id && currentRootId !== node.root_id) {
      await openRoot(node.root_id, { markRecent: false });
    }
    focusNode(node.id);
  };

  const renderRecentNodeItem = (node: Node, exiting = false) => {
    const text = node.summary || node.content;
    const followupQuote = node.relation === 'followup' ? node.followup_quote?.trim() : '';
    return (
      <button
        key={`${exiting ? 'exit' : 'recent'}-${node.id}`}
        className={`recent-node-item${node.root_id === currentRootId ? ' active' : ''}${exiting ? ' exiting' : ''}`}
        onClick={() => !exiting && handleRecentNodeSelect(node)}
        disabled={exiting}
        title={node.content}
      >
        <span className="recent-node-dot" aria-hidden="true" />
        <span className="question-display recent-node-display">
          <span className="question-text">
            {followupQuote ? (
              <>
                <ReferencePreview text={followupQuote} />
                <MoveRight className="collapsed-reference-arrow" size={13} aria-hidden="true" />
                {text}
              </>
            ) : (
              text
            )}
          </span>
        </span>
      </button>
    );
  };

  const renderRecentGroup = () => {
    const displayExiting = exitingRecentNodes.filter(n => !recentNodes.some(r => r.id === n.id));
    const toggleRecentCollapsed = () => {
      setRecentGroupCollapsed(value => {
        const next = !value;
        localStorage.setItem(LS_RECENT_GROUP_COLLAPSED, next ? '1' : '0');
        return next;
      });
    };
    return (
      <div className="sidebar-group recent-sidebar-group">
        <div className="sidebar-section-title sidebar-group-title no-actions">
          <button
            className="sidebar-group-collapse"
            onClick={toggleRecentCollapsed}
            title={recentGroupCollapsed ? t('expandGroup') : t('collapseGroup')}
          >
            {recentGroupCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <Presentation size={16} />
          <span>{t('recentVisited')}</span>
        </div>
        <div className={`sidebar-group-body ${recentGroupCollapsed ? 'collapsed' : 'expanded'}`}>
          <div className="sidebar-group-body-inner">
            <div className="root-list recent-node-list">
              {recentNodes.map(node => renderRecentNodeItem(node, false))}
              {displayExiting.map(node => renderRecentNodeItem(node, true))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderMoveMenu = (root: Root) => (
    <div className="root-move-menu" onClick={e => e.stopPropagation()}>
      <button onClick={() => moveRootFromMenu(root.id, null)}>
        {t('chats')}
      </button>
      {rootGroups.map(group => (
        <button key={group.id} onClick={() => moveRootFromMenu(root.id, group.id)}>
          {group.name}
        </button>
      ))}
      <button onClick={async () => {
        const name = prompt(t('newGroupName'), '');
        if (!name?.trim()) return;
        const created = await createRootGroup(name.trim());
        await moveRootFromMenu(root.id, created.id);
      }}>
        {t('newGroup')}
      </button>
    </div>
  );

  const renderRootItem = (root: Root) => (
    <div
      key={root.id}
      className={`root-item root-volume-${getRootVolumeLevel(root.node_count)} ${root.id === (pendingRootId || currentRootId) ? 'active' : ''} ${dragRootId === root.id ? 'dragging' : ''}`}
      draggable
      onDragStart={e => handleRootDragStart(e, root)}
      onDragEnd={clearDragState}
      onDragOver={e => handleGroupDragOver(e, root.group_id || null)}
      onDrop={e => handleDropOnGroup(e, root.group_id || null)}
      onClick={() => {
        setPendingRootId(root.id);
        window.history.pushState(null, '', '/root/' + root.id);
        onRootSelect();
        void openRoot(root.id).finally(() => {
          setPendingRootId(current => current === root.id ? null : current);
        });
      }}
    >
      <div className="root-item-main">
        {/* 有摘要则用摘要替代根问题，否则显示根问题 */}
        {editingSummaryId === root.id ? (
          <input
            ref={editInputRef}
            className="root-summary-edit"
            value={editingSummaryText}
            onChange={e => setEditingSummaryText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); saveSummary(root.id); }
              if (e.key === 'Escape') { setEditingSummaryId(null); }
            }}
            onBlur={() => saveSummary(root.id)}
            onClick={e => e.stopPropagation()}
            placeholder={t('summaryPlaceholder')}
          />
        ) : (
          <span
            className="root-title"
            title={`${root.content}\n${t('updatedAt', { time: formatAbsolute(root.updated_at) })}`}
          >
            {root.summary || root.content}
          </span>
        )}
      </div>
      <div className="root-actions">
        <button
          onClick={e => {
            e.stopPropagation();
            setEditingSummaryId(root.id);
            setEditingSummaryText(root.summary || '');
          }}
          title={t('editSummary')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={e => {
            e.stopPropagation();
            setMoveMenuRootId(moveMenuRootId === root.id ? null : root.id);
          }}
          title={t('moveToGroup')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}
        >
          <Folder size={13} />
        </button>
        <button
          onClick={e => handleDeleteRoot(e, root.id)}
          title={t('delete')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#ef4444' }}
        >
          <X size={13} />
        </button>
      </div>
      {moveMenuRootId === root.id && renderMoveMenu(root)}
    </div>
  );

  const renderRootListItems = (items: Root[]) => {
    const labels = {
      today: t('sidebarTimeToday'),
      yesterday: t('sidebarTimeYesterday'),
      recent: t('sidebarTimeRecent'),
      month: t('sidebarTimeThisMonth'),
    };
    const clusters: Array<{ key: string; label: string; roots: Root[] }> = [];
    for (const root of items) {
      const bucket = getRootTimeBucket(root.updated_at, labels);
      const current = clusters[clusters.length - 1];
      if (current?.key === bucket.key) current.roots.push(root);
      else clusters.push({ ...bucket, roots: [root] });
    }
    return clusters.map((cluster, index) => (
      <div className="root-time-cluster" key={`${cluster.key}-${index}`}>
        <div className="root-time-cluster-label">{cluster.label}</div>
        {cluster.roots.map(renderRootItem)}
      </div>
    ));
  };

  const renderGroupSection = (
    id: string | null,
    name: string,
    collapsed: boolean,
    items: Root[],
    opts?: { groupId?: string; group?: GroupTreeNode; depth?: number },
  ) => {
    const targetGroupId = id === DEFAULT_GROUP_ID ? null : id;
    const dragKey = getGroupDragKey(targetGroupId);
    const depth = opts?.depth || 0;
    const childGroups = opts?.group?.children || [];
    const canDragGroup = !!opts?.groupId;
    return (
      <div
        className={`sidebar-group ${dragOverGroupId === dragKey ? 'drag-over' : ''} ${dragGroupId === opts?.groupId ? 'dragging' : ''}`}
        key={id || DEFAULT_GROUP_ID}
        style={{ '--group-depth': depth } as CSSProperties}
      >
        <div
          className={`sidebar-section-title sidebar-group-title ${opts?.groupId ? 'has-actions' : 'no-actions'}`}
          draggable={canDragGroup}
          onDragStart={canDragGroup && opts?.group ? e => handleGroupDragStart(e, opts.group!) : undefined}
          onDragEnd={canDragGroup ? clearDragState : undefined}
          onDragOver={e => handleGroupDragOver(e, targetGroupId)}
          onDrop={e => handleDropOnGroup(e, targetGroupId)}
        >
          <button
            className="sidebar-group-collapse"
            draggable={false}
            onClick={() => opts?.groupId
              ? persistInBackground(
                  updateRootGroup(opts.groupId, { collapsed: collapsed ? 0 : 1 }),
                  'toggle group',
                )
              : setDefaultGroupCollapsed(v => !v)}
            title={collapsed ? t('expandGroup') : t('collapseGroup')}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          {id === DEFAULT_GROUP_ID ? <MessageSquare size={16} /> : <Folder size={16} />}
          <span>{name}</span>
          {opts?.groupId && (
            <div className="sidebar-group-actions">
              <button
                onClick={async e => {
                  e.stopPropagation();
                  await handleCreateGroup(opts.groupId!);
                }}
                draggable={false}
                title={t('newGroup')}
              >
                <FolderPlus size={13} />
              </button>
              <button draggable={false} onClick={e => { e.stopPropagation(); handleRenameGroup(opts.groupId!, name); }} title={t('renameGroup')}>
                <Pencil size={13} />
              </button>
              <button draggable={false} onClick={e => { e.stopPropagation(); handleDeleteGroup(opts.groupId!); }} title={t('delete')}>
                <X size={13} />
              </button>
            </div>
          )}
          <span className="sidebar-group-count">{items.length}</span>
        </div>
        <div className={`sidebar-group-body ${collapsed ? 'collapsed' : 'expanded'}`}>
          <div className="sidebar-group-body-inner">
            {childGroups.length > 0 && (
              <div className="sidebar-group-children">
                {childGroups.map(child => renderGroupSection(
                  child.id,
                  child.name,
                  !!child.collapsed,
                  rootsByGroup[child.id] || [],
                  { groupId: child.id, group: child, depth: depth + 1 },
                ))}
              </div>
            )}
            <div
              className="root-list"
              onDragOver={e => handleGroupDragOver(e, targetGroupId)}
              onDrop={e => handleDropOnGroup(e, targetGroupId)}
            >
              {renderRootListItems(items)}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Header */}
      <div className="sidebar-header">
        <img src="/favicon.svg" alt="MegaForm Logo" style={{ width: 24, height: 24 }} />
        <h1>MegaForm</h1>
      </div>

      {/* Search */}
      <div className="sidebar-search" style={{ position: 'relative' }}>
        <Search className="sidebar-search-icon" size={15} />
        <input
          type="text"
          placeholder={t('searchChats')}
          value={searchQuery}
          onChange={e => handleSearch(e.target.value)}
          onBlur={() => setTimeout(() => setShowSearch(false), 200)}
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid var(--megaform-border)',
            borderRadius: 8,
            fontSize: 13,
            outline: 'none',
            background: 'var(--megaform-bg)',
          }}
        />
        {(searchQuery.trim().length >= 2 || selectedSearchGroupIds.length > 0) && (
          <div
            className="sidebar-search-groups"
            onMouseDown={e => e.preventDefault()}
          >
            {searchGroups.map(group => (
              <button
                key={group.id}
                className={`sidebar-search-group-chip ${selectedSearchGroupIds.includes(group.id) ? 'selected' : ''}`}
                onClick={() => toggleSearchGroup(group.id)}
                title={group.name}
              >
                {group.name}
              </button>
            ))}
          </div>
        )}
        {showSearch && searchResults.length > 0 && (
          <div className="search-results">
            {searchResults.map((r, i) => (
              <div
                key={i}
                className="search-result-item"
                onClick={() => handleSearchResultSelect(r)}
              >
                <div className="search-result-title">
                  {r.content?.slice(0, 40) || t('searchResult')}
                </div>
                <div className="search-result-snippet">
                  {r.content?.slice(0, 100)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-primary-actions">
        <button
          className="sidebar-action-btn"
          onClick={() => {
            resetRoot();
            triggerInputFocus();
            onRootSelect();
          }}
        >
          <Pencil size={17} />
          <span>{t('newQuestion')}</span>
        </button>
        <button className="sidebar-action-btn" onClick={onConfigClick}>
          <Settings size={17} />
          <span>{t('settings')}</span>
        </button>
      </div>

      <div className="sidebar-group-toolbar">
        <button onClick={() => handleCreateGroup()} title={t('newGroup')}>
          <FolderPlus size={15} />
          <span>{t('newGroup')}</span>
        </button>
      </div>

      <div
        className="sidebar-groups"
        ref={sidebarGroupsRef}
        onScroll={maybeLoadMoreRoots}
        onDragOver={handleGroupsDragOver}
        onDragLeave={handleGroupsDragLeave}
      >
        {renderRecentGroup()}
        {groupTree.map(group => renderGroupSection(
          group.id,
          group.name,
          !!group.collapsed,
          rootsByGroup[group.id] || [],
          { groupId: group.id, group, depth: 0 },
        ))}
        {renderGroupSection(
          DEFAULT_GROUP_ID,
          t('chats'),
          defaultGroupCollapsed,
          rootsByGroup[DEFAULT_GROUP_ID] || [],
        )}
        {rootsLoadingMore && (
          <div className="sidebar-roots-loading">{t('loading')}</div>
        )}
      </div>
    </>
  );
}
