"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";

type Point = { time: UTCTimestamp; value: number };

export default function GenreFinanceChart({ title, data }: { title: string; data: Point[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  const change = useMemo(() => {
    if (data.length < 2) return { abs: 0, pct: 0, last: 0 };
    const first = data[0]!.value;
    const last = data[data.length - 1]!.value;
    const abs = last - first;
    const pct = first === 0 ? 0 : (abs / first) * 100;
    return { abs, pct, last };
  }, [data]);

  useEffect(() => {
    if (!ref.current) return;

    const chart = createChart(ref.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#a1a1aa" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      height: 260,
    });

    const series = chart.addSeries(AreaSeries, {
      lineWidth: 2,
      topColor: "rgba(59,130,246,0.20)",
      bottomColor: "rgba(59,130,246,0.00)",
      lineColor: "rgba(59,130,246,0.90)",
    });

    series.setData(data);

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (!ref.current) return;
      chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [data]);

  const pctCls = change.pct >= 0 ? "text-green-400" : "text-red-400";

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-400">Genre</p>
          <p className="text-lg font-semibold">{title}</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-zinc-400">Now</p>
          <p className="text-xl font-bold">{Math.round(change.last).toLocaleString()}</p>
          <p className={`text-sm ${pctCls}`}>
            {change.pct >= 0 ? "+" : ""}
            {change.pct.toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="mt-3" ref={ref} />
    </div>
  );
}
