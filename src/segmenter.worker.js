const wasmRoot = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const visionBundlePath = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.js";
const modelAssetPath = "/api/item-selection-model";
const modelSizeBytes = 30_525_312;
const maximumModelSizeBytes = 64 * 1024 * 1024;
let visionTasks;
let segmenter;
let inputCanvas;

function measureForegroundMask(values, width, height, threshold = 0.55) {
  if (!values || values.length !== width * height || width < 1 || height < 1) return null;
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 320));
  let count = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (values[y * width + x] < threshold) continue;
      count += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  const total = Math.ceil(width / stride) * Math.ceil(height / stride);
  const coverage = count / total;
  if (right < left || coverage < 0.01 || coverage > 0.92) return null;

  return {
    left: left / width,
    top: top / height,
    right: Math.min(1, (right + stride) / width),
    bottom: Math.min(1, (bottom + stride) / height),
    coverage,
  };
}

function measureFrameBrightness(imageData) {
  if (!imageData || imageData.length < 4) return null;
  const pixels = imageData.length / 4;
  const stride = Math.max(1, Math.floor(pixels / 4096));
  let total = 0;
  let samples = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    total += imageData[offset] * 0.2126 + imageData[offset + 1] * 0.7152 + imageData[offset + 2] * 0.0722;
    samples += 1;
  }
  return total / samples;
}

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
      if (!visionTasks) {
        importScripts(visionBundlePath);
        visionTasks = self.Vision;
      }
      if (!visionTasks?.FilesetResolver || !visionTasks?.InteractiveSegmenter) {
        throw new Error("The on-device vision runtime did not load correctly. Retry the item selector.");
      }
      const vision = await visionTasks.FilesetResolver.forVisionTasks(wasmRoot);
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
      segmenter = await visionTasks.InteractiveSegmenter.createFromOptions(vision, {
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
