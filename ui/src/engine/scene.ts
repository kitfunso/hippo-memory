import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { Memory, Conflict } from "../types.js";
import { LAYER_COLORS } from "./types.js";
import {
  COLOR_BG,
  COLOR_ACCENT_HEX,
  COLOR_AMBIENT_LIGHT_HEX,
  COLOR_GRID_HEX,
  COLOR_CONFLICT_HEX,
} from "../tokens.js";

const SPREAD = 20;
const LAYER_Y_OFFSET: Record<string, number> = { buffer: 6, episodic: 0, semantic: -6 };

function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

interface MemoryNode {
  id: string;
  memory: Memory;
  mesh: THREE.Mesh;
  basePosition: THREE.Vector3;
  halo: THREE.Mesh;
  phase: number;
  driftSpeed: number;
}

export class BrainScene {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private nodes: MemoryNode[] = [];
  private tendrils: THREE.Line[] = [];
  private conflictLines: THREE.Line[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private hoveredNode: MemoryNode | null = null;
  private selectedNode: MemoryNode | null = null;
  private highlightedIds: Set<string> = new Set();
  private searchDimmed = false;
  private clock = new THREE.Clock();
  private gridHelper!: THREE.Group;
  private onHoverCb: ((memory: Memory | null, x: number, y: number) => void) | null = null;
  private onClickCb: ((memory: Memory | null) => void) | null = null;
  private disposed = false;
  private rafId = 0;
  /** E1.5: per-frame render callbacks for screen-space label overlay (E4). */
  private onRenderCbs: Array<(camera: THREE.PerspectiveCamera, scene: THREE.Scene) => void> = [];

  constructor(private container: HTMLDivElement) {
    this.initRenderer();
    this.initScene();
    this.initCamera();
    this.initControls();
    this.initPostProcessing();
    this.initGrid();
    this.animate();
  }

  private initRenderer(): void {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
  }

  private initScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLOR_BG);
    // Lighter fog density for parchment bg — heavy fog reads as fog of war on
    // dark, as haze on light; halve density to preserve depth without muddying.
    this.scene.fog = new THREE.FogExp2(COLOR_BG, 0.008);

    // Warmer + brighter ambient for parchment (was 0x111122 @ 0.5 on dark)
    const ambient = new THREE.AmbientLight(COLOR_AMBIENT_LIGHT_HEX, 0.65);
    this.scene.add(ambient);

