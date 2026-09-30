// Interaktive 3D-Ansicht eines Laderaums (three.js): drehen, zoomen, Standardansichten, Schritte, Auswahl, Bildexport
// Koordinaten des Ladeplans (cm): x = ab Stirnwand, y = ab linker Wand, z = Höhe  →  three.js: X = x, Y = z, Z = y

let THREE = null;
let OrbitControls = null;
export async function loadThree() {
  if (!THREE) {
    THREE = await import('three');
    ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
  }
  return THREE;
}

const PALETTE = ['#4f8fd6', '#e0a044', '#5bb07a', '#c9656b', '#8d77c9', '#3fb0aa', '#d38bb5', '#9aa84a', '#d97f4a', '#6c8ea8', '#b59a6b', '#7fc3e0'];
export function colorFor(piece, byStop) {
  const n = byStop ? piece.stop - 1 : Number(piece.item_id) || 0;
  return PALETTE[((n % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function textCanvas(lines, bg, wCm, hCm) {
  const scale = Math.min(4, 512 / Math.max(wCm, hCm));
  const w = Math.max(32, Math.round(wCm * scale));
  const h = Math.max(32, Math.round(hCm * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#10181f';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = Math.min(h / (lines.length + 1), w / 7);
  size = Math.max(8, Math.min(size, 64));
  lines.forEach((t, i) => {
    g.font = `${i === 0 ? 700 : 500} ${size * (i === 0 ? 1 : 0.8)}px system-ui, sans-serif`;
    let text = t;
    while (g.measureText(text).width > w * 0.92 && text.length > 3) text = text.slice(0, -2) + '…';
    g.fillText(text, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.1);
  });
  return c;
}

function spriteLabel(text, color = '#10181f', bg = 'rgba(255,255,255,0.85)') {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = '600 40px system-ui, sans-serif';
  const w = Math.ceil(g.measureText(text).width) + 30;
  c.width = w; c.height = 60;
  g.font = '600 40px system-ui, sans-serif';
  g.fillStyle = bg;
  g.fillRect(0, 0, w, 60);
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 15, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sp.scale.set((w / 60) * 48, 48, 1);
  sp.renderOrder = 10;
  return sp;
}

/**
 * space: { length_cm, width_cm, height_cm, axle_front_x_cm?, axle_rear_x_cm? }
 * placements: [{piece_id, step, x, y, z, dx, dy, dz}], pieces: {id: {label, sub, stop, item_id, weight_kg}}
 */
export function createViewer(container, { space, placements, pieces, byStop = false, cog = null, onPick = null, labels = true }) {
  const L = space.length_cm; const W = space.width_cm; const H = space.height_cm;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.replaceChildren(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(cssVar('--surface-2', '#f4f6f8'));
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.target.set(L / 2, H / 3, W / 2);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(L * 0.8, H * 3, W * 2.5);
  scene.add(dir);

  // Laderaum: Boden, Raster, Umriss, Stirnwand
  const lineColor = new THREE.Color(cssVar('--muted', '#5a6875'));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshStandardMaterial({ color: 0xb8c0c8, side: THREE.DoubleSide }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(L / 2, -0.5, W / 2);
  scene.add(floor);
  const gridPts = [];
  for (let x = 100; x < L; x += 100) gridPts.push(x, 0.2, 0, x, 0.2, W);
  const grid = new THREE.BufferGeometry();
  grid.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  scene.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: 0x8c96a0 })));
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), new THREE.LineBasicMaterial({ color: lineColor }));
  outline.position.set(L / 2, H / 2, W / 2);
  scene.add(outline);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ color: 0x0b4f8a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  wall.rotation.y = Math.PI / 2;
  wall.position.set(0, H / 2, W / 2);
  scene.add(wall);
  const front = spriteLabel('Stirnwand / Front');
  front.position.set(Math.min(90, L / 4), H + 40, W / 2);
  scene.add(front);
  const door = spriteLabel('Tür / Heck');
  door.position.set(Math.max(L - 70, L * 0.75), H + 40, W / 2);
  scene.add(door);

  // Achsen / Abstützpunkte
  const markers = [];
  if (space.axle_front_x_cm !== null && space.axle_front_x_cm !== undefined && space.axle_rear_x_cm !== null && space.axle_rear_x_cm !== undefined) {
    for (const [x, t] of [[space.axle_front_x_cm, 'vorne'], [space.axle_rear_x_cm, 'hinten']]) {
      // Markierung neben der rechten Wand (zur Kamera hin), auf Höhe des Bodens
      const cone = new THREE.Mesh(new THREE.ConeGeometry(16, 30, 4), new THREE.MeshStandardMaterial({ color: 0xd08a1e }));
      cone.position.set(x, 15, W + 30);
      scene.add(cone);
      const lb = spriteLabel(`Achse ${t}`, '#10181f', 'rgba(255,255,255,0.8)');
      lb.material.depthTest = true;
      lb.scale.multiplyScalar(0.75);
      lb.position.set(x, 55, W + 30);
      scene.add(lb);
      markers.push(cone, lb);
    }
  }

  // Ladeteile
  const meshes = new Map();
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b2530 });
  const withLabels = labels && placements.length <= 200;
  for (const pl of placements) {
    const pc = pieces[pl.piece_id] || { label: pl.piece_id, stop: 1 };
    const color = colorFor(pc, byStop);
    const geo = new THREE.BoxGeometry(pl.dx, pl.dz, pl.dy);
    let mats;
    if (withLabels) {
      const text = [pc.label, `Schritt ${pl.step}`];
      const mk = (w, hh) => {
        const tex = new THREE.CanvasTexture(textCanvas(text, color, w, hh));
        tex.colorSpace = THREE.SRGBColorSpace;
        return new THREE.MeshStandardMaterial({ map: tex, transparent: true });
      };
      const side = mk(pl.dy, pl.dz); // ±X
      const top = mk(pl.dx, pl.dy); // ±Y
      const long = mk(pl.dx, pl.dz); // ±Z
      mats = [side, side, top, top, long, long];
    } else {
      const m = new THREE.MeshStandardMaterial({ color, transparent: true });
      mats = [m, m, m, m, m, m];
    }
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(pl.x + pl.dx / 2, pl.z + pl.dz / 2, pl.y + pl.dy / 2);
    mesh.userData.pieceId = pl.piece_id;
    mesh.userData.step = pl.step;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    mesh.add(edges);
    scene.add(mesh);
    meshes.set(pl.piece_id, mesh);
  }

  // Schwerpunkt
  let cogMesh = null;
  if (cog) {
    cogMesh = new THREE.Group();
    const s = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 12), new THREE.MeshBasicMaterial({ color: 0xd62d20, depthTest: false }));
    s.renderOrder = 11;
    s.position.set(cog.x_cm, cog.z_cm, cog.y_cm);
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cog.x_cm, 0, cog.y_cm), new THREE.Vector3(cog.x_cm, cog.z_cm, cog.y_cm)]);
    const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xd62d20, depthTest: false }));
    line.renderOrder = 11;
    const lb = spriteLabel('Schwerpunkt', '#b01e14', 'rgba(255,255,255,0.8)');
    lb.scale.multiplyScalar(0.7);
    lb.position.set(cog.x_cm, cog.z_cm + 28, cog.y_cm);
    cogMesh.add(s, line, lb);
    scene.add(cogMesh);
  }

  let step = Infinity;
  let selected = null;
  let loaded = null;
  let nextId = null;
  function applyState() {
    for (const [id, m] of meshes) {
      m.visible = m.userData.step <= step;
      const isSel = id === selected;
      const isNext = id === nextId;
      const pending = loaded && !loaded.has(id);
      for (const mat of new Set(m.material)) {
        mat.opacity = pending && !isNext ? 0.28 : 1;
        mat.depthWrite = !(pending && !isNext);
        mat.emissive = new THREE.Color(isSel ? 0x2266ff : isNext ? 0xff8800 : 0x000000);
        mat.emissiveIntensity = isSel || isNext ? 0.45 : 0;
      }
    }
    render();
  }

  function size() {
    const w = container.clientWidth || 800;
    const hh = container.clientHeight || 450;
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
  }

  function view(name) {
    const R = Math.max(L, W * 2, H * 2);
    const t = new THREE.Vector3(L / 2, H / 3, W / 2);
    camera.up.set(0, 1, 0);
    const pos = {
      iso: [L * 0.98, H * 1.9 + R * 0.24, W * 2.4 + R * 0.4],
      top: [L / 2, R * 1.35, W / 2 + 0.01],
      side: [L / 2, H / 2, W / 2 + R * 1.25],
      rear: [L + R * 0.9, H * 0.9, W / 2],
      front: [-R * 0.9, H * 0.9, W / 2],
    }[name] || null;
    if (!pos) return;
    if (name === 'top') { camera.up.set(0, 0, -1); t.set(L / 2, 0, W / 2); }
    if (name === 'side') t.set(L / 2, H / 2, W / 2);
    camera.position.set(...pos);
    controls.target.copy(t);
    camera.lookAt(t);
    controls.update();
    render();
  }

  function render() { renderer.render(scene, camera); }

  const ro = new ResizeObserver(() => { size(); render(); });
  ro.observe(container);
  controls.addEventListener('change', render);
  size();
  view('iso');

  // Auswahl per Klick (ohne Ziehen)
  let down = null;
  const ray = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || !onPick) return;
    if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects([...meshes.values()].filter((m) => m.visible), false)[0];
    onPick(hit ? hit.object.userData.pieceId : null);
  });

  let disposed = false;
  return {
    setStep(n) { step = n; applyState(); },
    setSelected(id) { selected = id; applyState(); },
    setLoaded(set, next) { loaded = set; nextId = next; applyState(); },
    view,
    getCamera() { return { p: camera.position.toArray(), t: controls.target.toArray(), u: camera.up.toArray() }; },
    setCamera(c) { if (!c) return; camera.position.fromArray(c.p); controls.target.fromArray(c.t); camera.up.fromArray(c.u); controls.update(); render(); },
    snapshot(w = 1200, h = 700) {
      const prev = [container.clientWidth, container.clientHeight];
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
      const url = renderer.domElement.toDataURL('image/png');
      renderer.setSize(prev[0] || 800, prev[1] || 450, false);
      camera.aspect = (prev[0] || 800) / (prev[1] || 450);
      camera.updateProjectionMatrix();
      render();
      return url;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
      });
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}
