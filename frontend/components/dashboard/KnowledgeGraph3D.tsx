'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import SpriteText from 'three-spritetext';
import type { GraphData, GraphNode } from './KnowledgeGraph';

// Resolved hex for the WebGL materials (three can't read our CSS vars at runtime).
const HEX = {
  accent: '#8468ff',
  cyan: '#38dceb',
  lead: '#38c8f8',
  prospect: '#a78bfa',
  customer: '#34d399',
  neutral: '#8a93b0',
};

function colorFor(n: { type?: string; stage?: string }): string {
  if (n.type === 'hub') return HEX.accent;
  if (n.type === 'interaction') return HEX.cyan;
  if (n.stage === 'LEAD') return HEX.lead;
  if (n.stage === 'PROSPECT') return HEX.prospect;
  if (n.stage === 'CUSTOMER') return HEX.customer;
  return HEX.neutral;
}

export interface Graph3DProps {
  data: GraphData;
  /** Auto-rotate, no drag/zoom, no labels — the glanceable dashboard view. */
  preview?: boolean;
  onNodeClick?: (n: GraphNode) => void;
  onNodeDoubleClick?: (n: GraphNode) => void;
}

/** KnowledgeGraph3D — the immersive WebGL relationship constellation. Nodes glow
 *  (UnrealBloom), colored by funnel stage; click inspects, double-click drills. */
export function KnowledgeGraph3D({ data, preview = false, onNodeClick, onNodeDoubleClick }: Graph3DProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const lastClick = useRef<{ id: string | null; t: number }>({ id: null, t: 0 });
  const [FG, setFG] = useState<any>(null);
  const [size, setSize] = useState({ w: 640, h: 380 });

  // Client-only load of the force-graph component (keeps three out of SSR), with
  // a real ref to the forwardRef component so camera/bloom/controls are reachable.
  useEffect(() => {
    let alive = true;
    import('react-force-graph-3d').then((m) => { if (alive) setFG(() => m.default); });
    return () => { alive = false; };
  }, []);

  const graphData = useMemo(
    () => ({
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.edges.map((e) => ({ source: e.from, target: e.to })),
    }),
    [data],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [FG]);

  // Bloom glow + camera + (preview) auto-rotate, once the instance exists.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const t = setTimeout(async () => {
      try {
        const THREE = await import('three');
        const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
        const bloom = new UnrealBloomPass(new THREE.Vector2(size.w || 640, size.h || 380), 0.95, 0.5, 0.22);
        fg.postProcessingComposer().addPass(bloom);
      } catch { /* bloom is a nice-to-have */ }
      try {
        // Spread the layout so the centre doesn't collapse into a blob.
        fg.d3Force('charge')?.strength(-240);
        fg.d3Force('link')?.distance(54);
        fg.d3ReheatSimulation?.();
      } catch { /* ignore */ }
      try {
        const controls = fg.controls();
        controls.autoRotate = preview;
        controls.autoRotateSpeed = 0.8;
        controls.enableZoom = !preview;
        fg.cameraPosition({ z: preview ? 330 : 300 });
      } catch { /* ignore */ }
    }, 80);
    return () => clearTimeout(t);
  }, [FG, preview, size.w, size.h]);

  // Frame the graph whenever the level changes (initial mount + each drill).
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const t = setTimeout(() => { try { fg.zoomToFit(700, 64); } catch { /* ignore */ } }, 650);
    return () => clearTimeout(t);
  }, [FG, graphData]);

  const handleClick = (node: any) => {
    const now = Date.now();
    if (lastClick.current.id === node.id && now - lastClick.current.t < 350) {
      lastClick.current = { id: null, t: 0 };
      onNodeDoubleClick?.(node);
      return;
    }
    lastClick.current = { id: node.id, t: now };
    onNodeClick?.(node);
  };

  return (
    <div ref={wrapRef} className="h-full w-full">
      {FG && (
        <FG
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          nodeColor={colorFor}
          nodeOpacity={0.92}
          nodeVal={(n: any) => (n.type === 'hub' ? 11 : n.type === 'org' ? 6 : n.type === 'interaction' ? 1.6 : 3)}
          nodeResolution={18}
          nodeThreeObjectExtend={true}
          nodeThreeObject={(n: any) => {
            if (n.type !== 'hub' && n.type !== 'org') return undefined;
            const s = new SpriteText(n.label);
            s.color = '#eef1f8';
            s.textHeight = n.type === 'hub' ? 7.5 : 5;
            s.fontWeight = '600';
            s.position.set(0, n.type === 'hub' ? 17 : 11, 0);
            (s.material as any).depthWrite = false;
            return s;
          }}
          linkColor={(l: any) => colorFor(typeof l.target === 'object' ? l.target : {})}
          linkOpacity={0.34}
          linkWidth={0.7}
          linkDirectionalParticles={preview ? 0 : 2}
          linkDirectionalParticleWidth={1.5}
          linkDirectionalParticleSpeed={0.006}
          enableNodeDrag={!preview}
          onNodeClick={handleClick}
        />
      )}
    </div>
  );
}
