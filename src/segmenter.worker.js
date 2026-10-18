import { FilesetResolver, InteractiveSegmenter } from "@mediapipe/tasks-vision";
import { measureForegroundMask, measureFrameBrightness } from "./scan-guidance.js";

const wasmRoot = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const modelAssetPath = "https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/latest/interactive_segmentation.task";
let segmenter;
let inputCanvas;

self.addEventListener("message", async (event) => {
  const { type } = event.data;
  if (type === "initialize") {
    try {
      const vision = await FilesetResolver.forVisionTasks(wasmRoot);
      segmenter = await InteractiveSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate: "CPU" },
      });
      inputCanvas = new OffscreenCanvas(640, 640);
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "상품 선택 모델을 불러오지 못했어요.",
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
    if (!context) throw new Error("카메라 화면을 처리할 수 없어요.");
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
      message: error instanceof Error ? error.message : "상품 영역을 분리하지 못했어요.",
    });
  }
});