    const point = new THREE.PointLight(COLOR_ACCENT_HEX, 0.4, 100);
    point.position.set(0, 15, 10);
    this.scene.add(point);
  }

  private initCamera(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 200);
    this.camera.position.set(0, 8, 28);
    this.camera.lookAt(0, 0, 0);
  }

  private initControls(): void {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 80;
    this.controls.maxPolarAngle = Math.PI * 0.85;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.3;
  }

  private initPostProcessing(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    const bloom = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      1.2,
      0.5,
      0.2,
    );
    this.composer.addPass(bloom);
  }

  private initGrid(): void {
    this.gridHelper = new THREE.Group();

    // Parchment grid: warm border color, slightly higher opacity than the
    // pre-revamp 0xffffff/0.03 (white on dark) since darker-on-light needs
    // more presence to read at the same visual weight.
    const gridMaterial = new THREE.LineBasicMaterial({ color: COLOR_GRID_HEX, transparent: true, opacity: 0.06 });
    const size = 40;
    const divisions = 20;
    const step = size / divisions;

    for (let i = -size / 2; i <= size / 2; i += step) {
      const geoX = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(i, -10, -size / 2),
        new THREE.Vector3(i, -10, size / 2),
      ]);
      this.gridHelper.add(new THREE.Line(geoX, gridMaterial));

      const geoZ = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-size / 2, -10, i),
        new THREE.Vector3(size / 2, -10, i),
      ]);
      this.gridHelper.add(new THREE.Line(geoZ, gridMaterial));
    }

    this.scene.add(this.gridHelper);
  }

  setCallbacks(
    onHover: (memory: Memory | null, x: number, y: number) => void,
    onClick: (memory: Memory | null) => void,
  ): void {
    this.onHoverCb = onHover;
    this.onClickCb = onClick;
  }

  populate(
    memories: Memory[],
    positions: Record<string, [number, number, number]>,
    conflicts: Conflict[],
  ): void {
    for (const node of this.nodes) {
      this.scene.remove(node.mesh);
      this.scene.remove(node.halo);
      node.mesh.geometry.dispose();
      node.halo.geometry.dispose();
    }
    for (const line of this.tendrils) {
      this.scene.remove(line);
      line.geometry.dispose();
    }
    for (const line of this.conflictLines) {
      this.scene.remove(line);
      line.geometry.dispose();
    }
    this.nodes = [];
    this.tendrils = [];
    this.conflictLines = [];

    const maxRetrieval = memories.reduce((m, mem) => Math.max(m, mem.retrieval_count), 1);

    for (const mem of memories) {
      const pos = positions[mem.id] ?? [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
      const layerY = LAYER_Y_OFFSET[mem.layer] ?? 0;

      const x = pos[0] * SPREAD + (Math.random() - 0.5) * 3;
      const y = pos[1] * SPREAD * 0.5 + layerY + (Math.random() - 0.5) * 2;
      const z = pos[2] * SPREAD + (Math.random() - 0.5) * 3;

      const color = hexToColor(LAYER_COLORS[mem.layer]);
      const logRatio = Math.log2(mem.retrieval_count + 1) / Math.log2(maxRetrieval + 1);
      const radius = 0.15 + logRatio * 0.35;

      const sphereGeo = new THREE.SphereGeometry(radius, 24, 24);
      const sphereMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.6 + mem.strength * 0.8,
        roughness: 0.3,
        metalness: 0.1,
        transparent: true,
        opacity: 0.3 + mem.strength * 0.7,
      });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.set(x, y, z);
      sphere.userData = { memoryId: mem.id };
      this.scene.add(sphere);

      const haloGeo = new THREE.SphereGeometry(radius * 3, 16, 16);
      const haloMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.06 + mem.strength * 0.08,
        side: THREE.BackSide,
        depthWrite: false,
      });
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.copy(sphere.position);
      this.scene.add(halo);

      this.nodes.push({
        id: mem.id,
        memory: mem,
        mesh: sphere,
        halo,
        basePosition: sphere.position.clone(),
        phase: Math.random() * Math.PI * 2,
        driftSpeed: 0.2 + Math.random() * 0.3,
      });
    }

    this.buildTendrils();
    this.buildConflictLines(conflicts);
  }

  private buildTendrils(): void {
    const n = this.nodes.length;
    if (n > 500) return;

    const maxDist = 6;
    const maxDistSq = maxDist * maxDist;

    for (let i = 0; i < n; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.nodes[j];
        const dx = a.basePosition.x - b.basePosition.x;
        const dy = a.basePosition.y - b.basePosition.y;
        const dz = a.basePosition.z - b.basePosition.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > maxDistSq) continue;

        const dist = Math.sqrt(distSq);
        const fade = 1 - dist / maxDist;

        const mid = new THREE.Vector3().lerpVectors(a.basePosition, b.basePosition, 0.5);
        mid.y += (Math.random() - 0.5) * 1.5;

        const curve = new THREE.QuadraticBezierCurve3(a.basePosition, mid, b.basePosition);
        const points = curve.getPoints(12);
        const geo = new THREE.BufferGeometry().setFromPoints(points);

        const colA = hexToColor(a.mesh.userData.color ?? LAYER_COLORS[a.memory.layer]);
        const colB = hexToColor(b.mesh.userData.color ?? LAYER_COLORS[b.memory.layer]);
        const mixedColor = colA.clone().lerp(colB, 0.5);

        const mat = new THREE.LineBasicMaterial({
          color: mixedColor,
          transparent: true,
          opacity: fade * fade * 0.15,
          depthWrite: false,
        });

        const line = new THREE.Line(geo, mat);
        this.scene.add(line);
        this.tendrils.push(line);
      }
    }
  }

  private buildConflictLines(conflicts: Conflict[]): void {
    const nodeMap = new Map<string, MemoryNode>();
    for (const node of this.nodes) nodeMap.set(node.id, node);

    for (const c of conflicts) {
      const a = nodeMap.get(c.memory_a_id);
      const b = nodeMap.get(c.memory_b_id);
      if (!a || !b) continue;

      const mid = new THREE.Vector3().lerpVectors(a.basePosition, b.basePosition, 0.5);
      mid.y += 1;

      const curve = new THREE.QuadraticBezierCurve3(a.basePosition, mid, b.basePosition);
      const points = curve.getPoints(16);
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineDashedMaterial({
        color: COLOR_CONFLICT_HEX,
        transparent: true,
        opacity: 0.3 + c.score * 0.4,
        dashSize: 0.3,
        gapSize: 0.2,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      this.scene.add(line);
      this.conflictLines.push(line);
    }
  }

  setHighlighted(ids: Set<string>): void {
    this.highlightedIds = ids;
    this.searchDimmed = ids.size > 0;
    this.applyDimming();
  }

  clearHighlight(): void {
    this.highlightedIds.clear();
    this.searchDimmed = false;
    this.applyDimming();
  }

  private applyDimming(): void {
    for (const node of this.nodes) {
      const mat = node.mesh.material as THREE.MeshStandardMaterial;
      const haloMat = node.halo.material as THREE.MeshBasicMaterial;

      if (this.searchDimmed && !this.highlightedIds.has(node.id)) {
        mat.opacity = 0.05;
        mat.emissiveIntensity = 0.1;
        haloMat.opacity = 0.01;
      } else {
        mat.opacity = 0.3 + node.memory.strength * 0.7;
        mat.emissiveIntensity = 0.6 + node.memory.strength * 0.8;
        haloMat.opacity = 0.06 + node.memory.strength * 0.08;
      }
    }
  }

  handleMouseMove(event: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = this.nodes.map((n) => n.mesh);
    const intersects = this.raycaster.intersectObjects(meshes);

    const prevHovered = this.hoveredNode;

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const memId = hit.userData.memoryId as string;
      this.hoveredNode = this.nodes.find((n) => n.id === memId) ?? null;
      this.renderer.domElement.style.cursor = "pointer";

      if (this.hoveredNode && this.onHoverCb) {
        this.onHoverCb(this.hoveredNode.memory, event.clientX, event.clientY);
      }
    } else {
      this.hoveredNode = null;
      this.renderer.domElement.style.cursor = "grab";
      if (prevHovered && this.onHoverCb) {
        this.onHoverCb(null, 0, 0);
      }
    }

    if (prevHovered && prevHovered !== this.hoveredNode) {
      const mat = prevHovered.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.6 + prevHovered.memory.strength * 0.8;
      prevHovered.mesh.scale.setScalar(1);
      (prevHovered.halo.material as THREE.MeshBasicMaterial).opacity =
        0.06 + prevHovered.memory.strength * 0.08;
    }

    if (this.hoveredNode) {
      const mat = this.hoveredNode.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 2.0;
      this.hoveredNode.mesh.scale.setScalar(1.4);
      (this.hoveredNode.halo.material as THREE.MeshBasicMaterial).opacity = 0.2;
    }
  }

  handleClick(): void {
    if (this.hoveredNode) {
      if (this.selectedNode && this.selectedNode !== this.hoveredNode) {
        this.selectedNode.mesh.scale.setScalar(1);
      }
      this.selectedNode = this.hoveredNode;
      if (this.onClickCb) this.onClickCb(this.hoveredNode.memory);
    } else {
      if (this.selectedNode) this.selectedNode.mesh.scale.setScalar(1);
      this.selectedNode = null;
      if (this.onClickCb) this.onClickCb(null);
    }
  }

  deselect(): void {
    if (this.selectedNode) this.selectedNode.mesh.scale.setScalar(1);
    this.selectedNode = null;
    if (this.onClickCb) this.onClickCb(null);
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);

    const elapsed = this.clock.getElapsedTime();
    this.controls.update();

    for (const node of this.nodes) {
      const drift = Math.sin(elapsed * node.driftSpeed + node.phase);
      const driftY = Math.cos(elapsed * node.driftSpeed * 0.7 + node.phase * 1.3);
      node.mesh.position.x = node.basePosition.x + drift * 0.15;
      node.mesh.position.y = node.basePosition.y + driftY * 0.1;
      node.mesh.position.z = node.basePosition.z + Math.sin(elapsed * node.driftSpeed * 0.5 + node.phase * 0.7) * 0.12;
      node.halo.position.copy(node.mesh.position);

      if (node === this.selectedNode) {
        const pulse = 1.3 + 0.1 * Math.sin(elapsed * 3 + node.phase);
        node.mesh.scale.setScalar(pulse);
      }
    }

    // E1.5: notify per-frame subscribers (E4's label overlay). Single-line
    // hot-path insertion per plan v2 round-2 LOW #7 carve-out. Refactoring
    // this loop is out of scope; only the forEach is in-scope here.
    if (this.onRenderCbs.length > 0) {
      for (const cb of this.onRenderCbs) cb(this.camera, this.scene);
    }

    this.composer.render();
  };

  // -------------------------------------------------------------------------
  // E1.5 — Engine surface API extensions for E2 (freeze), E4 (label overlay),
  // and E5 (prefers-reduced-motion + drawer mirror).
  //
  // Internals (layout algorithm, particle physics, render order) remain
  // out of scope. Only single-line insertions in animate() are in-scope
  // per plan v2 round-2 LOW #7 carve-out.
  // -------------------------------------------------------------------------

  /**
   * Freeze or restart the animation loop. Used by E2's freeze-toggle and E5's
   * prefers-reduced-motion media query.
   *
   * Implementation note (round-2 HIGH #1 + round-3 HIGH #1 fixes): matches
   * scene.ts's existing rafId-based loop. Does NOT use Three.js's
   * setAnimationLoop API (which scene.ts never adopted). When freezing,
   * snaps particles to their basePosition rather than iterating to convergence
   * (the sin/cos drift physics at L423-L435 never converges).
   */
  setReducedMotion(reduced: boolean): void {
    if (reduced) {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      this.snapParticlesToFinal();
    } else if (!this.rafId) {
      this.animate(); // restart the existing loop
    }
  }

  /**
   * Toggle node visibility based on a filter set. Used by E3's FilterPanel.
   * Layout is NOT re-run; filtered nodes are hidden in place. To restore
   * full visibility, pass an empty set.
   */
  setFiltered(visibleIds: Set<string>): void {
    const filterActive = visibleIds.size > 0;
    for (const node of this.nodes) {
      const visible = !filterActive || visibleIds.has(node.id);
      node.mesh.visible = visible;
      node.halo.visible = visible;
    }
  }

  /**
   * Register a per-frame render callback. Used by E4's LabelOverlay to
   * project node world-coords to screen-coords each frame.
   *
   * Returns an unsubscribe function. Callbacks fire once per animate()
   * tick AFTER drift physics + BEFORE composer.render(). Keep them cheap;
   * with N=1000 nodes the perf budget is ~8ms/frame to hold 60fps.
   */
  onRender(cb: (camera: THREE.PerspectiveCamera, scene: THREE.Scene) => void): () => void {
    this.onRenderCbs.push(cb);
    return () => {
      const i = this.onRenderCbs.indexOf(cb);
      if (i >= 0) this.onRenderCbs.splice(i, 1);
    };
  }

  /**
   * Accessor for the perspective camera. Used by E4's LabelOverlay so it
   * can call `vector.project(camera)` without reaching into private fields.
   *
   * Returns the actual PerspectiveCamera (not the wider THREE.Camera base)
   * so consumers can access `.aspect`, `.updateProjectionMatrix()`, etc.
   * (round-3 LOW #4 fix.)
   */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Snap drifting particles to their basePosition (freeze pose). Called by
   * setReducedMotion(true). The drift physics is pure sin oscillation
   * (L423-L435 of animate) — there is no convergence target other than
   * basePosition itself, so we copy it directly.
   */
  private snapParticlesToFinal(): void {
    for (const node of this.nodes) {
      node.mesh.position.copy(node.basePosition);
      node.halo.position.copy(node.basePosition);
    }
    // One final paint so reduced-motion users see the static layout, not
    // the last animated frame.
    this.composer.render();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.controls.dispose();

    for (const node of this.nodes) {
      node.mesh.geometry.dispose();
      (node.mesh.material as THREE.Material).dispose();
      node.halo.geometry.dispose();
      (node.halo.material as THREE.Material).dispose();
    }
    for (const line of [...this.tendrils, ...this.conflictLines]) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }

    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
