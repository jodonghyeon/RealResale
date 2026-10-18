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

export function getAdaptiveScanGuidance({
  bounds,
  previousBounds,
  heading,
  startingHeading,
  sectorIndex,
  coverage,
}) {
  if (!bounds) {
    return {
      message: "Tap the item again in the camera view.",
      aimPoint: null,
      progress: 0,
      targetDirection: null,
      complete: false,
    };
  }

  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const sectorStart = sectorIndex * 12;
  const sectorCoverage = coverage
    .slice(sectorStart, sectorStart + 12)
    .filter(Boolean).length;
  const progress = Math.round((sectorCoverage / 12) * 100);
  const complete = sectorCoverage >= 9;
  const directions = [];

  if (bounds.left < 0.03 || bounds.right > 0.97 || bounds.top < 0.03 || bounds.bottom > 0.97) {
    directions.push("Move back slightly");
  } else if (Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) < 0.25) {
    directions.push("Move closer");
  }

  if (centerX < 0.35) directions.push("Move left in the frame");
  else if (centerX > 0.65) directions.push("Move right in the frame");
  if (centerY < 0.35) directions.push("Move toward the top of the frame");
  else if (centerY > 0.65) directions.push("Move toward the bottom of the frame");

  let targetDirection = null;
  if (!complete && coverage.length === 24 && Number.isFinite(heading) && Number.isFinite(startingHeading)) {
    const targetBins = coverage
      .map((covered, index) => ({ covered, index }))
      .filter(({ covered, index }) => !covered && index >= sectorStart && index < sectorStart + 12)
      .map(({ index }) => {
        const targetHeading = normalizeDegrees(startingHeading + index * 15 + 7.5);
        const difference = ((targetHeading - heading + 540) % 360) - 180;
        return { difference, distance: Math.abs(difference) };
      })
      .sort((left, right) => left.distance - right.distance);
    if (targetBins.length > 0) {
      const { difference } = targetBins[0];
      targetDirection = difference > 3 ? "right" : difference < -3 ? "left" : "straight";
    }
  }

  if (complete) {
    directions.push(sectorIndex === 0 ? "Start the second route" : "Capture route complete");
  } else if (targetDirection) {
    directions.push(targetDirection === "straight" ? "Continue to the next marker" : `Turn ${targetDirection}`);
  }

  if (previousBounds && Math.abs(centerX - ((previousBounds.left + previousBounds.right) / 2)) > 0.08) {
    directions.push("Align the item with the center marker again");
  }

  return {
    message: directions.length > 0 ? directions.join(" · ") : "Keep the item aligned with the center marker and follow the direction shown.",
    aimPoint: { x: centerX, y: centerY },
    progress,
    targetDirection,
    complete,
  };
}
