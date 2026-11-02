import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

export type ViewMode = 'touch' | 'camera';
export type PresetName = 'front' | 'side' | 'back' | 'face' | 'full';

export interface EngineCallbacks {
  onProgress?: (ratio: number) => void;
  onReady?: () => void;
  onError?: (message: string) => void;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

interface OrbitState {
  theta: number;
  phi: number;
  radius: number;
  target: THREE.Vector3;
}

export class Engine {
  private canvas: HTMLCanvasElement;
  private callbacks: EngineCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  private vrm: VRM | null = null;
  private modelHeight = 1.5;
  private mode: ViewMode = 'touch';
  private currentPreset: PresetName = 'full';
  private wasPortrait = false;

  private orbit: OrbitState = {
    theta: 0,
    phi: 1.42,
    radius: 3.1,
    target: new THREE.Vector3(0, 0.8, 0),
  };
  private orbitGoal: OrbitState = {
    theta: 0,
    phi: 1.42,
    radius: 3.1,
    target: new THREE.Vector3(0, 0.8, 0),
  };

  private lookTarget = new THREE.Object3D();
  private gazeGoal = new THREE.Vector3(0, 1.35, 0.6);
  private raycaster = new THREE.Raycaster();
  private gazePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.55);

  private pointers = new Map<number, { x: number; y: number; button: number }>();
  private pinchDist = 0;

