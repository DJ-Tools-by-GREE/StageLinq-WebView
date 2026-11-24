import { useEffect, useState, type RefObject } from 'react';

export function useCanvasSize(ref: RefObject<HTMLCanvasElement>) {
  const [size, setSize] = useState({ width: 0, height: 0, ratio: 1 });
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const update = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      setSize((prev) => prev.width === width && prev.height === height && prev.ratio === ratio
        ? prev : { width, height, ratio });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [ref]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = Math.round(size.width * size.ratio);
    canvas.height = Math.round(size.height * size.ratio);
    canvas.getContext('2d')?.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
  }, [ref, size]);
  return size;
}
