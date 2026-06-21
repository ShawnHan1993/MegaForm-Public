import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

type Placement = 'top' | 'bottom' | 'left' | 'right';

interface TooltipState {
  target: HTMLElement;
  text: string;
  quote: string | null;
  placement: Placement;
}

interface TooltipPosition {
  left: number;
  top: number;
  arrowLeft: number | null;
  arrowTop: number | null;
}

const TOOLTIP_GAP = 10;
const VIEWPORT_PADDING = 12;
const SHOW_DELAY_MS = 140;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function findTooltipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const target = node.closest<HTMLElement>('[title], [data-visual-tooltip]');
  if (!target) return null;

  const title = target.getAttribute('title');
  if (title?.trim()) {
    target.dataset.visualTooltip = title;
    target.removeAttribute('title');
    if (!target.getAttribute('aria-label')) target.setAttribute('aria-label', title);
    return target;
  }

  return target.dataset.visualTooltip?.trim() ? target : null;
}

function getPreferredPlacement(rect: DOMRect): Placement {
  if (rect.top > 86) return 'top';
  if (window.innerHeight - rect.bottom > 86) return 'bottom';
  if (rect.left > window.innerWidth - rect.right) return 'left';
  return 'right';
}

function calculatePosition(target: HTMLElement, tooltip: HTMLElement, placement: Placement): TooltipPosition {
  const rect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - tooltipRect.width - VIEWPORT_PADDING);
  const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - tooltipRect.height - VIEWPORT_PADDING);
  const anchorX = rect.left + rect.width / 2;
  const anchorY = rect.top + rect.height / 2;

  if (placement === 'top' || placement === 'bottom') {
    const left = clamp(anchorX - tooltipRect.width / 2, VIEWPORT_PADDING, maxLeft);
    const top = placement === 'top'
      ? clamp(rect.top - tooltipRect.height - TOOLTIP_GAP, VIEWPORT_PADDING, maxTop)
      : clamp(rect.bottom + TOOLTIP_GAP, VIEWPORT_PADDING, maxTop);

    return {
      left,
      top,
      arrowLeft: clamp(anchorX - left, 14, tooltipRect.width - 14),
      arrowTop: null,
    };
  }

  const left = placement === 'left'
    ? clamp(rect.left - tooltipRect.width - TOOLTIP_GAP, VIEWPORT_PADDING, maxLeft)
    : clamp(rect.right + TOOLTIP_GAP, VIEWPORT_PADDING, maxLeft);
  const top = clamp(anchorY - tooltipRect.height / 2, VIEWPORT_PADDING, maxTop);

  return {
    left,
    top,
    arrowLeft: null,
    arrowTop: clamp(anchorY - top, 14, tooltipRect.height - 14),
  };
}

export default function VisualTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);
  const lastTouchTimeRef = useRef(0);

  const hideTooltip = () => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    activeTargetRef.current = null;
    setTooltip(null);
    setPosition(null);
  };

  const showForTarget = (target: HTMLElement) => {
    const text = target.dataset.visualTooltip?.trim();
    if (!text) return;

    if (activeTargetRef.current === target) return;
    if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
    activeTargetRef.current = target;
    showTimerRef.current = window.setTimeout(() => {
      if (!target.isConnected || activeTargetRef.current !== target) return;
      setPosition(null);
      setTooltip({
        target,
        text,
        quote: target.dataset.visualTooltipQuote?.trim() || null,
        placement: getPreferredPlacement(target.getBoundingClientRect()),
      });
    }, SHOW_DELAY_MS);
  };

  useEffect(() => {
    const handlePointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        lastTouchTimeRef.current = Date.now();
        return;
      }
      const target = findTooltipTarget(event.target);
      if (target) showForTarget(target);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') lastTouchTimeRef.current = Date.now();
    };

    const handlePointerOut = (event: PointerEvent) => {
      const target = activeTargetRef.current;
      if (!target) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (Date.now() - lastTouchTimeRef.current < 700) return;
      const target = findTooltipTarget(event.target);
      if (target) showForTarget(target);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const target = activeTargetRef.current;
      if (!target) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      hideTooltip();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hideTooltip();
    };

    document.addEventListener('pointerover', handlePointerOver);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointerout', handlePointerOut);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerover', handlePointerOver);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointerout', handlePointerOut);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('keydown', handleKeyDown);
      if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return;
    setPosition(calculatePosition(tooltip.target, tooltipRef.current, tooltip.placement));
  }, [tooltip]);

  useEffect(() => {
    if (!tooltip) return;

    let frame = 0;
    const updatePosition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!tooltip.target.isConnected || !tooltipRef.current) {
          hideTooltip();
          return;
        }
        setPosition(calculatePosition(tooltip.target, tooltipRef.current, tooltip.placement));
      });
    };

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [tooltip]);

  if (!tooltip) return null;

  return createPortal(
    <div
      ref={tooltipRef}
      className="visual-tooltip-card"
      data-placement={tooltip.placement}
      data-positioned={position ? 'true' : 'false'}
      role="tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        '--tooltip-arrow-left': position?.arrowLeft !== null && position?.arrowLeft !== undefined ? `${position.arrowLeft}px` : undefined,
        '--tooltip-arrow-top': position?.arrowTop !== null && position?.arrowTop !== undefined ? `${position.arrowTop}px` : undefined,
      } as CSSProperties}
    >
      {tooltip.quote ? (
        <>
          <span className="visual-tooltip-quote">{tooltip.quote}</span>
          <span className="visual-tooltip-body">{tooltip.text}</span>
        </>
      ) : (
        tooltip.text
      )}
    </div>,
    document.body,
  );
}
