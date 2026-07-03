export type BoardScrollbarMetrics = {
  clientWidth: number;
  minThumbWidth?: number;
  scrollLeft: number;
  scrollWidth: number;
  trackWidth: number;
};

export type BoardScrollbarState = {
  isScrollable: boolean;
  maxScrollLeft: number;
  maxThumbLeft: number;
  scrollLeft: number;
  thumbLeft: number;
  thumbWidth: number;
};

const defaultMinThumbWidth = 44;

export function boardScrollbarState(metrics: BoardScrollbarMetrics): BoardScrollbarState {
  const clientWidth = positive(metrics.clientWidth);
  const scrollWidth = positive(metrics.scrollWidth);
  const trackWidth = positive(metrics.trackWidth);
  const minThumbWidth = positive(metrics.minThumbWidth ?? defaultMinThumbWidth);
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);

  if (maxScrollLeft === 0 || clientWidth === 0 || scrollWidth === 0 || trackWidth === 0) {
    return {
      isScrollable: false,
      maxScrollLeft,
      maxThumbLeft: 0,
      scrollLeft: 0,
      thumbLeft: 0,
      thumbWidth: trackWidth
    };
  }

  const thumbWidth = Math.min(
    trackWidth,
    Math.max(Math.min(minThumbWidth, trackWidth), (clientWidth / scrollWidth) * trackWidth)
  );
  const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
  const scrollLeft = clamp(metrics.scrollLeft, 0, maxScrollLeft);
  const thumbLeft = maxThumbLeft === 0 ? 0 : (scrollLeft / maxScrollLeft) * maxThumbLeft;

  return {
    isScrollable: true,
    maxScrollLeft,
    maxThumbLeft,
    scrollLeft,
    thumbLeft,
    thumbWidth
  };
}

export function scrollLeftForScrollbarPointer(
  metrics: BoardScrollbarMetrics & {
    pointerX: number;
    thumbOffsetX: number;
    trackLeft: number;
  }
) {
  const state = boardScrollbarState(metrics);

  if (!state.isScrollable || state.maxThumbLeft === 0) {
    return 0;
  }

  const thumbLeft = clamp(metrics.pointerX - metrics.trackLeft - metrics.thumbOffsetX, 0, state.maxThumbLeft);

  return (thumbLeft / state.maxThumbLeft) * state.maxScrollLeft;
}

function positive(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
