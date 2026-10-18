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
  if (!bounds) return "상품을 화면 가운데에서 다시 선택해 주세요.";
  if (
    bounds.left < 0.025 ||
    bounds.top < 0.025 ||
    bounds.right > 0.975 ||
    bounds.bottom > 0.975
  ) {
    return "상품 가장자리가 잘리지 않도록 조금 멀리 이동해 주세요.";
  }
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (Math.max(width, height) < 0.28) return "상품에 더 가까이 다가가 주세요.";
  if (Math.max(width, height) > 0.78) return "상품 전체가 보이도록 조금 멀리 이동해 주세요.";
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  if (centerX < 0.25 || centerX > 0.75 || centerY < 0.2 || centerY > 0.8) {
    return "상품을 화면 가운데에 놓아 주세요.";
  }
  return "좋아요. 초점을 유지한 채 이 면을 천천히 촬영하세요.";
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
      message: "화면에서 상품을 다시 선택하세요.",
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
    directions.push("조금 멀어지세요");
  } else if (Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top) < 0.25) {
    directions.push("조금 가까이 오세요");
  }

  if (centerX < 0.35) directions.push("화면 왼쪽으로");
  else if (centerX > 0.65) directions.push("화면 오른쪽으로");
  if (centerY < 0.35) directions.push("화면 위쪽으로");
  else if (centerY > 0.65) directions.push("화면 아래쪽으로");

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
      targetDirection = difference > 3 ? "오른쪽" : difference < -3 ? "왼쪽" : "직진";
    }
  }

  if (complete) {
    directions.push(sectorIndex === 0 ? "두 번째 경로로 전환하세요" : "이동 경로를 완료했습니다");
  } else if (targetDirection) {
    directions.push(targetDirection === "직진" ? "다음 표식까지 그대로 이동하세요" : `${targetDirection}으로 회전하세요`);
  }

  if (previousBounds && Math.abs(centerX - ((previousBounds.left + previousBounds.right) / 2)) > 0.08) {
    directions.push("화면 중앙 표식에 다시 맞추세요");
  }

  return {
    message: directions.length > 0 ? directions.join(" · ") : "화면 중앙 표식에 맞춘 채 표시된 방향으로 이동하세요.",
    aimPoint: { x: centerX, y: centerY },
    progress,
    targetDirection,
    complete,
  };
}
