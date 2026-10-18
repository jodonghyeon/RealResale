import { FilesetResolver, InteractiveSegmenter } from "@mediapipe/tasks-vision";
import { measureForegroundMask, measureFrameBrightness } from "./scan-guidance.js";

const wasmRoot = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const modelAssetPath = "https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/latest/interactive_segmentation.task";
const modelSizeBytes = 30_525_312;
let segmenter;
let inputCanvas;

self.addEventListener("message", async (event) => {
  const { type } = event.data;
  if (type === "initialize") {
    try {
      self.postMessage({ type: "loading", stage: "runtime", progress: 0 });
      const vision = await FilesetResolver.forVisionTasks(wasmRoot);
      self.postMessage({ type: "loading", stage: "model", progress: 0 });
      const response = await fetch(modelAssetPath);
      if (!response.ok || !response.body) {
        throw new Error(`The item selection model download failed (HTTP ${response.status}). Check your connection and try again.`);
      }
      const sourceReader = response.body.getReader();
      const totalBytes = Number(response.headers.get("content-length")) || modelSizeBytes;
      let receivedBytes = 0;
      const modelStream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await sourceReader.read();
            if (done) {
              controller.close();
              return;
            }
            receivedBytes += value.byteLength;
            self.postMessage({
              type: "loading",
              stage: "model",
              progress: Math.min(99, Math.round((receivedBytes / totalBytes) * 100)),
            });
            controller.enqueue(value);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel(reason) {
          return sourceReader.cancel(reason);
        },
      });
      segmenter = await InteractiveSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: modelStream.getReader(), delegate: "CPU" },
      });
      inputCanvas = new OffscreenCanvas(640, 640);
      self.postMessage({ type: "ready" });
    } catch (error) {
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
