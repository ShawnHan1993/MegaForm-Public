/**
 * FrozenModelBar — 冻结区模型选择栏
 * 
 * 当用户滚动聊天区域、节点的原始模型 tab 栏滚出视口时，
 * 该节点的模型 tabs 会「冻结」在面包屑导航下方。
 * 冻结状态在 ChatArea 中以栈维护，本组件只渲染传入的栈顶条目。
 * 
 * FLIP 动画：新冻结行的芯片从原 model-bar 位置平滑飞入。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '../store/appStore';
import { useT } from '../i18n';

export interface FrozenEntry {
  nodeId: string;
  /** 该节点的问题文本（用于展示） */
  question: string;
  /** 该节点的回答模型 ID 列表 */
  modelIds: string[];
  /** 与父节点的关系，用于保留冻结条来源语义 */
  relation: 'followup' | 'progression';
}

/** FLIP 捕获数据：nodeId → modelId → 芯片在原始 model-bar 中的 position */
export type FlipCaptures = Record<string, Record<string, DOMRect>>;

interface Props {
  entries: FrozenEntry[];
  /** 当前冻结栈深度，用于区分入栈/出栈动画 */
  stackDepth?: number;
  /** 栈顶离场模式 */
  exitMode?: 'none' | 'pop-out';
  /** 选择模型后自动滚动到对应回复顶部 */
  onSelectModel?: (nodeId: string, modelId: string) => void;
  /** FLIP 动画的 First-position 捕获数据 ref */
  flipCapturesRef?: React.MutableRefObject<FlipCaptures>;
  /** 面包屑导航高度，用于向下偏移冻结栏（悬浮布局时） */
  top?: number;
  /** 移动端跟随面包屑自动显隐 */
  visible?: boolean;
}

const FLIP_DURATION = '0.28s';
const FLIP_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';
const ROW_EXIT_X = 96;
const ROW_POP_OUT_DURATION = 0.42;
const ROW_EXIT_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const rowVariants = {
  animate: {
    opacity: 1,
    x: 0,
  },
  exit: (mode: 'none' | 'pop-out') => ({
    opacity: 0,
    x: mode === 'pop-out' ? ROW_EXIT_X : 0,
    transition: {
      duration: mode === 'pop-out' ? ROW_POP_OUT_DURATION : 0.08,
      ease: ROW_EXIT_EASE,
    },
  }),
};

