// Off-screen plate thumbnail (PNG) for .gcode.3mf files and G-code previews on printer screens.
import * as THREE from 'three';
import { objectMatrix, slotColor, useStore, type SceneObject } from '../state/store';

export async function renderThumbnail(objs: SceneObject[], size = 512, transparent = true): Promise<Uint8Array | null> {
  if (!objs.length || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: transparent, preserveDrawingBuffer: true }); }
  catch { return null; }
  const s = useStore.getState();
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, -1.5, 2);
  scene.add(sun);
  const box = new THREE.Box3();
  for (const o of objs) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(o.mesh.vertices, 3));
    g.setIndex(new THREE.BufferAttribute(o.mesh.indices, 1));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(slotColor(s, o.filament ?? 0)), roughness: 0.6, metalness: 0.05 }));
    m.matrixAutoUpdate = false;
    m.matrix.copy(objectMatrix(o));
    m.updateMatrixWorld(true);
    scene.add(m);
    box.expandByObject(m);
  }
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getBoundingSphere(new THREE.Sphere()).radius || 10;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, r * 20);
  cam.up.set(0, 0, 1);
  const dir = new THREE.Vector3(0.6, -1, 0.75).normalize();
  cam.position.copy(c).addScaledVector(dir, r / Math.sin((15 * Math.PI) / 180) * 1.05);
  cam.lookAt(c);
  renderer.setClearColor(0x000000, transparent ? 0 : 1);
  renderer.render(scene, cam);
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  renderer.dispose();
  scene.traverse((x) => { if (x instanceof THREE.Mesh) { x.geometry.dispose(); (x.material as THREE.Material).dispose(); } });
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
