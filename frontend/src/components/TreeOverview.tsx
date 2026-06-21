import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { LocateFixed, Minus, Plus } from 'lucide-react';
import type { Node } from '../types';
import { useT } from '../i18n';
import ReferencePreview from './ReferencePreview';
import { getNutReferenceText } from '../utils/referenceText';

type Side = -1 | 0 | 1;

interface Props {
  rootTree: Node[];
  focusedNodeId: string | null;
  streamingNodeIds: Set<string>;
  onSelectNode: (node: Node) => void;
}

interface PositionedNode {
  id: string;
  node: Node;
  cx: number;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  side: Side;
  relation: 'progression' | 'followup';
  label: string;
  quote: string | null;
  responseCount: number;
  childCount: number;
  isFocused: boolean;
  isInFocusPath: boolean;
}

interface PositionedEdge {
  id: string;
  fromId: string;
  toId: string;
  d: string;
  relation: 'progression' | 'followup';
  depth: number;
  side: Side;
  branchIndex: number;
  isInFocusPath: boolean;
  anchorX: number;
  anchorY: number;
  targetX: number;
  targetY: number;
}

interface RailExtension {
  id: string;
  d: string;
}

interface OverviewLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  railExtensions: RailExtension[];
  canvasWidth: number;
  canvasHeight: number;
}

interface ActivePointer {
  x: number;
  y: number;
  canDrag: boolean;
}

interface PinchStart {
  distance: number;
  midpointX: number;
  midpointY: number;
  zoom: number;
  panX: number;
  panY: number;
}

const VIEWPORT_FALLBACK_WIDTH = 960;
const CANVAS_MARGIN = 120;
const TRUNK_WIDTH = 430;
const BRANCH_WIDTH = 320;
const BRANCH_WIDTH_MIN = 230;
const MAIN_HEIGHT = 62;
const BRANCH_HEIGHT = 62;
const ROW_TOP = 52;
const ROW_GAP = 88;
const SIDE_OFFSET_BASE = 300;
const SIDE_OFFSET_STEP = 42;
const SIDE_OFFSET_MIN = 150;
const SIDE_OFFSET_HEIGHT_DECAY = 130;
const REVERSE_BRANCH_OFFSET_FACTOR = 0.68;
const RAIL_DOT_OFFSET = 11;
const FOLLOWUP_BRANCH_OFFSET = 42;
const FOLLOWUP_BRANCH_STEP = 38;
const FOLLOWUP_SHELF_SLOPE = 0.035;
const RAIL_EXTENSION_AFTER_LAST_DOT = 34;
const BRANCH_RAIL_AFTER_LAST_FOLLOWUP_DOT = 28;
const FOCUS_ENTRY_TOP = 58;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 1.45;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function truncate(text: string, maxLen: number) {
  const chars = Array.from(text.trim().replace(/\s+/g, ' '));
  return chars.length > maxLen ? `${chars.slice(0, maxLen).join('')}...` : chars.join('');
}

function getNodeLabel(node: Node, relation: 'progression' | 'followup') {
  return truncate(node.summary || node.content || '', relation === 'followup' ? 42 : 58);
}