export default function FrozenModelBar({
  entries,
  stackDepth = entries.length,
  exitMode = 'none',
  onSelectModel,
  flipCapturesRef,
  top,
  visible = true,
}: Props) {
  const t = useT();
  const models = useAppStore(s => s.models);
  const activeModelId = useAppStore(s => s.activeModelId);
  const setActiveModelId = useAppStore(s => s.setActiveModelId);
  const focusNode = useAppStore(s => s.focusNode);
  const [shellActive, setShellActive] = useState(entries.length > 0);
  const visibleEntries = useMemo(
    () => entries.length > 0 ? [entries[entries.length - 1]] : [],
    [entries]
  );

  useEffect(() => {
    if (entries.length > 0) {
      setShellActive(true);
    } else if (exitMode !== 'pop-out') {
      setShellActive(false);
    }
  }, [entries.length, exitMode, stackDepth]);

  // ── FLIP 动画：新冻结行从原始 model-bar 位置飞入 ──
  useEffect(() => {
    const captures = flipCapturesRef?.current;
    if (!captures || Object.keys(captures).length === 0) return;

    for (const entry of visibleEntries) {
      const nodeId = entry.nodeId;
      const chipCaptures = captures[nodeId];
      if (!chipCaptures) continue;

      const frozenRow = document.querySelector<HTMLElement>(
        `.frozen-model-bar [data-frozen-row="${nodeId}"]`
      );
      if (!frozenRow) continue;

      // Invert：把每个芯片横向拉回到原始 model-bar 位置（仅横坐标动画，纵坐标始终为0）
      const chips: { el: HTMLElement; dx: number }[] = [];
      entry.modelIds.forEach(mid => {
        const chipEl = frozenRow.querySelector<HTMLElement>(`[data-frozen-chip="${mid}"]`);
        const firstRect = chipCaptures[mid];
        if (!chipEl || !firstRect) return;

        const lastRect = chipEl.getBoundingClientRect();
        const dx = firstRect.left - lastRect.left;

        chips.push({ el: chipEl, dx });
        chipEl.style.transition = 'none';
        chipEl.style.transform = `translateX(${dx}px)`;
      });

      if (chips.length === 0) continue;

      // 强制布局刷新：确保所有芯片的 Invert 样式都已生效
      chips.forEach(({ el }) => void el.offsetHeight);

      // Play：下一帧取消 transform，transition 接手动画
      requestAnimationFrame(() => {
        chips.forEach(({ el }) => {
          el.style.transition = `transform ${FLIP_DURATION} ${FLIP_EASING}`;
          el.style.transform = '';
        });
      });

      // 消费捕获（下次重新冻结时会重新捕获 → 再次触发动画）
      delete captures[nodeId];
    }
  }, [visibleEntries, flipCapturesRef]);

  const getModelName = (mid: string) => models.find(m => m.id === mid)?.name || mid;
  const isDeletedModel = (mid: string) => models.find(m => m.id === mid)?.deleted === 1;

  const handleModelClick = (nodeId: string, mid: string) => {
    setActiveModelId(nodeId, mid);
    onSelectModel?.(nodeId, mid);
  };

  return (
    <div
      className={`frozen-bar-shell${shellActive ? ' has-entries' : ''}${visible ? '' : ' hidden'}`}
      style={top != null ? { top } : undefined}
    >
      <div className="frozen-model-bar">
        <AnimatePresence
          initial={false}
          mode="popLayout"
          custom={exitMode}
          onExitComplete={() => {
            if (visibleEntries.length === 0) setShellActive(false);
          }}
        >
        {visibleEntries.map((entry) => {
          const sortedModelIds = [...entry.modelIds].sort((a, b) => {
            const aDeleted = isDeletedModel(a);
            const bDeleted = isDeletedModel(b);
            if (aDeleted !== bDeleted) return aDeleted ? 1 : -1;
            return 0;
          });
          return (
          <motion.div
            key={entry.nodeId}
            className="frozen-row"
            data-frozen-row={entry.nodeId}
            custom={exitMode}
            variants={rowVariants}
            initial={false}
            animate="animate"
            exit="exit"
          >
          {/* 节点标识：问题摘要（可点击跳转） */}
          {/* <span
            className="frozen-row-label"
            onClick={() => {
              focusNode(entry.nodeId);
              window.history.pushState(null, '', '/node/' + entry.nodeId);
            }}
            title={entry.question}
          >
            {entry.question.length > 30 ? entry.question.slice(0, 30) + '…' : entry.question}
          </span> */}

          {/* 模型切换 tabs */}
          <span className="frozen-row-tabs">
            {sortedModelIds.map(mid => {
              const selectedModelId = activeModelId[entry.nodeId];
              const isActive = mid === selectedModelId || (!selectedModelId && mid === sortedModelIds[0]);
              const isDeleted = isDeletedModel(mid);
              return (
                <button
                  key={mid}
                  data-frozen-chip={mid}
                  className={`model-chip ${isActive ? 'active' : ''} ${isDeleted ? 'deleted-model' : ''}`}
                  onClick={() => handleModelClick(entry.nodeId, mid)}
                  title={isDeleted ? t('deletedModelTitle') : undefined}
                >
                  {getModelName(mid)}
                </button>
              );
            })}
          </span>
        </motion.div>
        );
      })}
        </AnimatePresence>
    </div>
  </div>
  );
}
