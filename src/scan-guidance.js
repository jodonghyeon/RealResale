export function measureForegroundMask(values, width, height, threshold = 0.55) {
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

export function getFramingGuidance(bounds) {
  if (!bounds) return "Tap the item again near the center of the screen.";
  if (
    bounds.left < 0.025 ||
    bounds.top < 0.025 ||
    bounds.right > 0.975 ||
    bounds.bottom > 0.975
  ) {
    return "Move back slightly so the entire item stays in frame.";
  }
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (Math.max(width, height) < 0.28) return "Move closer to the item.";
  if (Math.max(width, height) > 0.78) return "Move back slightly so the whole item is visible.";
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  if (centerX < 0.25 || centerX > 0.75 || centerY < 0.2 || centerY > 0.8) {
    return "Keep the item centered in the frame.";
  }
  return "Good. Keep it in focus and slowly capture this side.";
}

export function getDetailCaptureGuidance(bounds) {
  if (!bounds) return "Tap the item again near the center of the screen.";
  if (
    bounds.left < 0.025 ||
    bounds.top < 0.025 ||
    bounds.right > 0.975 ||
    bounds.bottom > 0.975
  ) {
    return "Move back slightly so the item is not cut off.";
  }
  const extent = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top);
  if (extent < 0.55) return "Move closer to capture surface details.";
  if (extent > 0.88) return "Move back slightly so the item's edges stay visible.";
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  if (centerX < 0.3 || centerX > 0.7 || centerY < 0.25 || centerY > 0.75) {
    return "Keep the item centered in the frame.";
  }
  return "Good. Keep it in focus and slowly rotate the item to capture every side up close.";
}

export function hasDetailCaptureFraming(bounds) {
  if (!bounds) return false;
  const extent = Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top);
  return (
    bounds.left >= 0.025 &&
    bounds.top >= 0.025 &&
    bounds.right <= 0.975 &&
    bounds.bottom <= 0.975 &&
    extent >= 0.55 &&
    extent <= 0.88
  );
}

export function supportsDetailCaptureResolution(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && Math.max(width, height) >= 3840;
}

export function measureLaplacianVariance(values, width, height) {
  if (!values || width < 3 || height < 3 || values.length !== width * height) return 0;
  let sum = 0;
  let sumSquares = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      const laplacian =
        values[pixel - width] +
        values[pixel - 1] +
        values[pixel + 1] +
        values[pixel + width] -
        4 * values[pixel];
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      samples += 1;
    }
  }
  const mean = sum / samples;
  return sumSquares / samples - mean * mean;
}

export function measureFrameBrightness(imageData) {
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

export function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

export function recordHeadingCoverage(coverage, heading, startingHeading) {
  if (coverage.length !== 24 || !Number.isFinite(heading) || !Number.isFinite(startingHeading)) return coverage;
  const relativeHeading = normalizeDegrees(heading - startingHeading);
  const bin = Math.floor(relativeHeading / 15);
  const updated = [...coverage];
  updated[bin] = true;
  return updated;
}

export function getRouteCoverage(coverage, sectorIndex, requiredBins = 9) {
  const sectorStart = sectorIndex * 12;
  const covered = coverage.slice(sectorStart, sectorStart + 12).filter(Boolean).length;
  return {
    covered,
    progress: Math.min(100, Math.round((covered / requiredBins) * 100)),
    complete: covered >= requiredBins,
  };
}

export function getAdaptiveScanGuidance({
  bounds,
  sectorIndex,
  coverage,
}) {
  if (!bounds) {
    return {
      message: "Tap the item again in the camera view.",
      progress: 0,
      complete: false,
    };
  }

  const { progress, complete } = getRouteCoverage(coverage, sectorIndex);

  if (bounds.left < 0.03 || bounds.right > 0.97 || bounds.top < 0.03 || bounds.bottom > 0.97) {
    return {
      message: "Move back slightly so the whole item stays in frame.",
      progress,
      complete,
    };
  }
  if (Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) < 0.25) {
    return {
      message: "Move closer while keeping the whole item in frame.",
      progress,
      complete,
    };
  }

  const message = complete
    ? "This half is complete. Continue to the next step."
    : sectorIndex === 0
      ? "Keep the item centered. Slowly move around it for the first half of the circle."
      : "Keep the item centered. Continue in the same direction around the remaining half.";

  return {
    message,
    progress,
    complete,
  };
}
