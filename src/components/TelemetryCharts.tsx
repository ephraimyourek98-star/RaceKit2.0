interface ElevationProfileChartProps {
  profile: number[];
  courseName: string;
}

export function ElevationProfileChart({ profile, courseName }: ElevationProfileChartProps) {
  const width = 560;
  const height = 94;
  const padX = 12;
  const padY = 12;

  if (!profile || profile.length < 2) return null;

  const minE = Math.min(...profile);
  const maxE = Math.max(...profile);
  const span = Math.max(maxE - minE, 10);

  const pts = profile.map((e, i) => {
    const x = padX + (i / (profile.length - 1)) * (width - padX * 2);
    const y = padY + (height - padY * 2) - ((e - minE) / span) * (height - padY * 2);
    return { x, y };
  });

  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${height - padY} L ${pts[0].x.toFixed(1)} ${height - padY} Z`;

  return (
    <div className="rounded-lg border border-slate-800/80 bg-[#0D131B] px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
        <span>Elevation Profile · {courseName}</span>
        <span className="font-mono tabular-nums text-slate-400">
          {Math.round(minE)} ft min · {Math.round(maxE)} ft peak
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[74px] w-full"
        role="img"
        aria-label={`Elevation profile for ${courseName}`}
      >
        <defs>
          <linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#elevGrad)" />
        <path d={line} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
