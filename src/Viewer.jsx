import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";

export default function Viewer({ src }) {
  const hostRef = useRef(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f2f0ea");
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 10000);
    camera.position.set(1.7, 1.4, 2.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x75756c, 2.1));
    const light = new THREE.DirectionalLight(0xffffff, 2.3);
    light.position.set(2, 4, 3);
    scene.add(light);

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let alive = true;
    setError("");
    new PLYLoader().load(
      src,
      (geometry) => {
        if (!alive) {
          geometry.dispose();
          return;
        }
        geometry.computeBoundingBox();
        const center = geometry.boundingBox.getCenter(new THREE.Vector3());
        geometry.translate(-center.x, -center.y, -center.z);
        const size = geometry.boundingBox.getSize(new THREE.Vector3());
        const extent = Math.max(size.x, size.y, size.z);
        const hasColors = geometry.hasAttribute("color");
        if (hasColors && geometry.index === null) {
          scene.add(new THREE.Points(
            geometry,
            new THREE.PointsMaterial({
              size: extent / 420,
              sizeAttenuation: true,
              vertexColors: true,
            }),
          ));
        } else {
          geometry.computeVertexNormals();
          const material = new THREE.MeshStandardMaterial({
            color: hasColors ? 0xffffff : 0xa6a79e,
            vertexColors: hasColors,
            roughness: 0.92,
            metalness: 0,
            side: THREE.DoubleSide,
          });
          scene.add(new THREE.Mesh(geometry, material));
        }
        camera.position.set(extent * 1.7, extent * 1.25, extent * 2.1);
        camera.near = Math.max(extent / 1000, 0.001);
        camera.far = extent * 100;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
      },
      undefined,
      () => {
        if (alive) setError("Could not load the 3D model. Please try again.");
      },
    );

    let frame;
    const animate = () => {
      if (!alive) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((item) => {
        if (item.geometry) item.geometry.dispose();
        if (item.material) {
          for (const material of Array.isArray(item.material) ? item.material : [item.material]) {
            material.dispose();
          }
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src]);

  return (
    <div className="model-viewer" ref={hostRef}>
      {!error && <span className="viewer-hint">Drag to rotate · scroll to zoom</span>}
      {error && <p className="viewer-error">{error}</p>}
    </div>
  );
}