function flatten(nodes: Node[]): Node[] {
  const result: Node[] = [];
  const walk = (list: Node[]) => {
    for (const node of list) {
      result.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

function getFollowupSortKey(child: Node, parent: Node) {
  const responses = parent.responses || [];
  const parentModelIndex = child.parent_model_id
    ? responses.findIndex(response => response.model_id === child.parent_model_id)
    : -1;

  for (let responseIndex = 0; responseIndex < responses.length; responseIndex++) {
    const response = responses[responseIndex];
    const nut = response.nuts?.find(item => item.id === child.nut_id);
    if (nut) {
      return {
        responseIndex,
        seek: nut.seek,
        endSeek: nut.end_seek,
      };
    }
  }

  return {
    responseIndex: parentModelIndex >= 0 ? parentModelIndex : Number.MAX_SAFE_INTEGER,
    seek: Number.MAX_SAFE_INTEGER,
    endSeek: Number.MAX_SAFE_INTEGER,
  };
}

function getFollowupQuote(child: Node, nodeById: Map<string, Node>) {
  if (child.relation !== 'followup' || !child.nut_id || !child.parent_id) return child.followup_quote || null;
  const parent = nodeById.get(child.parent_id);
  if (!parent?.responses) return child.followup_quote || null;

  const preferred = child.parent_model_id
    ? parent.responses.find(response => response.model_id === child.parent_model_id)
    : null;
  const orderedResponses = preferred
    ? [preferred, ...parent.responses.filter(response => response !== preferred)]
    : parent.responses;

  for (const response of orderedResponses) {
    const nut = response.nuts?.find(item => item.id === child.nut_id);
    if (nut) return getNutReferenceText(response.content, nut, nut.label || child.followup_quote || '');
  }
  return child.followup_quote || null;
}

function buildFocusPathIds(allNodes: Node[], focusedNodeId: string | null) {
  if (!focusedNodeId) return new Set<string>();
  const byId = new Map(allNodes.map(node => [node.id, node]));
  const ids = new Set<string>();
  let current = byId.get(focusedNodeId) || null;
  while (current) {
    ids.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) || null : null;
  }
  return ids;
}

function buildTreeOverviewLayout(rootTree: Node[], viewportWidth: number, focusedNodeId: string | null): OverviewLayout {
  const allNodes = flatten(rootTree);
  const nodeById = new Map(allNodes.map(node => [node.id, node]));
  const focusPathIds = buildFocusPathIds(allNodes, focusedNodeId);
  const positioned: Array<Omit<PositionedNode, 'x'>> = [];
  const edges: Array<Omit<PositionedEdge, 'd'>> = [];
  let nextRow = 0;

  const addNode = (
    node: Node,
    cx: number,
    depth: number,
    side: Side,
    relation: 'progression' | 'followup',
  ) => {
    const isBranch = relation === 'followup' || side !== 0;
    const width = isBranch
      ? Math.max(BRANCH_WIDTH_MIN, BRANCH_WIDTH - depth * 14)
      : TRUNK_WIDTH;
    const height = isBranch ? BRANCH_HEIGHT : MAIN_HEIGHT;
    const y = ROW_TOP + nextRow * ROW_GAP + (MAIN_HEIGHT - height) / 2;
    nextRow += 1;

    const item = {
      id: node.id,
      node,
      cx,
      y,
      width,
      height,
      depth,
      side,
      relation,
      label: getNodeLabel(node, relation),
      quote: getFollowupQuote(node, nodeById),
      responseCount: node.responses?.length || 0,
      childCount: node.children?.length || 0,
      isFocused: node.id === focusedNodeId,
      isInFocusPath: focusPathIds.has(node.id),
    };
    positioned.push(item);
    return item;
  };

  const layoutSubtree = (
    node: Node,
    cx: number,
    depth: number,
    side: Side,
    relation: 'progression' | 'followup',
    parentId?: string,
    branchIndex = 0,
  ): number => {
    const current = addNode(node, cx, depth, side, relation);
    if (parentId) {
      edges.push({
        id: `${parentId}:${node.id}`,
        fromId: parentId,
        toId: node.id,
        relation,
        depth,
        side,
        branchIndex,
        isInFocusPath: focusPathIds.has(parentId) && focusPathIds.has(node.id),
        anchorX: 0,
        anchorY: 0,
        targetX: 0,
        targetY: 0,
      });
    }

    const children = [...(node.children || [])].sort((a, b) => a.child_order - b.child_order);
    const followups = children
      .filter(child => child.relation === 'followup')
      .sort((a, b) => {
        const ak = getFollowupSortKey(a, node);
        const bk = getFollowupSortKey(b, node);
        return (
          ak.responseIndex - bk.responseIndex ||
          ak.seek - bk.seek ||
          ak.endSeek - bk.endSeek ||
          a.child_order - b.child_order
        );
      });
    const progressions = children.filter(child => child.relation !== 'followup');

    followups.forEach((child, index) => {
      const outwardFirst = side === 0 ? -1 : side;
      const branchSide = (index % 2 === 0 ? outwardFirst : -outwardFirst) as Side;
      const childRow = nextRow;
      const heightProgress = allNodes.length > 1 ? childRow / (allNodes.length - 1) : 0;
      const depthOffset = Math.max(SIDE_OFFSET_MIN, SIDE_OFFSET_BASE - depth * SIDE_OFFSET_STEP);
      const baseOffset = Math.max(SIDE_OFFSET_MIN, depthOffset - heightProgress * SIDE_OFFSET_HEIGHT_DECAY);
      const isReverseBranch = side !== 0 && branchSide !== side;
      const offset = isReverseBranch ? Math.max(SIDE_OFFSET_MIN, baseOffset * REVERSE_BRANCH_OFFSET_FACTOR) : baseOffset;
      const childCx = cx + branchSide * offset;
      layoutSubtree(child, childCx, depth + 1, branchSide, 'followup', node.id, index);
    });

    let bottom = current.y + current.height;
    progressions.forEach(child => {
      const childBottom = layoutSubtree(child, cx, depth, side, 'progression', node.id, 0);
      bottom = Math.max(bottom, childBottom);
    });

    return bottom;
  };

  const root = rootTree[0];
  if (root) layoutSubtree(root, 0, 0, 0, 'progression');

  let minX = -TRUNK_WIDTH / 2;
  let maxX = TRUNK_WIDTH / 2;
  let maxY = 200;
  positioned.forEach(node => {
    const left = node.side === -1 ? node.cx - node.width + RAIL_DOT_OFFSET : node.cx - RAIL_DOT_OFFSET;
    const right = node.side === -1 ? node.cx + RAIL_DOT_OFFSET : node.cx + node.width - RAIL_DOT_OFFSET;
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
    maxY = Math.max(maxY, node.y + node.height);
  });

  const halfSpan = Math.max(Math.abs(minX), Math.abs(maxX)) + CANVAS_MARGIN;
  const canvasWidth = Math.max(viewportWidth, halfSpan * 2);
  const shiftX = canvasWidth / 2;
  const normalized = positioned.map(node => ({
    ...node,
    cx: node.cx + shiftX,
    x: node.side === -1
      ? node.cx + shiftX - node.width + RAIL_DOT_OFFSET
      : node.cx + shiftX - RAIL_DOT_OFFSET,
  }));
  const byId = new Map(normalized.map(node => [node.id, node]));

  const normalizedEdges: PositionedEdge[] = edges.flatMap(edge => {
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) return [];

    if (edge.relation === 'progression') {
      const startX = from.cx;
      const startY = from.y + from.height * 0.5;
      const endX = to.cx;
      const endY = to.y + to.height * 0.5;
      return [{
        ...edge,
        anchorX: startX,
        anchorY: startY,
        targetX: endX,
        targetY: endY,
        d: `M ${startX} ${startY} L ${endX} ${endY}`,
      }];
    }

    const sideSign = to.cx >= from.cx ? 1 : -1;
    const startX = from.cx;
    const parentCenterY = from.y + from.height * 0.5;
    const startY = parentCenterY + FOLLOWUP_BRANCH_OFFSET + edge.branchIndex * FOLLOWUP_BRANCH_STEP;
    const endX = to.cx;
    const endY = to.y + to.height * 0.5;
    const horizontal = Math.abs(endX - startX);
    const cornerRadius = Math.max(22, Math.min(34, horizontal * 0.12));
    const shelfY = startY + horizontal * FOLLOWUP_SHELF_SLOPE;
    const preCornerX = endX - sideSign * cornerRadius;
    const verticalStartY = shelfY + cornerRadius;
    return [{
      ...edge,
      anchorX: startX,
      anchorY: parentCenterY,
      targetX: endX,
      targetY: endY,
      d: `M ${startX} ${startY} C ${startX + sideSign * horizontal * 0.34} ${startY + 2}, ${preCornerX} ${shelfY}, ${preCornerX} ${shelfY} C ${endX} ${shelfY}, ${endX} ${verticalStartY}, ${endX} ${verticalStartY} L ${endX} ${endY}`,
    }];
  });

  let railExtensionBottom = maxY;
  const branchRailExtensions = new Map<string, { x: number; fromY: number; toY: number }>();
  for (const edge of edges) {
    if (edge.relation !== 'followup') continue;
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) continue;
    const fromY = from.y + from.height * 0.5;
    const toY = to.y + to.height * 0.5 + BRANCH_RAIL_AFTER_LAST_FOLLOWUP_DOT;
    const existing = branchRailExtensions.get(edge.fromId);
    if (existing) {
      existing.toY = Math.max(existing.toY, toY);
    } else {
      branchRailExtensions.set(edge.fromId, { x: from.cx, fromY, toY });
    }
  }

  const parentBranchRails: RailExtension[] = Array.from(branchRailExtensions.entries()).map(([id, ext]) => {
    railExtensionBottom = Math.max(railExtensionBottom, ext.toY);
    return {
      id: `branch-rail:${id}`,
      d: `M ${ext.x} ${ext.fromY} L ${ext.x} ${ext.toY}`,
    };
  });

  const leafTailRails: RailExtension[] = normalized
    .filter(node => !node.node.children?.length)
    .map(node => {
      const fromY = node.y + node.height * 0.5;
      const toY = fromY + RAIL_EXTENSION_AFTER_LAST_DOT;
      railExtensionBottom = Math.max(railExtensionBottom, toY);
      return {
        id: `leaf-rail:${node.id}`,
        d: `M ${node.cx} ${fromY} L ${node.cx} ${toY}`,
      };
    });
  const railExtensions = [...parentBranchRails, ...leafTailRails];

  return {
    nodes: normalized,
    edges: normalizedEdges,
    railExtensions,
    canvasWidth,
    canvasHeight: Math.max(520, railExtensionBottom + CANVAS_MARGIN),
  };
}

