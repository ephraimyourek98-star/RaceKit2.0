interface ElevationProfileChartProps {
  profile?: number[];
  courseName: string;
  surface?: string;
  elevationGainFt?: number;
}

export function ElevationProfileChart({
  profile,
  courseName,
  surface,
  elevationGainFt,
}: ElevationProfileChartProps) {
  const width = 560;
  const height = 110;
  const padLeft = 40;
  const padRight = 30;
  const padTop = 22;
  const padBottom = 26;

  const isTrack =
    surface === 'track' ||
    courseName.toLowerCase().includes('track') ||
    elevationGainFt === 0 ||
    (profile && profile.length > 0 && profile.every((v) => v === 0));

  const validProfile = isTrack
    ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    : profile && profile.length >= 2
      ? profile
      : [65, 68, 74, 82, 85, 78, 71, 66, 68, 65];

  const minE = Math.min(...validProfile);
  const maxE = Math.max(...validProfile);
  const isFlat = maxE === minE;
  const span = Math.max(maxE - minE, 8);
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const pts = validProfile.map((e, i) => {
    const x = padLeft + (i / (validProfile.length - 1)) * plotW;
    const y = isFlat
      ? padTop + plotH * 0.75
      : padTop + plotH - ((e - minE) / span) * plotH;
    return { x, y, elev: e };
  });

  // Find peak point for callout
  let peakIdx = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].elev > pts[peakIdx].elev) peakIdx = i;
  }
  const peakPt = pts[peakIdx];

  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${padTop + plotH} L ${pts[0].x.toFixed(1)} ${padTop + plotH} Z`;

  return (
    <div className="rounded-2xl border border-white/10 bg-[#1C1C1E] p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-slate-200">Elevation Profile</span>
          <span className="text-slate-400">· {courseName}</span>
          {isTrack && (
            <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400 uppercase">
              Flat Track (0 ft)
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-[#0A84FF] font-semibold">
          {Math.round(minE)} ft min → {Math.round(maxE)} ft peak (+{Math.round(maxE - minE)} ft climb)
        </span>
      </div>

      <div className="relative overflow-hidden rounded-xl bg-[#2C2C2E]/60 p-2 border border-white/5">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[88px] w-full select-none"
          role="img"
          aria-label={`Elevation profile for ${courseName}`}
        >
          <defs>
            <linearGradient id="appleElevGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0A84FF" stopOpacity="0.4" />
              <stop offset="60%" stopColor="#0A84FF" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#0A84FF" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Horizontal grid lines */}
          <line
            x1={padLeft}
            y1={padTop}
            x2={width - padRight}
            y2={padTop}
            stroke="rgba(255,255,255,0.08)"
            strokeDasharray="3 3"
          />
          <line
            x1={padLeft}
            y1={padTop + plotH}
            x2={width - padRight}
            y2={padTop + plotH}
            stroke="rgba(255,255,255,0.08)"
          />

          {/* Y-axis elevation labels */}
          <text
            x={padLeft - 6}
            y={padTop + 4}
            textAnchor="end"
            fill="#8E8E93"
            fontSize="9"
            fontFamily="monospace"
          >
            {Math.round(maxE)}′
          </text>
          <text
            x={padLeft - 6}
            y={padTop + plotH + 3}
            textAnchor="end"
            fill="#8E8E93"
            fontSize="9"
            fontFamily="monospace"
          >
            {Math.round(minE)}′
          </text>

          {/* Elevation Area & Line */}
          <path d={area} fill="url(#appleElevGrad)" />
          <path d={line} fill="none" stroke="#0A84FF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* Peak Callout Dot & Label (Only when course is not completely flat) */}
          {peakPt && !isFlat && (
            <g>
              <circle cx={peakPt.x} cy={peakPt.y} r={4.5} fill="#0A84FF" stroke="#FFFFFF" strokeWidth="1.5" />
              <text
                x={peakPt.x}
                y={peakPt.y - 8}
                textAnchor="middle"
                fill="#30D158"
                fontSize="9"
                fontWeight="bold"
                fontFamily="monospace"
              >
                Peak {Math.round(peakPt.elev)} ft
              </text>
            </g>
          )}

          {/* Start and Finish markers */}
          <circle cx={pts[0].x} cy={pts[0].y} r={3} fill="#FFFFFF" />
          <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={3} fill="#FFFFFF" />

          {/* X-axis distance checkpoint labels */}
          <text
            x={pts[0].x}
            y={height - 6}
            textAnchor="start"
            fill="#8E8E93"
            fontSize="9"
            fontFamily="monospace"
          >
            Start (0 mi)
          </text>
          <text
            x={width / 2}
            y={height - 6}
            textAnchor="middle"
            fill="#8E8E93"
            fontSize="9"
            fontFamily="monospace"
          >
            Mid-Course
          </text>
          <text
            x={pts[pts.length - 1].x}
            y={height - 6}
            textAnchor="end"
            fill="#8E8E93"
            fontSize="9"
            fontFamily="monospace"
          >
            Finish (3.1 mi)
          </text>
        </svg>
      </div>
    </div>
  );
}
