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
import { useState, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../api/client';
import type { Root } from '../types';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  Pencil,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { getLanguage, tr, useT } from '../i18n';

// ── 时间格式化 ──

/** ISO 时间戳 → 相对时间（如 "3小时前"、"2天前"、"刚刚"） */
function formatRelative(iso: string): string {
  const language = getLanguage();
  const now = Date.now();
  const then = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const diff = now - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return tr('justNow', undefined, language);
  const min = Math.floor(diff / 60 / 1000);
  if (min < 60) return tr('minutesAgo', { count: min }, language);
  const hr = Math.floor(min / 60);
  if (hr < 24) return tr('hoursAgo', { count: hr }, language);
  const day = Math.floor(hr / 24);
  if (day < 30) return tr('daysAgo', { count: day }, language);
  const mon = Math.floor(day / 30);
  return tr('monthsAgo', { count: mon }, language);
}

/** ISO 时间戳 → 绝对日期（如 "2026-05-04 16:30"） */
function formatAbsolute(iso: string): string {
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

export default function Sidebar({ onConfigClick, onRootSelect }: Props) {
  const t = useT();
  const roots = useAppStore(s => s.roots);
  const rootGroups = useAppStore(s => s.rootGroups);
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
  const maxRootNodeCount = useMemo(
    () => Math.max(1, ...roots.map(root => root.node_count ?? 0)),
    [roots],
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [selectedSearchGroupIds, setSelectedSearchGroupIds] = useState<string[]>([]);
  const [dragRootId, setDragRootId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [moveMenuRootId, setMoveMenuRootId] = useState<string | null>(null);
  const [defaultGroupCollapsed, setDefaultGroupCollapsed] = useState(false);

  // ── 摘要编辑状态 ──
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [editingSummaryText, setEditingSummaryText] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  const dragImageRef = useRef<HTMLElement | null>(null);

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

  /** 保存摘要 */
  const saveSummary = async (rootId: string) => {
    const text = editingSummaryText.trim();
    setEditingSummaryId(null);
    try {
      await api.updateRoot(rootId, { summary: text } as any);
      const store = useAppStore.getState();
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
    await openRoot(r.root_id);
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
  const handleDeleteRoot = async (e: React.MouseEvent, rootId: string) => {
    e.stopPropagation();
    if (confirm(t('deleteRootConfirm'))) {
      await deleteRoot(rootId);
    }
  };

  const handleCreateGroup = async () => {
    const name = prompt(t('newGroupName'), '');
    if (!name?.trim()) return;
    await createRootGroup(name.trim());
  };

  const handleRenameGroup = async (groupId: string, currentName: string) => {
    const name = prompt(t('renameGroup'), currentName);
    if (!name?.trim()) return;
    await updateRootGroup(groupId, { name: name.trim() } as any);
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm(t('deleteGroupConfirm'))) return;
    await deleteRootGroup(groupId);
  };

  const getGroupDragKey = (groupId: string | null) => groupId || DEFAULT_GROUP_ID;

  const handleRootDragStart = (e: React.DragEvent<HTMLDivElement>, root: Root) => {
    dragImageRef.current?.remove();
    setDragRootId(root.id);
    setDragOverGroupId(getGroupDragKey(root.group_id || null));
    setMoveMenuRootId(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', root.id);

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
    e.dataTransfer.dropEffect = 'move';
    setDragOverGroupId(getGroupDragKey(groupId));
  };

  const clearDragState = () => {
    dragImageRef.current?.remove();
    dragImageRef.current = null;
    setDragRootId(null);
    setDragOverGroupId(null);
  };

  const handleDropRoot = async (
    e: React.DragEvent,
    groupId: string | null,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragRootId) {
      clearDragState();
      return;
    }
    try {
      await moveRootToGroup(dragRootId, groupId);
    } finally {
      clearDragState();
    }
  };

  const getRootVolumeLevel = (nodeCount = 0) => {
    if (nodeCount <= 1 || maxRootNodeCount <= 1) return 1;
    const normalized = Math.log(nodeCount) / Math.log(maxRootNodeCount);
    return Math.min(4, Math.max(1, Math.ceil(normalized * 4)));
  };

  const moveRootFromMenu = async (rootId: string, groupId: string | null) => {
    await moveRootToGroup(rootId, groupId);
    setMoveMenuRootId(null);
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
        await createRootGroup(name.trim());
        const groups = useAppStore.getState().rootGroups;
        const created = groups[groups.length - 1];
        if (created) await moveRootFromMenu(root.id, created.id);
      }}>
        {t('newGroup')}
      </button>
    </div>
  );

  const renderRootItem = (root: Root) => (
    <div
      key={root.id}
      className={`root-item root-volume-${getRootVolumeLevel(root.node_count)} ${root.id === currentRootId ? 'active' : ''} ${dragRootId === root.id ? 'dragging' : ''}`}
      draggable
      onDragStart={e => handleRootDragStart(e, root)}
      onDragEnd={clearDragState}
      onDragOver={e => handleGroupDragOver(e, root.group_id || null)}
      onDrop={e => handleDropRoot(e, root.group_id || null)}
      onClick={() => { openRoot(root.id); window.history.pushState(null, '', '/root/' + root.id); onRootSelect(); }}
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
          <span className="root-title" title={root.content}>
            {root.summary || root.content}
          </span>
        )}
        <span className="root-time" title={formatAbsolute(root.updated_at)}>
          {formatRelative(root.updated_at)}
        </span>
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

  const renderGroupSection = (
    id: string | null,
    name: string,
    collapsed: boolean,
    items: Root[],
    opts?: { groupId?: string },
  ) => {
    const targetGroupId = id === DEFAULT_GROUP_ID ? null : id;
    const dragKey = getGroupDragKey(targetGroupId);
    return (
      <div className={`sidebar-group ${dragOverGroupId === dragKey ? 'drag-over' : ''}`} key={id || DEFAULT_GROUP_ID}>
        <div
          className={`sidebar-section-title sidebar-group-title ${opts?.groupId ? 'has-actions' : 'no-actions'}`}
          onDragOver={e => handleGroupDragOver(e, targetGroupId)}
          onDrop={e => handleDropRoot(e, targetGroupId)}
        >
          <button
            className="sidebar-group-collapse"
            onClick={() => opts?.groupId
              ? updateRootGroup(opts.groupId, { collapsed: collapsed ? 0 : 1 } as any)
              : setDefaultGroupCollapsed(v => !v)}
            title={collapsed ? t('expandGroup') : t('collapseGroup')}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          {id === DEFAULT_GROUP_ID ? <MessageSquare size={16} /> : <Folder size={16} />}
          <span>{name}</span>
          {opts?.groupId && (
            <div className="sidebar-group-actions">
              <button onClick={() => handleRenameGroup(opts.groupId!, name)} title={t('renameGroup')}>
                <Pencil size={13} />
              </button>
              <button onClick={() => handleDeleteGroup(opts.groupId!)} title={t('delete')}>
                <X size={13} />
              </button>
            </div>
          )}
          <span className="sidebar-group-count">{items.length}</span>
        </div>
        <div className={`sidebar-group-body ${collapsed ? 'collapsed' : 'expanded'}`}>
          <div
            className="root-list"
            onDragOver={e => handleGroupDragOver(e, targetGroupId)}
            onDrop={e => handleDropRoot(e, targetGroupId)}
          >
            {items.map(renderRootItem)}
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
        <button onClick={handleCreateGroup} title={t('newGroup')}>
          <FolderPlus size={15} />
          <span>{t('newGroup')}</span>
        </button>
      </div>

      <div className="sidebar-groups">
        {rootGroups.map(group => renderGroupSection(
          group.id,
          group.name,
          !!group.collapsed,
          rootsByGroup[group.id] || [],
          { groupId: group.id },
        ))}
        {renderGroupSection(
          DEFAULT_GROUP_ID,
          t('chats'),
          defaultGroupCollapsed,
          rootsByGroup[DEFAULT_GROUP_ID] || [],
        )}
      </div>
    </>
  );
}