  private elapsed = 0;
  private nextBlinkAt = 1.4;
  private blinkStart = -1;
  private breathBones: { node: THREE.Object3D; baseX: number; amp: number; phase: number }[] = [];

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);

    const hemi = new THREE.HemisphereLight(0xdcefff, 0x141a2c, 1.1);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1.6, 2.6, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -1.4;
    key.shadow.camera.right = 1.4;
    key.shadow.camera.top = 2.4;
    key.shadow.camera.bottom = -0.4;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 8;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x38b6e8, 1.1);
    rim.position.set(-2.0, 1.6, -1.8);
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1.6, 48),
      new THREE.ShadowMaterial({ opacity: 0.3 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0.001;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.scene.add(this.lookTarget);
    this.lookTarget.position.copy(this.gazeGoal);

    this.attachInput();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    if (canvas.parentElement) this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.loop();
  }

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    try {
      const gltf = await loader.loadAsync(url, (event) => {
        if (event.total > 0) this.callbacks.onProgress?.(event.loaded / event.total);
      });
      const vrm = gltf.userData.vrm as VRM;
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      VRMUtils.combineSkeletons(vrm.scene);
      vrm.scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.castShadow = true;
          obj.frustumCulled = false;
        }
      });
      const box = new THREE.Box3().setFromObject(vrm.scene);
      this.modelHeight = Math.max(0.5, box.max.y - box.min.y);
      vrm.scene.position.y -= box.min.y;
      this.vrm = vrm;
      this.scene.add(vrm.scene);
      if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;
      this.setupBreathBones();
      this.applyRestPose();
      this.gazeGoal.set(0, this.modelHeight * 0.88, 0.6);
      this.goToPreset('full', true);
      this.callbacks.onProgress?.(1);
      this.callbacks.onReady?.();
    } catch (err) {
      console.error(err);
      this.callbacks.onError?.('モデルの読み込みに失敗しました。通信環境を確認して、もう一度開いてみてください。');
    }
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.pointers.clear();
    if (mode === 'touch') {
      this.gazeGoal.set(0, this.modelHeight * 0.88, 0.6);
    }
  }

  getMode(): ViewMode {
    return this.mode;
  }

  private isPortrait(): boolean {
    return (this.camera.aspect || 1) < 0.9;
  }

  // 縦長画面ではモデルが画面からはみ出しやすいので、その分だけカメラを引く
  private frameScale(): number {
    const a = this.camera.aspect || 1;
    if (a >= 0.9) return 1;
    return Math.min(1.6, Math.max(1, 0.68 / a));
  }

  goToPreset(name: PresetName, instant = false): void {
    this.currentPreset = name;
    const h = this.modelHeight;
    const s = this.frameScale();
    const base = { phi: 1.34, radius: h * 1.3 * Math.pow(s, 0.6), targetY: h * 0.56 };
    const presets: Record<PresetName, Partial<OrbitState> & { targetY?: number }> = {
      full: { theta: 0, phi: 1.42, radius: h * 2.05 * s, targetY: h * (this.isPortrait() ? 0.58 : 0.5) },
      front: { theta: 0, ...base },
      side: { theta: Math.PI / 2, ...base },
      back: { theta: Math.PI, ...base },
      face: { theta: 0, phi: 1.24, radius: h * 0.52 * Math.min(s, 1.2), targetY: h * 0.86 },
    };
    const p = presets[name];
    this.orbitGoal.theta = p.theta ?? this.orbitGoal.theta;
    this.orbitGoal.phi = p.phi ?? this.orbitGoal.phi;
    this.orbitGoal.radius = p.radius ?? this.orbitGoal.radius;
    if (p.targetY !== undefined) this.orbitGoal.target.set(0, p.targetY, 0);
    if (instant) {
      this.orbit.theta = this.orbitGoal.theta;
      this.orbit.phi = this.orbitGoal.phi;
      this.orbit.radius = this.orbitGoal.radius;
      this.orbit.target.copy(this.orbitGoal.target);
    }
  }

  resetCamera(): void {
    this.goToPreset('full');
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.detachInput();
    this.renderer.dispose();
  }

  // ---- internal ----

  private applyRestPose(): void {
    if (!this.vrm) return;
    const humanoid = this.vrm.humanoid;
    // Tポーズの腕を自然に下ろした休止姿勢にする (Phase 2 の IK はこの姿勢を基準に足す)
    const upper = THREE.MathUtils.degToRad(68);
    const fore = THREE.MathUtils.degToRad(10);
    const set = (name: string, z: number) => {
      const node = humanoid.getNormalizedBoneNode(name as never);
      if (node) node.rotation.z = z;
    };
    set('leftUpperArm', -upper);
    set('rightUpperArm', upper);
    set('leftLowerArm', -fore);
    set('rightLowerArm', fore);
  }

  private setupBreathBones(): void {
    if (!this.vrm) return;
    const defs: [string, number][] = [
      ['chest', 0.02],
      ['upperChest', 0.011],
    ];
    for (const [name, amp] of defs) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name as never);
      if (node) this.breathBones.push({ node, baseX: node.rotation.x, amp, phase: 0 });
    }
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const portrait = this.isPortrait();
    if (portrait !== this.wasPortrait) {
      this.wasPortrait = portrait;
      if (this.vrm) this.goToPreset(this.currentPreset, true);
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += dt;
    this.updateOrbit(dt);
    this.updateGaze(dt);
    this.updateBlink();
    this.updateBreath();
    this.vrm?.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateOrbit(dt: number): void {
    const k = 1 - Math.exp(-dt * 7);
    this.orbit.theta = angleLerp(this.orbit.theta, this.orbitGoal.theta, k);
    this.orbit.phi += (this.orbitGoal.phi - this.orbit.phi) * k;
    this.orbit.radius += (this.orbitGoal.radius - this.orbit.radius) * k;
    this.orbit.target.lerp(this.orbitGoal.target, k);
    const sph = new THREE.Spherical(this.orbit.radius, this.orbit.phi, this.orbit.theta);
    this.camera.position.setFromSpherical(sph).add(this.orbit.target);
    this.camera.lookAt(this.orbit.target);
  }

  private updateGaze(dt: number): void {
    if (!this.vrm) return;
    const k = 1 - Math.exp(-dt * 9);
    this.lookTarget.position.lerp(this.gazeGoal, k);
  }

  private updateBlink(): void {
    const mgr = this.vrm?.expressionManager;
    if (!mgr) return;
    const t = this.elapsed;
    if (this.blinkStart < 0 && t >= this.nextBlinkAt) this.blinkStart = t;
    if (this.blinkStart >= 0) {
      const p = (t - this.blinkStart) / 0.18;
      if (p >= 1) {
        mgr.setValue('blink', 0);
        this.blinkStart = -1;
        this.nextBlinkAt = t + 2.2 + Math.random() * 2.6;
      } else {
        mgr.setValue('blink', Math.sin(Math.PI * p));
      }
    }
  }

  private updateBreath(): void {
    const s = Math.sin(this.elapsed * ((Math.PI * 2) / 4.6));
    for (const b of this.breathBones) {
      b.node.rotation.x = b.baseX + s * b.amp;
    }
  }

  // ---- input ----

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    if (this.mode === 'touch') this.updateGazeFromPointer(e);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.mode === 'touch') {
      this.updateGazeFromPointer(e);
      return;
    }
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && dist > 0) {
        this.orbitGoal.radius = clamp(
          this.orbitGoal.radius * (this.pinchDist / dist),
          this.modelHeight * 0.3,
          this.modelHeight * 3.6,
        );
      }
      this.pinchDist = dist;
      this.panBy(dx * 0.5, dy * 0.5);
      return;
    }
    if (prev.button === 2 || e.shiftKey) {
      this.panBy(dx, dy);
    } else {
      this.orbitGoal.theta -= dx * 0.0052;
      this.orbitGoal.phi = clamp(this.orbitGoal.phi - dy * 0.0052, 0.12, 1.53);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinchDist = 0;
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.mode !== 'camera') return;
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0011);
    this.orbitGoal.radius = clamp(
      this.orbitGoal.radius * factor,
      this.modelHeight * 0.3,
      this.modelHeight * 3.6,
    );
  };

  private onContextMenu = (e: Event): void => e.preventDefault();

  private panBy(dx: number, dy: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const scale = this.orbitGoal.radius * 0.0016;
    this.orbitGoal.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    this.orbitGoal.target.x = clamp(this.orbitGoal.target.x, -0.9, 0.9);
    this.orbitGoal.target.y = clamp(this.orbitGoal.target.y, 0.15, this.modelHeight * 1.05);
    this.orbitGoal.target.z = clamp(this.orbitGoal.target.z, -0.5, 0.5);
  }

  private updateGazeFromPointer(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.gazePlane, hit)) {
      const h = this.modelHeight;
      hit.x = clamp(hit.x, -h * 0.75, h * 0.75);
      hit.y = clamp(hit.y, h * 0.25, h * 1.12);
      hit.z = 0.55;
      this.gazeGoal.copy(hit);
    }
  }

  private attachInput(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  private detachInput(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }
}