export default function TreeOverview({ rootTree, focusedNodeId, streamingNodeIds, onSelectNode }: Props) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const activePointersRef = useRef<Map<number, ActivePointer>>(new Map());
  const pinchStartRef = useRef<PinchStart | null>(null);
  const didInitialCenterRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(VIEWPORT_FALLBACK_WIDTH);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [viewportReady, setViewportReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      setViewportWidth(viewport.clientWidth || VIEWPORT_FALLBACK_WIDTH);
      setViewportHeight(viewport.clientHeight || 640);
      setViewportReady(true);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => buildTreeOverviewLayout(rootTree, viewportWidth, focusedNodeId),
    [focusedNodeId, rootTree, viewportWidth],
  );
  const rootId = rootTree[0]?.id;

  const recenter = useCallback(() => {
    const target = layout.nodes.find(node => node.id === focusedNodeId) || layout.nodes[0];
    if (!target) return;
    setPan({
      x: viewportWidth / 2 - target.cx * zoom,
      y: FOCUS_ENTRY_TOP - target.y * zoom,
    });
  }, [focusedNodeId, layout.nodes, viewportWidth, zoom]);

  useEffect(() => {
    didInitialCenterRef.current = false;
  }, [rootId]);

  useEffect(() => {
    if (didInitialCenterRef.current || !viewportReady) return;
    const target = layout.nodes.find(node => node.id === focusedNodeId) || layout.nodes[0];
    if (!target || viewportWidth <= 0 || viewportHeight <= 0) return;
    didInitialCenterRef.current = true;
    const raf = requestAnimationFrame(() => {
      setZoom(1);
      setPan({
        x: viewportWidth / 2 - target.cx,
        y: FOCUS_ENTRY_TOP - target.y,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusedNodeId, layout.nodes, viewportHeight, viewportReady, viewportWidth]);

  const scaleAtViewportPoint = useCallback((viewportX: number, viewportY: number, factor: number) => {
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - zoom) < 0.001) return;

    const contentX = (viewportX - pan.x) / zoom;
    const contentY = (viewportY - pan.y) / zoom;
    setZoom(nextZoom);
    setPan({
      x: viewportX - contentX * nextZoom,
      y: viewportY - contentY * nextZoom,
    });
  }, [pan.x, pan.y, zoom]);

  const scaleAtViewportCenter = useCallback((factor: number) => {
    scaleAtViewportPoint(viewportWidth / 2, viewportHeight / 2, factor);
  }, [scaleAtViewportPoint, viewportHeight, viewportWidth]);

  const getViewportPoint = useCallback((event: React.PointerEvent<HTMLDivElement>, pointer: ActivePointer) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: pointer.x - rect.left,
      y: pointer.y - rect.top,
    };
  }, []);

  const getPinchMetrics = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pointers = Array.from(activePointersRef.current.values());
    if (pointers.length < 2) return null;
    const first = getViewportPoint(event, pointers[0]);
    const second = getViewportPoint(event, pointers[1]);
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      midpointX: (first.x + second.x) / 2,
      midpointY: (first.y + second.y) / 2,
    };
  }, [getViewportPoint]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.tree-overview-control')) return;
    const isTouch = event.pointerType === 'touch';
    const startedOnNode = Boolean(target.closest('.tree-overview-node'));
    if (startedOnNode && !isTouch) return;
    const canDrag = !startedOnNode || isTouch;
    activePointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      canDrag,
    });
    if (activePointersRef.current.size >= 2) {
      const metrics = getPinchMetrics(event);
      if (metrics && metrics.distance > 0) {
        pinchStartRef.current = {
          ...metrics,
          zoom,
          panX: pan.x,
          panY: pan.y,
        };
        dragStartRef.current = null;
      }
    } else if (canDrag && !startedOnNode) {
      dragStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        panX: pan.x,
        panY: pan.y,
      };
    }
    setDragging(canDrag || activePointersRef.current.size >= 2);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointer = activePointersRef.current.get(event.pointerId);
    if (pointer) {
      activePointersRef.current.set(event.pointerId, {
        ...pointer,
        x: event.clientX,
        y: event.clientY,
      });
    }
    const pinchStart = pinchStartRef.current;
    if (pinchStart && activePointersRef.current.size >= 2) {
      const metrics = getPinchMetrics(event);
      if (!metrics || metrics.distance <= 0) return;
      const nextZoom = clamp(pinchStart.zoom * (metrics.distance / pinchStart.distance), MIN_ZOOM, MAX_ZOOM);
      const contentX = (pinchStart.midpointX - pinchStart.panX) / pinchStart.zoom;
      const contentY = (pinchStart.midpointY - pinchStart.panY) / pinchStart.zoom;
      setZoom(nextZoom);
      setPan({
        x: metrics.midpointX - contentX * nextZoom,
        y: metrics.midpointY - contentY * nextZoom,
      });
      return;
    }
    const start = dragStartRef.current;
    if (!start) return;
    setPan({
      x: start.panX + event.clientX - start.x,
      y: start.panY + event.clientY - start.y,
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartRef.current = null;
    }
    if (activePointersRef.current.size === 1) {
      const remaining = Array.from(activePointersRef.current.values())[0];
      if (remaining.canDrag) {
        dragStartRef.current = {
          x: remaining.x,
          y: remaining.y,
          panX: pan.x,
          panY: pan.y,
        };
      }
    } else {
      dragStartRef.current = null;
      setDragging(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) < 0.5) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportX = event.clientX - rect.left;
    const viewportY = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    scaleAtViewportPoint(viewportX, viewportY, factor);
  };

  return (
    <div
      ref={viewportRef}
      className={`tree-overview${dragging ? ' is-dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={handleWheel}
    >
      <div className="tree-overview-controls">
        <button className="tree-overview-control" onClick={() => scaleAtViewportCenter(1.12)} title={t('overviewZoomIn')}>
          <Plus size={15} />
        </button>
        <button className="tree-overview-control" onClick={() => scaleAtViewportCenter(1 / 1.12)} title={t('overviewZoomOut')}>
          <Minus size={15} />
        </button>
        <button className="tree-overview-control" onClick={recenter} title={t('overviewRecenter')}>
          <LocateFixed size={15} />
        </button>
      </div>

      <motion.div
        className="tree-overview-canvas"
        style={{
          width: layout.canvasWidth,
          height: layout.canvasHeight,
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
        }}
      >
        <svg
          className="tree-overview-edges"
          width={layout.canvasWidth}
          height={layout.canvasHeight}
          viewBox={`0 0 ${layout.canvasWidth} ${layout.canvasHeight}`}
        >
          <AnimatePresence>
            {layout.railExtensions.map(extension => (
              <motion.path
                key={extension.id}
                className="tree-overview-rail-extension"
                d={extension.d}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ d: extension.d, pathLength: 1, opacity: 1 }}
                exit={{ pathLength: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 180, damping: 26, mass: 0.8 }}
              />
            ))}
            {layout.edges.map(edge => (
              <motion.path
                key={edge.id}
                className={`tree-overview-edge edge-${edge.relation}${edge.isInFocusPath ? ' is-focus-path' : ''}`}
                d={edge.d}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ d: edge.d, pathLength: 1, opacity: 1 }}
                exit={{ pathLength: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 180, damping: 26, mass: 0.8 }}
              />
            ))}
          </AnimatePresence>
        </svg>

        <AnimatePresence>
          {layout.nodes.map(item => {
            const edge = layout.edges.find(candidate => candidate.toId === item.id);
            const isStreaming = streamingNodeIds.has(item.id);
            return (
              <motion.button
                key={item.id}
                type="button"
                className={`tree-overview-node node-${item.relation} side-${item.side === -1 ? 'left' : 'right'}${item.isFocused ? ' is-focused' : ''}${item.isInFocusPath ? ' is-focus-path' : ''}${isStreaming ? ' is-streaming' : ''}`}
                title={item.quote ? `${item.quote}\n${item.node.content}` : item.node.content}
                initial={{
                  x: edge
                    ? (item.side === -1 ? edge.anchorX - item.width + RAIL_DOT_OFFSET : edge.anchorX - RAIL_DOT_OFFSET)
                    : item.x,
                  y: edge ? edge.anchorY - item.height / 2 : item.y - 24,
                  scale: item.relation === 'followup' ? 0.58 : 0.86,
                  opacity: 0,
                }}
                animate={{
                  x: item.x,
                  y: item.y,
                  scale: 1,
                  opacity: 1,
                }}
                exit={{
                  x: edge
                    ? (item.side === -1 ? edge.anchorX - item.width + RAIL_DOT_OFFSET : edge.anchorX - RAIL_DOT_OFFSET)
                    : item.x,
                  y: edge ? edge.anchorY - item.height / 2 : item.y,
                  scale: 0.48,
                  opacity: 0,
                }}
                transition={{ type: 'spring', stiffness: 185, damping: 24, mass: item.relation === 'followup' ? 0.75 : 0.95 }}
                style={{ width: item.width, height: item.height }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectNode(item.node);
                }}
              >
                <span className="tree-overview-dot" aria-hidden="true" />
                <span className="tree-overview-label">
                  {item.quote && (
                    <span className="tree-overview-reference">
                      <ReferencePreview text={item.quote} />
                    </span>
                  )}
                  <span className="tree-overview-node-main">{item.label}</span>
                  <span className="tree-overview-node-meta">
                    {item.responseCount > 0 && <span>{item.responseCount} {t('replies')}</span>}
                    {item.childCount > 0 && <span>{item.childCount} {t('overviewBranches')}</span>}
                    {isStreaming && <span>{t('overviewGrowing')}</span>}
                  </span>
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

interface MiniMapProps {
  rootTree: Node[];
  focusedNodeId: string | null;
  stackHighlightNodeId?: string | null;
  streamingNodeIds: Set<string>;
  onSelectNode: (node: Node) => void;
}

export function TreeOverviewMiniMap({ rootTree, focusedNodeId, stackHighlightNodeId, streamingNodeIds, onSelectNode }: MiniMapProps) {
  const layout = useMemo(
    () => buildTreeOverviewLayout(rootTree, 360, focusedNodeId),
    [focusedNodeId, rootTree],
  );
  const stackHighlightNode = stackHighlightNodeId
    ? layout.nodes.find(node => node.id === stackHighlightNodeId)
    : null;

  if (layout.nodes.length === 0) return null;

  return (
    <div className="tree-overview-minimap" aria-label="Tree overview minimap">
      <svg
        className="tree-overview-minimap-svg"
        viewBox={`0 0 ${layout.canvasWidth} ${layout.canvasHeight}`}
        preserveAspectRatio="xMidYMin meet"
      >
        {layout.railExtensions.map(extension => (
          <path
            key={extension.id}
            className="tree-overview-minimap-rail"
            d={extension.d}
          />
        ))}
        {layout.edges.map(edge => (
          <path
            key={edge.id}
            className={`tree-overview-minimap-edge${edge.isInFocusPath ? ' is-focus-path' : ''}`}
            d={edge.d}
          />
        ))}
        <AnimatePresence>
          {stackHighlightNode && (
            <motion.circle
              key={stackHighlightNode.id}
              className="tree-overview-minimap-stack-ring"
              cx={stackHighlightNode.cx}
              cy={stackHighlightNode.y + stackHighlightNode.height * 0.5}
              initial={{ r: 12, opacity: 0 }}
              animate={{ r: 29, opacity: 1 }}
              exit={{ r: 14, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 220, damping: 22, mass: 0.7 }}
            />
          )}
        </AnimatePresence>
        {layout.nodes.map(node => {
          const isStreaming = streamingNodeIds.has(node.id);
          const isStackHighlight = node.id === stackHighlightNodeId;
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              className="tree-overview-minimap-hit"
              data-visual-tooltip={node.label}
              data-visual-tooltip-quote={node.quote || undefined}
              onClick={() => onSelectNode(node.node)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelectNode(node.node);
              }}
            >
              <circle
                className={`tree-overview-minimap-dot${node.isFocused ? ' is-focused' : ''}${isStackHighlight ? ' is-stack-highlight' : ''}${isStreaming ? ' is-streaming' : ''}`}
                cx={node.cx}
                cy={node.y + node.height * 0.5}
                r={node.isFocused ? 23 : isStackHighlight ? 21 : 14}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
