import { FilesetResolver, InteractiveSegmenter } from "@mediapipe/tasks-vision";
import { measureForegroundMask, measureFrameBrightness } from "./scan-guidance.js";

const wasmRoot = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const modelAssetPath = "/api/item-selection-model";
const modelSizeBytes = 30_525_312;
const maximumModelSizeBytes = 64 * 1024 * 1024;
let segmenter;
let inputCanvas;

function readWithTimeout(reader, timeoutMs) {
  let timeout;
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("The item selection model download stopped responding. Check your connection and retry.")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

self.addEventListener("message", async (event) => {
  const { type } = event.data;
  if (type === "initialize") {
    let sourceReader;
    try {
      self.postMessage({ type: "loading", stage: "runtime", progress: 0 });
      const vision = await FilesetResolver.forVisionTasks(wasmRoot);
      self.postMessage({ type: "loading", stage: "download", progress: 0 });
      const response = await fetch(modelAssetPath, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) {
        throw new Error(`The item selection model download failed (HTTP ${response.status}). Try again.`);
      }
      const totalBytes = Number(response.headers.get("content-length")) || modelSizeBytes;
      if (totalBytes > maximumModelSizeBytes) {
        throw new Error("The item selection model response was unexpectedly large. Try again.");
      }
      sourceReader = response.body.getReader();
      const modelBuffer = new Uint8Array(totalBytes);
      let receivedBytes = 0;
      while (true) {
        const { done, value } = await readWithTimeout(sourceReader, 30_000);
        if (done) break;
        if (receivedBytes + value.byteLength > modelBuffer.byteLength) {
          throw new Error("The item selection model download exceeded its expected size. Try again.");
        }
        modelBuffer.set(value, receivedBytes);
        receivedBytes += value.byteLength;
        const downloadComplete = receivedBytes === totalBytes;
        self.postMessage({
          type: "loading",
          stage: downloadComplete ? "verify" : "download",
          progress: downloadComplete ? 100 : Math.min(99, Math.round((receivedBytes / totalBytes) * 100)),
        });
      }
      if (receivedBytes !== totalBytes) {
        throw new Error(`The item selection model download ended early (${receivedBytes} of ${totalBytes} bytes). Retry the download.`);
      }
      await sourceReader.cancel();
      sourceReader = null;
      self.postMessage({ type: "loading", stage: "initializing", progress: 100 });
      segmenter = await InteractiveSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: modelBuffer, delegate: "CPU" },
      });
      inputCanvas = new OffscreenCanvas(640, 640);
      self.postMessage({ type: "ready" });
    } catch (error) {
      await sourceReader?.cancel(error).catch(() => {});
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "Could not load the item selection model.",
      });
    }
    return;
  }
  if (type !== "segment" || !segmenter || !inputCanvas) return;

  const { bitmap, point } = event.data;
  try {
    const scale = Math.min(640 / bitmap.width, 640 / bitmap.height);
    inputCanvas.width = Math.max(1, Math.round(bitmap.width * scale));
    inputCanvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = inputCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot process the camera frame.");
    context.drawImage(bitmap, 0, 0, inputCanvas.width, inputCanvas.height);
    const brightness = measureFrameBrightness(context.getImageData(0, 0, inputCanvas.width, inputCanvas.height).data);
    bitmap.close();
    segmenter.setImage(inputCanvas);
    const mask = segmenter.segment([
      { brushMode: 1, point: [{ x: point.x, y: point.y }], isCompleted: true },
    ]);
    const bounds = measureForegroundMask(mask.getAsFloat32Array(), mask.width, mask.height);
    mask.close();
    self.postMessage({ type: "result", bounds, brightness });
  } catch (error) {
    bitmap.close();
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Could not segment the selected item.",
    });
  }
});
