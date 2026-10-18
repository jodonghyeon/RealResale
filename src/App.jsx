import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  getAdaptiveScanGuidance,
  getDetailCaptureGuidance,
  hasDetailCaptureFraming,
  recordHeadingCoverage,
  supportsDetailCaptureResolution,
} from "./scan-guidance.js";

const MIN_IMAGES = 24;
const MAX_IMAGES = 80;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 45;
const CAMERA_PASS_SECONDS = 45;
const MIN_SECTOR_COVERAGE = 9;
const MIN_RECORDING_SECONDS = 8;
const MIN_DETAIL_FRAMES = 20;
const MIN_DETAIL_VIDEO_SECONDS = 20;
const DETAIL_RECORDING_SECONDS = 30;
const MIN_DETAIL_RESOLUTION = 3840;
const DARKNESS_THRESHOLD = 48;
const BRIGHTNESS_RECOVERY_THRESHOLD = 72;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const FRAME_SAMPLE_SECONDS = 0.3;
const MAX_VIDEO_CANDIDATES = 120;
const MAX_FRAME_DIMENSION = 2560;
const scanSectors = [
  { id: "route-a", label: "전체 회전 1/2", target: "상단 표식" },
  { id: "route-b", label: "전체 회전 2/2", target: "하단 표식" },
];
const captureStages = [
  ...scanSectors,
  { id: "detail", label: "4K 근접 결함 촬영", target: "상품을 가까이" },
];
const money = new Intl.NumberFormat("ko-KR");
const Viewer = lazy(() => import("./Viewer.jsx"));

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("동영상 프레임을 읽는 데 시간이 너무 오래 걸려요."));
    }, 5000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("동영상 프레임을 읽을 수 없어요. 다른 동영상으로 다시 시도해 주세요."));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = time;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("영상 프레임을 이미지로 저장하지 못했어요."))),
      type,
      quality,
    );
  });
}

function analyzeFrame(video, analysisWidth = 320) {
  const width = analysisWidth;
  const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("이 브라우저에서는 동영상 프레임을 분석할 수 없어요.");
  context.drawImage(video, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let pixel = 0, offset = 0; pixel < gray.length; pixel += 1, offset += 4) {
    gray[pixel] = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
  }

  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      const laplacian =
        gray[pixel - width] +
        gray[pixel - 1] +
        gray[pixel + 1] +
        gray[pixel + width] -
        4 * gray[pixel];
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }

  const signature = [];
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const left = Math.floor((x * width) / 32);
      const top = Math.floor((y * height) / 24);
      const right = Math.max(left + 1, Math.floor(((x + 1) * width) / 32));
      const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / 24));
      let total = 0;
      let samples = 0;
      for (let sampleY = top; sampleY < Math.min(bottom, height); sampleY += 1) {
        for (let sampleX = left; sampleX < Math.min(right, width); sampleX += 1) {
          total += gray[sampleY * width + sampleX];
          samples += 1;
        }
      }
      signature.push(total / samples);
    }
  }

  return {
    sharpness: Math.max(0, sumSquares / count - (sum / count) ** 2),
    signature,
  };
}

function signaturesAreSimilar(left, right) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference / left.length < 3.5;
}

function ModelPreview({ src }) {
  return (
    <Suspense fallback={<div className="model-viewer viewer-loading">3D 모델을 불러오는 중…</div>}>
      <Viewer src={src} />
    </Suspense>
  );
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "요청을 처리하지 못했어요.");
  return body;
}

function App() {
  const [health, setHealth] = useState(null);
  const [listings, setListings] = useState([]);
  const [scans, setScans] = useState([]);
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("register");
  const [authOpen, setAuthOpen] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inbox, setInbox] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [messageInput, setMessageInput] = useState("");
  const [messageError, setMessageError] = useState("");
  const [page, setPage] = useState("market");
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [frames, setFrames] = useState([]);
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("디지털 · 카메라");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [previews, setPreviews] = useState({});
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [showCamera, setShowCamera] = useState(false);
  const [recording, setRecording] = useState(false);
  const [processingVideo, setProcessingVideo] = useState(false);
  const [frameReport, setFrameReport] = useState("");
  const [videoClips, setVideoClips] = useState([]);
  const [activeSectorIndex, setActiveSectorIndex] = useState(0);
  const [sectorProgress, setSectorProgress] = useState(0);
  const [brightness, setBrightness] = useState(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [orientationReady, setOrientationReady] = useState(false);
  const [segmenterReady, setSegmenterReady] = useState(false);
  const [objectSelection, setObjectSelection] = useState(null);
  const [objectBounds, setObjectBounds] = useState(null);
  const [targetDirection, setTargetDirection] = useState("직진");
  const [cameraGuide, setCameraGuide] = useState("실시간 카메라를 열고 상품을 한 번 선택하세요.");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const recordingChunks = useRef([]);
  const framesRef = useRef([]);
  const recordingTimeout = useRef(null);
  const notified = useRef(new Set());
  const workerRef = useRef(null);
  const selectionRef = useRef(null);
  const previousBoundsRef = useRef(null);
  const orientationRef = useRef(null);
  const startingHeadingRef = useRef(null);
  const sectorCoverageRef = useRef(Array(24).fill(false));
  const activeSectorIndexRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const cancelledRecordingRef = useRef(false);
  const torchEnabledRef = useRef(false);
  const torchSupportedRef = useRef(false);
  const torchUpdateRef = useRef(false);
  const segmentationBusy = useRef(false);
  const videoClipsRef = useRef([]);

  useEffect(() => {
    const urls = Object.fromEntries(
      frames.map((frame) => [
        `${frame.file.name}:${frame.file.size}:${frame.file.lastModified}`,
        URL.createObjectURL(frame.preview),
      ]),
    );
    setPreviews(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [frames]);

  const files = frames.map((frame) => frame.file);
  const activeCaptureStage = captureStages[activeSectorIndex] || null;
  const cameraSettings = streamRef.current?.getVideoTracks()[0]?.getSettings?.();
  const detailCaptureReady = activeCaptureStage?.id !== "detail" || (
    supportsDetailCaptureResolution(cameraSettings?.width, cameraSettings?.height) &&
    hasDetailCaptureFraming(objectBounds)
  );

  const clearFrames = () => {
    framesRef.current = [];
    setFrames([]);
    videoClipsRef.current = [];
    setVideoClips([]);
    setActiveSectorIndex(0);
    activeSectorIndexRef.current = 0;
    sectorCoverageRef.current = Array(24).fill(false);
    setSectorProgress(0);
    setBrightness(null);
    setFrameReport("");
  };

  const removeFrame = (frameIndex) => {
    const updated = framesRef.current.filter((_, index) => index !== frameIndex);
    framesRef.current = updated;
    setFrames(updated);
  };

  useEffect(() => {
    if (showCamera && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [showCamera]);

  useEffect(() => {
    if (!showCamera) return undefined;
    const updateOrientation = (event) => {
      if (Number.isFinite(event.alpha)) {
        orientationRef.current = {
          alpha: event.alpha,
          beta: Number.isFinite(event.beta) ? event.beta : 0,
          gamma: Number.isFinite(event.gamma) ? event.gamma : 0,
        };
        setOrientationReady(true);
      }
    };
    window.addEventListener("deviceorientation", updateOrientation);
    return () => window.removeEventListener("deviceorientation", updateOrientation);
  }, [showCamera]);

  useEffect(() => {
    if (!showCamera) return undefined;
    const worker = new Worker(new URL("./segmenter.worker.js", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.addEventListener("message", (event) => {
      if (event.data.type === "ready") {
        setSegmenterReady(true);
        setCameraGuide("상품을 한 번 선택하면 이동 경로가 시작됩니다.");
      } else if (event.data.type === "result") {
        segmentationBusy.current = false;
        const bounds = event.data.bounds;
        const brightnessLevel = event.data.brightness;
        setObjectBounds(bounds);
        setBrightness(brightnessLevel);
        const cameraTrack = streamRef.current?.getVideoTracks()[0];
        if (
          cameraTrack &&
          Number.isFinite(brightnessLevel) &&
          brightnessLevel < DARKNESS_THRESHOLD &&
          !torchSupportedRef.current
        ) {
          setCameraError("이 브라우저는 카메라 플래시 제어를 지원하지 않아요. 주변 조명을 켜고 다시 확인해 주세요.");
          setCameraGuide("조명이 부족합니다. 주변 조명을 켜면 촬영할 수 있어요.");
        }
        if (
          cameraTrack &&
          torchSupportedRef.current &&
          Number.isFinite(brightnessLevel) &&
          !torchUpdateRef.current &&
          ((brightnessLevel < DARKNESS_THRESHOLD && !torchEnabledRef.current) ||
            (brightnessLevel > BRIGHTNESS_RECOVERY_THRESHOLD && torchEnabledRef.current))
        ) {
          const enableTorch = brightnessLevel < DARKNESS_THRESHOLD;
          torchUpdateRef.current = true;
          cameraTrack.applyConstraints({ advanced: [{ torch: enableTorch }] })
            .then(() => {
              torchEnabledRef.current = enableTorch;
              setTorchEnabled(enableTorch);
              if (enableTorch) setCameraGuide("어두운 환경을 감지해 플래시를 켰습니다. 밝기를 다시 확인하고 있어요.");
            })
            .catch((error) => {
              setCameraError(
                error instanceof Error
                  ? `필수 플래시를 제어할 수 없어 촬영을 멈췄어요: ${error.message}`
                  : "필수 플래시를 사용할 수 없어 촬영을 멈췄어요.",
              );
              if (recorderRef.current?.state === "recording") {
                cancelledRecordingRef.current = true;
                recorderRef.current.stop();
              }
            })
            .finally(() => {
              torchUpdateRef.current = false;
            });
        }
        if (bounds) {
          const orientation = orientationRef.current;
          const recorder = recorderRef.current;
          const activeStage = captureStages[activeSectorIndexRef.current];
          const detailPass = activeStage?.id === "detail";
          if (detailPass && recorder?.state === "recording") {
            const elapsedSeconds = (Date.now() - recordingStartedAtRef.current) / 1000;
            setSectorProgress(Math.min(100, Math.round((elapsedSeconds / DETAIL_RECORDING_SECONDS) * 100)));
            if (elapsedSeconds >= DETAIL_RECORDING_SECONDS) recorder.stop();
          } else if (
            !detailPass &&
            recorder?.state === "recording" &&
            orientation &&
            Number.isFinite(startingHeadingRef.current)
          ) {
            const sectorIndex = activeSectorIndexRef.current;
            sectorCoverageRef.current = recordHeadingCoverage(
              sectorCoverageRef.current,
              orientation.alpha,
              startingHeadingRef.current,
            );
            const covered = sectorCoverageRef.current
              .slice(sectorIndex * 12, sectorIndex * 12 + 12)
              .filter(Boolean).length;
            setSectorProgress(Math.round((covered / 12) * 100));
            const elapsedSeconds = (Date.now() - recordingStartedAtRef.current) / 1000;
            if (covered >= MIN_SECTOR_COVERAGE && elapsedSeconds >= MIN_RECORDING_SECONDS) {
              recorder.stop();
            }
          }
          const point = {
            x: (bounds.left + bounds.right) / 2,
            y: (bounds.top + bounds.bottom) / 2,
          };
          selectionRef.current = point;
          setObjectSelection(point);
          if (detailPass) {
            setTargetDirection("직진");
            const detailGuidance = getDetailCaptureGuidance(bounds);
            if (brightnessLevel < DARKNESS_THRESHOLD && !torchEnabledRef.current) {
              setCameraGuide("근접 촬영에는 밝은 조명이 필요해요. 조명을 켜고 다시 확인하세요.");
            } else if (recorder?.state === "recording") {
              setCameraGuide(detailGuidance);
            } else {
              setCameraGuide(detailGuidance);
            }
          } else {
            const guidance = getAdaptiveScanGuidance({
              bounds,
              previousBounds: previousBoundsRef.current,
              heading: orientation?.alpha,
              startingHeading: startingHeadingRef.current,
              sectorIndex: activeSectorIndexRef.current,
              coverage: sectorCoverageRef.current,
            });
            setTargetDirection(guidance.targetDirection || "직진");
            if (!cameraReady) {
              setCameraGuide("화면 중앙의 표식에 상품 중심을 맞추고 경로 촬영을 시작하세요.");
            } else if (
              brightnessLevel < DARKNESS_THRESHOLD &&
              !torchEnabledRef.current &&
              torchSupportedRef.current
            ) {
              setCameraGuide("플래시를 켜는 중입니다. 밝기 확인이 끝날 때까지 기다리세요.");
            } else if (brightnessLevel < DARKNESS_THRESHOLD && !torchEnabledRef.current) {
              setCameraGuide("조명이 부족합니다. 주변 조명을 켜면 촬영할 수 있어요.");
            } else if (!recorder || recorder.state !== "recording") {
              setCameraGuide(guidance.complete ? "이 경로를 촬영했습니다. 다음 이동 경로로 이어가세요." : "화면 중앙 표식에 상품을 맞춘 뒤 회전 촬영을 시작하세요.");
            } else {
              setCameraGuide(guidance.message);
            }
          }
          previousBoundsRef.current = bounds;
        } else {
          setTargetDirection("직진");
          setCameraGuide("상품이 화면에서 벗어났습니다. 다시 화면 안에 맞추세요.");
        }
      } else if (event.data.type === "error") {
        segmentationBusy.current = false;
        setCameraGuide(`온디바이스 상품 분할 오류: ${event.data.message}`);
      }
    });
    worker.addEventListener("error", (event) => {
      segmentationBusy.current = false;
      setCameraGuide(`온디바이스 상품 분할기를 시작하지 못했어요: ${event.message}`);
    });
    worker.postMessage({ type: "initialize" });
    return () => {
      worker.terminate();
      workerRef.current = null;
      segmentationBusy.current = false;
      selectionRef.current = null;
      previousBoundsRef.current = null;
      setSegmenterReady(false);
      setObjectBounds(null);
      setObjectSelection(null);
      setTargetDirection("직진");
    };
  }, [cameraReady, showCamera]);

  useEffect(() => {
    if (!showCamera || !segmenterReady || !objectSelection) return undefined;
    let active = true;
    let timer;
    const sampleCamera = async () => {
      const video = videoRef.current;
      if (active && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !segmentationBusy.current) {
        segmentationBusy.current = true;
        try {
          const bitmap = await createImageBitmap(video);
          if (active && workerRef.current) {
            workerRef.current.postMessage(
              { type: "segment", bitmap, point: selectionRef.current },
              [bitmap],
            );
          } else {
            bitmap.close();
            segmentationBusy.current = false;
          }
        } catch (error) {
          segmentationBusy.current = false;
          setCameraGuide(error instanceof Error ? error.message : "카메라 프레임을 분석하지 못했어요.");
        }
      }
      if (active) timer = window.setTimeout(sampleCamera, 1200);
    };
    timer = window.setTimeout(sampleCamera, 100);
    return () => {
      active = false;
      window.clearTimeout(timer);
      segmentationBusy.current = false;
    };
  }, [showCamera, segmenterReady, objectSelection]);

  const selectProductInPreview = (event) => {
    const video = videoRef.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!video?.videoWidth || !video.videoHeight || !bounds.width || !bounds.height) return;
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const imageWidth = video.videoWidth * scale;
    const imageHeight = video.videoHeight * scale;
    const offsetX = (bounds.width - imageWidth) / 2;
    const offsetY = (bounds.height - imageHeight) / 2;
    const x = (event.clientX - bounds.left - offsetX) / imageWidth;
    const y = (event.clientY - bounds.top - offsetY) / imageHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    selectionRef.current = { x, y };
    setObjectSelection({ x, y });
    setObjectBounds(null);
    setCameraGuide(segmenterReady ? "선택한 상품의 윤곽을 찾고 있어요." : "기기 내 상품 분할 모델을 불러오고 있어요.");
  };

  const submitAuthentication = async (event) => {
    event.preventDefault();
    setAuthError("");
    try {
      const result = await request(`/api/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: usernameInput, password: passwordInput }),
      });
      setUser(result.user);
      setPasswordInput("");
      setAuthOpen(false);
      setMessage(`안녕하세요, ${result.user.username}님.`);
      await refresh();
    } catch (error) {
      setAuthError(error.message);
    }
  };

  const logout = async () => {
    try {
      await request("/api/auth/logout", { method: "POST" });
      setUser(null);
      setInbox([]);
      setActiveConversation(null);
      setChatMessages([]);
      setInboxOpen(false);
      setPage("market");
      await refresh();
      setMessage("로그아웃했습니다.");
    } catch (error) {
      setAuthError(error.message);
    }
  };

  const openInbox = async () => {
    if (!user) {
      setAuthMode("login");
      setAuthError("");
      setAuthOpen(true);
      return;
    }
    setMessageError("");
    try {
      const result = await request("/api/conversations");
      setInbox(result.conversations);
      setInboxOpen(true);
    } catch (error) {
      setMessageError(error.message);
    }
  };

  const openListingConversation = async (listing) => {
    if (!user) {
      setAuthMode("login");
      setAuthError("");
      setAuthOpen(true);
      return;
    }
    setMessageError("");
    try {
      const result = await request(`/api/listings/${listing.id}/conversations`, { method: "POST" });
      setSelected(listing);
      setInboxOpen(false);
      setActiveConversation(result.conversation);
      setMessageInput("");
      const history = await request(`/api/conversations/${result.conversation.id}/messages`);
      setChatMessages(history.messages);
    } catch (error) {
      setMessageError(error.message);
    }
  };

  const openConversationFromInbox = async (conversation) => {
    setMessageError("");
    setMessageInput("");
    setActiveConversation(conversation);
    try {
      const result = await request(`/api/conversations/${conversation.id}/messages`);
      setChatMessages(result.messages);
    } catch (error) {
      setMessageError(error.message);
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!activeConversation || !messageInput.trim()) return;
    setMessageError("");
    try {
      const result = await request(`/api/conversations/${activeConversation.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: messageInput }),
      });
      setChatMessages((current) => [...current, result.message]);
      setMessageInput("");
    } catch (error) {
      setMessageError(error.message);
    }
  };

  const refresh = useCallback(async () => {
    const [status, listingData, scanData, session] = await Promise.all([
      request("/api/health"),
      request("/api/listings"),
      request("/api/scans"),
      request("/api/auth/me"),
    ]);
    setHealth(status);
    setListings(listingData.listings);
    setScans(scanData.scans);
    setUser(session.user);
    if (draft?.id) {
      const updatedDraft = scanData.scans.find((scan) => scan.id === draft.id);
      if (updatedDraft) setDraft(updatedDraft);
    }
    for (const scan of scanData.scans) {
      if (
        (scan.status === "ready" || scan.status === "failed") &&
        !notified.current.has(scan.id)
      ) {
        notified.current.add(scan.id);
        if (draft?.id === scan.id) {
          setMessage(
            scan.status === "ready"
              ? "실제 3D 재구성이 완료됐어요. 상품 정보를 작성해 보세요."
              : "재구성에 실패했어요. 촬영 영상을 확인하고 새 스캔을 시작해 주세요.",
          );
        }
      }
    }
  }, [draft?.id]);

  useEffect(() => {
    if (!activeConversation?.id) return undefined;
    let active = true;
    const refreshMessages = () => {
      request(`/api/conversations/${activeConversation.id}/messages`)
        .then((result) => {
          if (active) setChatMessages(result.messages);
        })
        .catch((error) => {
          if (active) setMessageError(error.message);
        });
    };
    const interval = window.setInterval(refreshMessages, 4000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeConversation?.id]);

  useEffect(() => {
    if (!inboxOpen || !user) return undefined;
    let active = true;
    const refreshInbox = () => {
      request("/api/conversations")
        .then((result) => {
          if (active) setInbox(result.conversations);
        })
        .catch((error) => {
          if (active) setMessageError(error.message);
        });
    };
    const interval = window.setInterval(refreshInbox, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [inboxOpen, user?.id]);

  useEffect(() => {
    refresh().catch((error) => setFormError(error.message));
    const interval = window.setInterval(() => {
      refresh().catch((error) => setFormError(error.message));
    }, 3500);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(
    () => () => {
      if (recordingTimeout.current) window.clearTimeout(recordingTimeout.current);
      if (recorderRef.current?.state === "recording") {
        cancelledRecordingRef.current = true;
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const openScanner = () => {
    if (!user) {
      setAuthMode("register");
      setAuthError("");
      setAuthOpen(true);
      return;
    }
    stopCamera();
    setPage("scan");
    const resumable = scans.find(
      (scan) => !scan.listed && ["queued", "processing", "ready"].includes(scan.status),
    );
    setDraft(resumable?.status === "queued" || resumable?.status === "processing" || resumable?.status === "ready"
      ? resumable
      : null);
    clearFrames();
    setMessage(resumable?.status === "ready"
      ? "등록하지 않은 기존 스캔을 불러왔어요. 상품 정보를 이어서 작성해 주세요."
      : resumable
        ? "진행 중이던 스캔을 불러왔어요."
        : "");
    setFormError("");
    setTitle(resumable?.title || "");
    setPrice(resumable?.price ? String(resumable.price) : "");
    setCategory(resumable?.category || "디지털 · 카메라");
    setDescription(resumable?.description || "");
  };

  const processVideoClip = async (clip, sectorId) => {
    const detailPass = sectorId === "detail";
    if (!detailPass && framesRef.current.length >= MAX_IMAGES) {
      setFormError(`선별 프레임은 최대 ${MAX_IMAGES}장까지 사용할 수 있어요.`);
      return;
    }
    setProcessingVideo(true);
    setCameraError("");
    setFormError("");
    setFrameReport(detailPass
      ? "4K 근접 영상에서 초점이 선명한 결함 확인 프레임을 검사하고 있어요."
      : "촬영한 경로에서 선명하고 서로 다른 시점을 선별하고 있어요.");

    const videoUrl = URL.createObjectURL(clip);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = videoUrl;

    try {
      await new Promise((resolve, reject) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener("error", () => reject(new Error("촬영 영상을 읽지 못했어요. 카메라 경로를 다시 촬영하세요.")), { once: true });
        video.load();
      });
      const minimumDuration = detailPass ? MIN_DETAIL_VIDEO_SECONDS : MIN_RECORDING_SECONDS;
      const maximumDuration = detailPass ? DETAIL_RECORDING_SECONDS : MAX_VIDEO_SECONDS;
      if (!Number.isFinite(video.duration) || video.duration < minimumDuration) {
        throw new Error(detailPass
          ? `근접 세부 촬영은 선명한 프레임을 확보하도록 ${MIN_DETAIL_VIDEO_SECONDS}초 이상 기록해야 해요.`
          : "이동 경로가 충분히 기록되지 않았어요. 같은 경로를 다시 촬영하세요.");
      }
      if (video.duration > maximumDuration + 1) {
        throw new Error(`촬영 영상은 ${maximumDuration}초 이하여야 해요.`);
      }
      if (!video.videoWidth || !video.videoHeight) {
        throw new Error("동영상에 읽을 수 있는 화면이 없어요.");
      }
      if (detailPass && !supportsDetailCaptureResolution(video.videoWidth, video.videoHeight)) {
        throw new Error(`근접 결함 촬영이 ${MIN_DETAIL_RESOLUTION}px 미만으로 기록됐어요. 기기에서 4K 촬영을 지원하는지 확인한 뒤 다시 촬영하세요.`);
      }

      const interval = Math.max(detailPass ? 0.5 : FRAME_SAMPLE_SECONDS, video.duration / MAX_VIDEO_CANDIDATES);
      const candidates = [];
      for (let time = Math.min(0.15, video.duration / 4); time < video.duration - 0.08; time += interval) {
        await seekVideo(video, time);
        candidates.push({ time, ...analyzeFrame(video, detailPass ? 960 : 320) });
      }
      if (candidates.length === 0) {
        throw new Error("동영상에서 프레임을 추출하지 못했어요. 조금 더 길게 촬영해 주세요.");
      }

      const sharpnessValues = candidates.map((candidate) => candidate.sharpness).sort((left, right) => left - right);
      const lowerQuartile = sharpnessValues[Math.floor((sharpnessValues.length - 1) * 0.2)];
      const minimumSharpness = Math.max(8, lowerQuartile * 0.35);
      const existingSignatures = detailPass ? [] : framesRef.current.map((frame) => frame.signature);
      const selected = [];
      let blurryCount = 0;
      let duplicateCount = 0;
      for (const candidate of candidates) {
        if (candidate.sharpness < minimumSharpness) {
          blurryCount += 1;
          continue;
        }
        if (
          [...existingSignatures, ...selected.map((frame) => frame.signature)]
            .some((signature) => signaturesAreSimilar(signature, candidate.signature))
        ) {
          duplicateCount += 1;
          continue;
        }
        if (detailPass ? selected.length >= MIN_DETAIL_FRAMES * 2 : framesRef.current.length + selected.length >= MAX_IMAGES) break;
        selected.push(candidate);
      }

      if (detailPass) {
        if (selected.length < MIN_DETAIL_FRAMES) {
          throw new Error(`초점이 선명하고 서로 다른 근접 프레임이 ${MIN_DETAIL_FRAMES}장 미만이에요. 조명을 밝히고 물건을 더 천천히 돌려 다시 촬영하세요.`);
        }
        const currentBytes = videoClipsRef.current.reduce((total, savedClip) => total + savedClip.file.size, clip.size);
        if (currentBytes > MAX_VIDEO_BYTES) {
          throw new Error("전체 촬영 영상의 합계가 512MB를 넘어요.");
        }
        const extension = clip.type.includes("mp4") ? "mp4" : "webm";
        const videoFile = new File([clip], `${sectorId}.${extension}`, { type: clip.type || "video/webm" });
        videoClipsRef.current = [
          ...videoClipsRef.current.filter((video) => video.sector !== sectorId),
          { sector: sectorId, file: videoFile },
        ];
        setVideoClips(videoClipsRef.current);
        setActiveSectorIndex(captureStages.length);
        activeSectorIndexRef.current = captureStages.length;
        setSectorProgress(100);
        setFrameReport(`${selected.length}개의 선명한 4K 근접 프레임을 확인했어요. 서버가 초점과 원본 해상도를 다시 검사합니다.`);
        return;
      }

      const extracted = [];
      for (const candidate of selected) {
        await seekVideo(video, candidate.time);
        const scale = Math.min(1, MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        const imageCanvas = document.createElement("canvas");
        imageCanvas.width = width;
        imageCanvas.height = height;
        const imageContext = imageCanvas.getContext("2d");
        if (!imageContext) throw new Error("동영상 프레임을 이미지로 변환할 수 없어요.");
        imageContext.drawImage(video, 0, 0, width, height);
        const imageBlob = await canvasToBlob(imageCanvas, "image/jpeg", 0.94);
        if (imageBlob.size > MAX_IMAGE_BYTES) {
          throw new Error("추출된 사진이 20MB를 넘었어요. 더 낮은 해상도로 동영상을 촬영해 주세요.");
        }
        const previewCanvas = document.createElement("canvas");
        const previewScale = Math.min(1, 512 / Math.max(width, height));
        previewCanvas.width = Math.max(1, Math.round(width * previewScale));
        previewCanvas.height = Math.max(1, Math.round(height * previewScale));
        const previewContext = previewCanvas.getContext("2d");
        if (!previewContext) throw new Error("프레임 미리보기를 만들 수 없어요.");
        previewContext.drawImage(imageCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
        const preview = await canvasToBlob(previewCanvas, "image/jpeg", 0.8);
        const file = new File(
          [imageBlob],
          `realresale-frame-${Date.now()}-${extracted.length + 1}.jpg`,
          { type: "image/jpeg", lastModified: Date.now() },
        );
        extracted.push({
          file,
          preview,
          signature: candidate.signature,
          sharpness: Math.round(candidate.sharpness),
          time: candidate.time,
        });
      }

      const currentBytes = framesRef.current.reduce((total, frame) => total + frame.file.size, 0);
      const nextBytes = extracted.reduce((total, frame) => total + frame.file.size, 0);
      if (currentBytes + nextBytes > MAX_SCAN_BYTES) {
        throw new Error("선별된 프레임의 전체 용량이 512MB를 넘어요.");
      }
      if (videoClipsRef.current.reduce((total, savedClip) => total + savedClip.file.size, clip.size) > MAX_VIDEO_BYTES) {
        throw new Error("두 경로 원본 영상의 합계가 512MB를 넘어요.");
      }
      if (extracted.length < MIN_IMAGES / scanSectors.length) {
        throw new Error("이동 경로에서 선명하고 겹치는 프레임이 충분히 확보되지 않았어요. 표시되는 방향을 따라 다시 촬영하세요.");
      }
      framesRef.current = [...framesRef.current, ...extracted];
      setFrames(framesRef.current);
      const extension = clip.type.includes("mp4") ? "mp4" : "webm";
      const videoFile = new File([clip], `${sectorId}.${extension}`, { type: clip.type || "video/webm" });
      videoClipsRef.current = [
        ...videoClipsRef.current.filter((video) => video.sector !== sectorId),
        { sector: sectorId, file: videoFile },
      ];
      setVideoClips(videoClipsRef.current);
      const nextSectorIndex = sectorId === "route-a" ? 1 : 2;
      setActiveSectorIndex(nextSectorIndex);
      activeSectorIndexRef.current = nextSectorIndex;
      setFrameReport(
        `${extracted.length}장 선택 · 흐린 프레임 ${blurryCount}장, 중복 시점 ${duplicateCount}장 제외`,
      );
      if (framesRef.current.length < MIN_IMAGES) {
        setFrameReport(`${framesRef.current.length}/${MIN_IMAGES}장 선별됨 · 두 번째 이동 경로를 마치면 다시 확인합니다.`);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "동영상 프레임을 분석하지 못했어요.");
      setFrameReport("");
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(videoUrl);
      setProcessingVideo(false);
    }
  };

  const startCamera = async () => {
    setCameraError("");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("실시간 촬영에는 기기가 신뢰하는 HTTPS 주소가 필요합니다.");
      }
      if (!("DeviceOrientationEvent" in window)) {
        throw new Error("이동 경로 안내를 위해 기기의 방향 센서가 필요합니다.");
      }
      const orientationEvent = window.DeviceOrientationEvent;
      if (typeof orientationEvent.requestPermission === "function") {
        const permission = await orientationEvent.requestPermission();
        if (permission !== "granted") throw new Error("카메라 이동 방향 안내를 위해 기기 방향 권한을 허용해야 합니다.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      });
      const cameraTrack = stream.getVideoTracks()[0];
      const capabilities = cameraTrack?.getCapabilities?.();
      const canControlTorch = capabilities?.torch === true && typeof cameraTrack.applyConstraints === "function";
      if (canControlTorch) {
        try {
          await cameraTrack.applyConstraints({ advanced: [{ torch: false }] });
        } catch (error) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error(`카메라 플래시 권한을 확인하지 못했습니다: ${error.message}`);
        }
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      torchSupportedRef.current = canControlTorch;
      setTorchSupported(canControlTorch);
      torchEnabledRef.current = false;
      setTorchEnabled(false);
      setCameraReady(true);
      orientationRef.current = null;
      setOrientationReady(false);
      setBrightness(null);
      setCameraError("");
      setShowCamera(true);
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "카메라·방향 센서·플래시 권한이 필요합니다.");
    }
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === "undefined" || !orientationRef.current) {
      setCameraError("방향 센서와 실시간 동영상 촬영을 준비하지 못했습니다.");
      return;
    }
    if (!objectBounds || brightness === null || brightness < DARKNESS_THRESHOLD || torchUpdateRef.current) {
      setCameraError("플래시와 밝기 확인이 끝난 뒤 이동 경로 촬영을 시작할 수 있습니다.");
      return;
    }
    const sector = captureStages[activeSectorIndexRef.current];
    if (!sector) return;
    const detailPass = sector.id === "detail";
    if (detailPass) {
      const settings = stream.getVideoTracks()[0]?.getSettings?.();
      if (!supportsDetailCaptureResolution(settings?.width, settings?.height)) {
        setCameraError(`미세 결함을 기록하려면 카메라가 4K (${MIN_DETAIL_RESOLUTION}px 이상)로 촬영해야 합니다. 기기의 카메라 해상도 설정을 확인하세요.`);
        return;
      }
      if (!hasDetailCaptureFraming(objectBounds)) {
        setCameraError("화면에서 상품이 잘리지 않으면서 화면의 55~88%를 차지하도록 가까이 맞춰 주세요.");
        return;
      }
    }
    try {
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordingChunks.current = [];
      if (!detailPass && (sector.id === "route-a" || !Number.isFinite(startingHeadingRef.current))) {
        startingHeadingRef.current = orientationRef.current.alpha;
      }
      if (!detailPass) {
        sectorCoverageRef.current = recordHeadingCoverage(
          sector.id === "route-a" ? Array(24).fill(false) : sectorCoverageRef.current,
          orientationRef.current.alpha,
          startingHeadingRef.current,
        );
      }
      setSectorProgress(0);
      cancelledRecordingRef.current = false;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) recordingChunks.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const clip = new Blob(recordingChunks.current, { type: recorder.mimeType || "video/webm" });
        recordingChunks.current = [];
        recorderRef.current = null;
        setRecording(false);
        const covered = detailPass
          ? MIN_SECTOR_COVERAGE
          : sectorCoverageRef.current
            .slice(activeSectorIndexRef.current * 12, activeSectorIndexRef.current * 12 + 12)
            .filter(Boolean).length;
        if (cancelledRecordingRef.current) {
          setCameraGuide("이 경로 촬영을 취소했습니다.");
        } else if (clip.size === 0) {
          setFormError("촬영된 동영상이 비어 있습니다.");
        } else if (covered < MIN_SECTOR_COVERAGE) {
          setFormError("경로가 충분히 이동하지 않아 영상을 저장하지 않았습니다. 화면의 회전 표식을 따라 다시 진행하세요.");
        } else {
          void processVideoClip(clip, sector.id);
        }
      }, { once: true });
      recorder.start(1000);
      recorderRef.current = recorder;
      recordingStartedAtRef.current = Date.now();
      setCameraError("");
      setRecording(true);
      recordingTimeout.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, (detailPass ? DETAIL_RECORDING_SECONDS : CAMERA_PASS_SECONDS) * 1000);
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "동영상 촬영을 시작하지 못했어요.");
    }
  };

  const stopRecording = () => {
    if (recordingTimeout.current) window.clearTimeout(recordingTimeout.current);
    recordingTimeout.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const stopCamera = () => {
    cancelledRecordingRef.current = true;
    stopRecording();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    torchEnabledRef.current = false;
    torchSupportedRef.current = false;
    setTorchSupported(false);
    setTorchEnabled(false);
    setCameraReady(false);
    setOrientationReady(false);
    orientationRef.current = null;
    setShowCamera(false);
    setObjectBounds(null);
    setObjectSelection(null);
    setCameraGuide("실시간 카메라를 열고 상품을 다시 선택하세요.");
  };

  useEffect(() => {
    if (page !== "scan" && streamRef.current) {
      stopCamera();
    }
  }, [page]);

  const startScan = async (event) => {
    event.preventDefault();
    setFormError("");
    setMessage("");
    if (activeSectorIndexRef.current < captureStages.length || videoClipsRef.current.length !== captureStages.length) {
      setFormError("두 전체 경로와 필수 4K 근접 결함 촬영을 모두 완료해야 스캔을 시작할 수 있어요.");
      return;
    }
    if (!title.trim() || !price || !Number.isSafeInteger(Number(price)) || Number(price) < 0) {
      setFormError("촬영을 시작하기 전에 상품명과 가격을 입력해 주세요.");
      return;
    }
    if (files.length < MIN_IMAGES) {
      setFormError(`최소 ${MIN_IMAGES}장의 여러 각도 사진이 필요해요. 현재 ${files.length}장입니다.`);
      return;
    }
    setBusy(true);
    const form = new FormData();
    videoClipsRef.current.forEach(({ sector, file }) => {
      form.append("videos", file, `${sector}.${file.name.split(".").at(-1)}`);
    });
    form.append("title", title.trim());
    form.append("description", description);
    form.append("category", category);
    form.append("price", String(Number(price)));
    try {
      const result = await request("/api/scans/videos", { method: "POST", body: form });
      setDraft(result.scan);
      notified.current.delete(result.scan.id);
      setMessage("전체 촬영과 4K 근접 원본을 저장했어요. 서버가 재구성 프레임과 결함 확인 이미지를 검사합니다.");
      refresh().catch(() => {});
    } catch (error) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const saveDraftDetails = async () => {
    if (!draft) return;
    setFormError("");
    setBusy(true);
    try {
      const result = await request(`/api/scans/${draft.id}/details`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          category,
          price: Number(price),
        }),
      });
      setDraft(result.scan);
      setMessage("상품 설명과 가격을 저장했어요.");
    } catch (error) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async (event) => {
    event.preventDefault();
    setFormError("");
    if (!draft || draft.status !== "ready") {
      setFormError("플랫폼에서 실제 재구성을 완료한 스캔이 있어야 등록할 수 있어요.");
      return;
    }
    setBusy(true);
    try {
      await request(`/api/scans/${draft.id}/details`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          category,
          price: Number(price),
        }),
      });
      await request("/api/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          category,
          price: Number(price),
          scanId: draft.id,
        }),
      });
      await refresh();
      setPage("market");
      setDraft(null);
      clearFrames();
      setMessage("재구성된 3D 모델과 함께 매물이 등록됐어요.");
    } catch (error) {
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const modelSrc = (scan) => `/media/scans/${scan.id}/model.ply`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setPage("market")} aria-label="RealResale 홈">
          <span className="brand-mark">R<span>.</span></span>
          <span className="brand-copy">REAL<span>RESALE</span></span>
        </button>
        <div className="topbar-right">
          <span className={`engine-chip ${health?.reconstructionAvailable ? "online" : "offline"}`}>
            <span className="status-dot" />
            {health?.reconstructionAvailable ? "3D 엔진 연결됨" : "3D 엔진 확인 필요"}
          </span>
          <button className="button button-primary header-cta" onClick={openScanner}>
            <span aria-hidden="true">＋</span> 직접 스캔하기
          </button>
          <button className="button button-outline account-action" onClick={() => void openInbox()}>메시지</button>
          {user ? <><span className="account-name">{user.username}</span><button className="text-button" onClick={() => void logout()}>로그아웃</button></> : <button className="text-button" onClick={() => { setAuthMode("login"); setAuthError(""); setAuthOpen(true); }}>로그인</button>}
        </div>
      </header>

      <main>
        {page === "market" && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <div className="eyebrow"><span className="eyebrow-dot" /> REAL RESALE, REAL DETAIL</div>
                <h1>중고 거래,<br />이제 <span>직접 돌려보고</span> 고르세요.</h1>
                <p>실물 사진만 보고 결정하지 마세요.<br className="desktop-break" /> 색상 3D 모델과 판매자가 제공한 촬영 원본을 직접 확인하세요.</p>
                <button className="button button-dark hero-button" onClick={openScanner}>
                  내 물건 스캔 시작하기 <span aria-hidden="true">↗</span>
                </button>
                <div className="hero-proof">
                  <span className="proof-icon">◎</span> 플랫폼에서 재구성한 3D만 등록 가능
                </div>
              </div>
              <div className="hero-art" aria-label="실제 매물의 3D 스캔을 보여주는 안내 일러스트">
                <div className="hero-orbit orbit-one" />
                <div className="hero-orbit orbit-two" />
                <div className="hero-scan-card">
                  <div className="scan-card-top"><span>MODEL PREVIEW</span><span>↗</span></div>
                  <div className="phone-model" aria-hidden="true">
                    <div className="phone-side" />
                    <div className="phone-back">
                      <span className="camera-stack"><i /><i /><i /></span>
                      <span className="phone-logo">PHONE</span>
                      <span className="scratch-mark">⌁</span>
                    </div>
                  </div>
                  <div className="scan-card-bottom"><span>각도를 바꿔 직접 확인</span><span className="scan-arrows">⤺</span></div>
                </div>
                <div className="floating-chip"><span className="floating-dot" /> 3D SCANNED</div>
                <span className="art-label">01 / 360° VIEW</span>
              </div>
              <span className="hero-watermark" aria-hidden="true">R</span>
            </section>

            <section className="market-section">
              <div className="section-heading">
                <div><div className="eyebrow section-eyebrow">THE MARKETPLACE</div><h2>살펴보고, 마음에 들면.</h2></div>
                <span className="listing-count">{listings.length.toString().padStart(2, "0")}개의 상품</span>
              </div>
              {listings.length === 0 ? (
                <div className="empty-market">
                  <div className="empty-icon">◇</div>
                  <h3>첫 번째 3D 매물을 만들어 보세요.</h3>
                  <p>상품 동영상으로 3D 스캔을 완료하면 이곳에 공개돼요.</p>
                  <button className="button button-outline" onClick={openScanner}>첫 매물 스캔하기 <span>↗</span></button>
                </div>
              ) : (
                <div className="listing-grid">
                  {listings.map((listing) => (
                    <article className="listing-card" key={listing.id}>
                      <button className="listing-open" onClick={() => setSelected(listing)} aria-label={`${listing.title} 상세 보기`}>
                      <div className="listing-model"><ModelPreview src={modelSrc(listing.scan)} /><span className="model-tag"><span>◉</span> 3D VIEW</span></div>
                      <div className="listing-meta"><span>{listing.category}</span><span>{listing.scan.imageCount}장 스캔</span></div>
                      <h3>{listing.title}</h3>
                      <p className="listing-description">{listing.description || "상품 설명이 없습니다."}</p>
                      <div className="listing-price">{money.format(listing.price)}<span>원</span><span className="card-arrow">↗</span></div>
                      </button>
                      <div className="listing-seller">판매자 · {listing.seller?.username || "기존 판매자"}</div>
                      <button className="listing-message" onClick={() => void openListingConversation(listing)} disabled={!listing.seller || listing.seller.id === user?.id}>판매자에게 메시지 보내기 ↗</button>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="trust-strip">
              <span className="trust-seal">R</span>
              <p>판매자는 전체 회전 두 경로와 4K 근접 촬영을 완료합니다. <strong>구매자는 3D 모델과 고해상도 표면 사진, 원본 영상을 확인하고 판매자에게 비공개 메시지를 보낼 수 있습니다.</strong></p>
              <button onClick={openScanner}>촬영 가이드 보기 <span>↗</span></button>
            </section>
          </>
        )}

        {page === "scan" && (
          <section className="scan-page">
            <button className="back-link" onClick={() => setPage("market")}>← 마켓플레이스로 돌아가기</button>
            <div className="scan-header">
              <div className="eyebrow"><span className="eyebrow-dot" /> SELLER SCAN STUDIO</div>
              <h1>직접 촬영하고,<br /><span>꼼꼼히 등록하세요.</span></h1>
              <p>동영상에서 선명한 프레임을 선별하고, 선택한 프레임을 서버에서 재구성합니다. 완료된 스캔 없이는 등록할 수 없어요.</p>
            </div>
            <div className="scan-layout">
              <div className="scan-main">
                <section className="scan-card-panel seller-details">
                  <div className="panel-heading"><span className="step-number">01</span><div><h2>상품 정보 먼저 작성</h2><p>재구성 전에 미리 적고, 작업 중에도 수정할 수 있어요.</p></div></div>
                  <label>상품명<input required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="예: 사용감 적은 미러리스 카메라" /></label>
                  <div className="input-row"><label>가격 (원)<input required type="number" min="0" max="1000000000" step="1" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="300000" /></label><label>카테고리<select value={category} onChange={(event) => setCategory(event.target.value)}><option>디지털 · 카메라</option><option>패션 · 의류</option><option>가구 · 인테리어</option><option>생활 · 취미</option><option>기타</option></select></label></div>
                  <label>상품 설명<textarea maxLength={2000} rows="4" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="사용 기간, 보수 이력, 확인한 흠집과 손상 부위를 구체적으로 적어 주세요." /></label>
                  {draft && <button type="button" className="button button-outline full-button" disabled={busy} onClick={() => void saveDraftDetails()}>상품 정보 저장</button>}
                </section>
                {!draft ? (
                  <form className="scan-card-panel" onSubmit={startScan}>
                    <div className="panel-heading"><span className="step-number">02</span><div><h2>전체 촬영과 4K 근접 결함 촬영</h2><p>전체 2개 경로와 별도의 4K 근접 촬영을 모두 통과해야 해요.</p></div><span className="step-status">{videoClips.length}/{captureStages.length} 촬영</span></div>
                    <div className="capture-tips">
                      <span className="tip-icon">✳</span>
                      <div><strong>전체 촬영 후, 상품을 화면에 크게 담아 4K로 모든 면을 근접 촬영하세요.</strong><p>마지막 단계에서는 카메라를 상품 가까이 두고 물건을 천천히 돌리거나 뒤집어 표면 전체를 촬영합니다. 4K 원본에서 초점이 선명한 프레임을 최소 {MIN_DETAIL_FRAMES}장 검사하며, 실패하면 등록할 수 없습니다. 이는 0.5mm 결함을 촬영하기 위한 기준이지 발견을 보증하지는 않습니다.</p></div>
                    </div>
                    <div className="surface-pass-list" aria-label="전체 표면 경로와 근접 촬영 단계">
                      {captureStages.map((sector, index) => {
                        const complete = videoClips.some((clip) => clip.sector === sector.id);
                        const active = activeSectorIndex === index && !complete;
                        return <div key={sector.id} className={`surface-pass ${active ? "active" : ""} ${complete ? "complete" : ""}`} aria-current={active ? "step" : undefined}><span>{complete ? "✓" : String(index + 1).padStart(2, "0")}</span>{sector.label}</div>;
                      })}
                    </div>
                    <div className="current-pass-tip"><strong>{activeCaptureStage?.label || "필수 촬영 완료"}</strong><span>{cameraGuide}</span></div>
                    <div className="photo-counter"><span className="counter-track"><i style={{ width: `${sectorProgress}%` }} /></span><span><strong>{sectorProgress}%</strong> {activeCaptureStage?.id === "detail" ? "근접 촬영 진행률" : "현재 경로 방향 범위"}</span></div>
                    {showCamera && (
                      <div className="camera-panel">
                        <div className="camera-viewport">
                          <video ref={videoRef} autoPlay playsInline muted onLoadedMetadata={(event) => event.currentTarget.play().catch(() => {})} />
                          <div className="camera-selection-layer" onClick={selectProductInPreview} onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              const bounds = event.currentTarget.getBoundingClientRect();
                              selectProductInPreview({
                                currentTarget: event.currentTarget,
                                clientX: bounds.left + bounds.width / 2,
                                clientY: bounds.top + bounds.height / 2,
                              });
                            }
                          }} role="button" tabIndex={0} aria-label="판매할 상품을 터치해 배경과 구분">
                            {objectSelection && <span className="selection-point" style={{ left: `${objectSelection.x * 100}%`, top: `${objectSelection.y * 100}%` }}><span>조준점</span></span>}
                            {objectBounds && <span className="object-outline" style={{ left: `${objectBounds.left * 100}%`, top: `${objectBounds.top * 100}%`, width: `${(objectBounds.right - objectBounds.left) * 100}%`, height: `${(objectBounds.bottom - objectBounds.top) * 100}%` }} />}
                            <span className="direction-indicator" aria-live="polite"><strong>{targetDirection === "왼쪽" ? "←" : targetDirection === "오른쪽" ? "→" : "↑"}</strong> 카메라 {targetDirection} 이동</span>
                            <span className={`camera-guide ${objectBounds ? "detected" : ""}`}>{cameraGuide}</span>
                          </div>
                        </div>
                        <div className="camera-controls">
                          <button type="button" className="button button-outline" disabled={processingVideo || recording || !segmenterReady || !objectBounds || !orientationReady || brightness === null || brightness < DARKNESS_THRESHOLD || !activeCaptureStage || !detailCaptureReady} onClick={startRecording}>● {recording ? "촬영 중…" : activeCaptureStage?.id === "detail" ? "4K 근접 결함 촬영 시작" : "이 경로 촬영 시작"}</button>
                          <button type="button" className="text-button" disabled={recording} onClick={stopCamera}>카메라 닫기</button>
                        </div>
                        <p className="recording-indicator"><span className={torchEnabled ? "torch-on" : ""} />{recording ? `녹화 중 · ${sectorProgress}% · ${cameraGuide}` : `카메라 ${cameraSettings?.width || "?"}×${cameraSettings?.height || "?"} · 밝기 ${brightness === null ? "측정 중" : Math.round(brightness)} · 플래시 ${torchSupported ? (torchEnabled ? "켜짐" : "꺼짐") : "미지원 (밝은 환경 필요)"} · 방향 센서 ${orientationReady ? "연결됨" : "연결 중"}`}</p>
                      </div>
                    )}
                    {cameraError && <p className="form-error">{cameraError}</p>}
                    <div className="capture-options">
                      <button type="button" className="capture-option" onClick={startCamera}>
                        <span className="capture-icon">◎</span><strong>{showCamera ? "카메라 다시 연결" : "실시간 안내 촬영 시작"}</strong><span>카메라·방향 센서 권한이 필요해요. 지원 기기에서는 플래시를 자동 사용하고, 미지원 기기에서는 밝은 환경에서만 촬영할 수 있어요.</span>
                      </button>
                    </div>
                    <div className="photo-counter"><span className="counter-track"><i style={{ width: `${Math.min((files.length / MIN_IMAGES) * 100, 100)}%` }} /></span><span><strong>{files.length}</strong> / 전체 3D 재구성용 프레임 최소 {MIN_IMAGES}장 · 최대 {MAX_IMAGES}장</span></div>
                    {processingVideo && <div className="frame-processing"><span className="spinner" /> 영상에서 흐림·중복 장면을 분석하고 있어요…</div>}
                    {frameReport && <p className="frame-report">{frameReport}</p>}
                    <div className="photo-grid">
                      {frames.map((frame, index) => {
                        const key = `${frame.file.name}:${frame.file.size}:${frame.file.lastModified}`;
                        return <div className="photo-thumb" key={key}><img src={previews[key]} alt={`선별된 스캔 프레임 ${index + 1}`} /><span>{String(index + 1).padStart(2, "0")}</span><button type="button" aria-label={`프레임 ${index + 1} 제거`} onClick={() => removeFrame(index)}>×</button></div>;
                      })}
                    </div>
                    <div className="scan-disclosure"><span>ⓘ</span> 이동 경로 원본은 등록 시 서버로 전송되어 재구성됩니다. 상품 선택과 실시간 화면 분석은 기기 안에서 처리합니다. 브라우저는 플래시에 별도 권한 창을 제공하지 않으므로 카메라 권한과 플래시 지원 여부를 확인합니다.</div>
                    {formError && <p className="form-error">{formError}</p>}
                    <button className="button button-dark full-button" disabled={busy || processingVideo || recording || activeSectorIndex < captureStages.length || videoClips.length !== captureStages.length || files.length < MIN_IMAGES || !health?.reconstructionAvailable}>
                      {busy ? "동영상을 서버로 전송 중…" : !health?.reconstructionAvailable ? "GPU 재구성 엔진 확인 필요" : `${videoClips.length}개 촬영과 ${files.length}장 프레임으로 3D 재구성 →`}
                    </button>
                    {!health?.reconstructionAvailable && <p className="engine-warning">{health?.colmapAvailable === false ? "COLMAP을 찾지 못했어요." : ""}{health?.cudaAvailable === false ? " NVIDIA GPU 또는 nvidia-smi를 찾지 못했어요." : ""}{health?.colmapCudaAvailable === false ? " 설치된 COLMAP에 CUDA 지원이 없어요." : ""} CUDA 지원 COLMAP과 NVIDIA GPU가 모두 필요해요. README 설치 안내를 확인한 뒤 서버를 다시 시작해 주세요.</p>}
                  </form>
                ) : (
                  <div className="scan-card-panel">
                    <div className="panel-heading"><span className="step-number">02</span><div><h2>{draft.status === "ready" ? "스캔 완료" : draft.status === "failed" ? "스캔 실패" : "서버에서 재구성 중"}</h2><p>{draft.imageCount}장의 사진 · {draft.id.slice(0, 8)}</p></div><span className={`scan-badge ${draft.status}`}>{draft.status === "ready" ? "RECONSTRUCTED" : draft.status.toUpperCase()}</span></div>
                    {(draft.status === "processing" || draft.status === "queued") && <div className="processing-state"><span className="spinner" /><div className="processing-details"><strong>{draft.status === "queued" ? "스캔 작업이 대기 중이에요." : "선별된 프레임에서 3D 표면을 계산하고 있어요."}</strong><p>이 작업은 컴퓨터 사양과 프레임 수에 따라 수 분 이상 걸릴 수 있습니다. 브라우저를 닫아도 상태는 유지돼요.</p><div className="progress-heading"><span>진행률 · 단계별 추정치</span><strong>{draft.progressPercent ?? 0}%</strong></div><div className="progress-track" role="progressbar" aria-label={`3D 재구성 진행률 ${draft.progressPercent ?? 0}%`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={draft.progressPercent ?? 0}><span style={{ width: `${draft.progressPercent ?? 0}%` }} /></div><span className="process-stage">{draft.progress || "서버 작업 대기 중"}</span></div></div>}
                    {draft.status === "failed" && <div className="failure-state"><strong>이 영상에서 선별한 프레임으로는 등록 가능한 3D 모델이 만들어지지 않았어요.</strong><p>{draft.error}</p><p>조명이 고르고 초점이 유지되는 환경에서 카메라를 천천히 이동해 다시 촬영해 주세요.</p><button type="button" className="button button-outline" onClick={() => { setDraft(null); clearFrames(); setMessage(""); }}>새로 스캔하기</button></div>}
                    {draft.status === "ready" && <><div className="draft-model"><ModelPreview src={modelSrc(draft)} /><span className="model-tag"><span>◉</span> 고밀도 컬러 3D 점군</span></div><div className="scan-disclosure"><span>ⓘ</span> 근접 사진은 높은 해상도의 원본 증거이며, AI가 모든 흠집을 자동 판정하거나 0.5mm 결함 발견을 보증하지는 않습니다.</div>
                      <form className="listing-form" onSubmit={publish}>
                        <div className="originals-strip">{draft.images.slice(0, 8).map((image, index) => <img key={image} src={`/media/scans/${draft.id}/images/${encodeURIComponent(image)}`} alt={`원본 스캔 이미지 ${index + 1}`} />)}<span>상품 상태 확인용 스캔 원본 {draft.imageCount}장</span></div>
                        <div className="detail-evidence"><h3>4K 근접 표면 사진 · {draft.detailCount}장</h3><p>원본 해상도로 열어 작은 표면 흔적을 직접 확인하세요.</p><div>{draft.details.map((frame, index) => <a key={frame.name} href={`/media/scans/${draft.id}/details/${encodeURIComponent(frame.name)}`} target="_blank" rel="noreferrer"><img src={`/media/scans/${draft.id}/details/${encodeURIComponent(frame.name)}`} alt={`근접 표면 사진 ${index + 1}`} loading="lazy" /><span>{frame.width}×{frame.height}</span></a>)}</div></div>
                        {formError && <p className="form-error">{formError}</p>}
                        <button className="button button-dark full-button" disabled={busy}>{busy ? "등록 중…" : "완료된 3D 스캔으로 매물 등록하기 →"}</button>
                      </form>
                      <div className="video-evidence-grid seller-video-evidence">{draft.videos.map((video) => <figure key={video.stage}><figcaption>{captureStages.find((stage) => stage.id === video.stage)?.label || video.stage}</figcaption><video controls playsInline preload="metadata" src={`/media/scans/${draft.id}/videos/${video.stage}`} /></figure>)}</div>
                      <button type="button" className="button button-outline full-button" disabled={busy} onClick={() => { setDraft(null); clearFrames(); setTitle(""); setPrice(""); setCategory("디지털 · 카메라"); setDescription(""); setMessage(""); setFormError(""); }}>다른 상품 새로 스캔하기</button>
                    </>}
                  </div>
                )}
              </div>
              <aside className="scan-sidebar">
                <div className="sidebar-card"><div className="eyebrow">SCAN QUALITY</div><h3>전체 회전 2회<br />4K 근접 촬영 1회</h3><ol className="quality-list"><li><span>01</span><div><strong>판매할 상품 선택</strong><p>화면에서 상품을 터치하면 기기 안에서 상품 영역을 추적합니다.</p></div></li><li><span>02</span><div><strong>두 전체 경로 안내 따르기</strong><p>방향 센서가 다음 방향과 상품 조준 위치를 안내합니다.</p></div></li><li><span>03</span><div><strong>상품을 가까이서 돌려 촬영</strong><p>상품이 화면 대부분을 차지하도록 4K로 천천히 모든 면을 기록합니다.</p></div></li><li><span>04</span><div><strong>원본 품질 검사</strong><p>서버가 4K 해상도와 초점을 검사하고 선명한 근접 프레임을 저장합니다.</p></div></li></ol></div>
                <div className="sidebar-note"><span>R.</span><p>0.5mm는 촬영 설계 목표이며 발견 보증이 아닙니다. 결함이 흐리거나 가려져 입력 영상에 담기지 않으면 모델도 복원할 수 없습니다.</p></div>
              </aside>
            </div>
          </section>
        )}

        <footer className="footer"><span className="footer-brand">REAL<span>RESALE</span></span><p>다시 보고, 잘 고르다. © 2026 RealResale</p><span>Look closer. Buy better.</span></footer>
      </main>

      {message && <div className="toast" role="status"><span>✓</span>{message}<button onClick={() => setMessage("")} aria-label="닫기">×</button></div>}

      {selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <article className="listing-modal" role="dialog" aria-modal="true" aria-label={selected.title}>
            <button className="modal-close" onClick={() => setSelected(null)} aria-label="닫기">×</button>
            <div className="modal-view"><ModelPreview src={modelSrc(selected.scan)} /></div>
            <div className="modal-content"><div className="listing-meta"><span>{selected.category}</span><span>플랫폼 재구성 · 사진 {selected.scan.imageCount}장</span></div><h2>{selected.title}</h2><strong className="modal-price">{money.format(selected.price)}원</strong><p>{selected.description || "상품 설명이 없습니다."}</p><p className="seller-byline">판매자 · {selected.seller?.username || "기존 판매자"}</p>
              <button className="button button-dark" onClick={() => void openListingConversation(selected)} disabled={!selected.seller || selected.seller.id === user?.id}>판매자에게 비공개 메시지 보내기</button>
              {messageError && <p className="form-error">{messageError}</p>}
              {activeConversation?.listingId === selected.id && <section className="chat-panel"><h3>{activeConversation.listingTitle} 문의 · {activeConversation.otherUsername}</h3><div className="chat-messages">{chatMessages.map((chat) => <p key={chat.id} className={chat.senderId === user?.id ? "chat-message mine" : "chat-message"}><strong>{chat.senderUsername}</strong>{chat.body}</p>)}</div><form className="chat-compose" onSubmit={sendMessage}><input aria-label="메시지 내용" maxLength={2000} value={messageInput} onChange={(event) => setMessageInput(event.target.value)} placeholder="판매자에게 메시지 보내기" /><button className="button button-dark" disabled={!messageInput.trim()}>전송</button></form></section>}
              <div className="originals-heading"><strong>촬영 원본 프레임</strong><span>상품과 3D 결과를 여러 방향에서 직접 확인하세요.</span></div>
              <div className="modal-originals">{selected.scan.images.map((image, index) => <img key={image} src={`/media/scans/${selected.scan.id}/images/${encodeURIComponent(image)}`} alt={`${selected.title} 원본 사진 ${index + 1}`} loading="lazy" />)}</div>
              {selected.scan.details?.length > 0 && <div className="detail-evidence"><h3>4K 근접 표면 사진 · {selected.scan.details.length}장</h3><p>사진을 열어 원본 크기로 확대해 확인하세요. 자동 결함 판정 결과는 아닙니다.</p><div>{selected.scan.details.map((frame, index) => <a key={frame.name} href={`/media/scans/${selected.scan.id}/details/${encodeURIComponent(frame.name)}`} target="_blank" rel="noreferrer"><img src={`/media/scans/${selected.scan.id}/details/${encodeURIComponent(frame.name)}`} alt={`${selected.title} 근접 표면 사진 ${index + 1}`} loading="lazy" /><span>{frame.width}×{frame.height}</span></a>)}</div></div>}
              {selected.scan.videos?.length > 0 && <div className="video-evidence"><h3>전체 이동 경로와 근접 촬영 원본 영상</h3><div className="video-evidence-grid">{selected.scan.videos.map((video) => <figure key={video.stage}><figcaption>{captureStages.find((stage) => stage.id === video.stage)?.label || video.stage}</figcaption><video controls playsInline preload="metadata" src={`/media/scans/${selected.scan.id}/videos/${video.stage}`} /></figure>)}</div></div>}
            </div>
          </article>
        </div>
      )}

      {authOpen && (
        <div className="modal-backdrop auth-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className="auth-panel" role="dialog" aria-modal="true" aria-label={authMode === "register" ? "계정 만들기" : "로그인"}>
            <button className="modal-close" onClick={() => setAuthOpen(false)} aria-label="닫기">×</button>
            <div className="eyebrow">REALRESALE ACCOUNT</div>
            <h2>{authMode === "register" ? "계정을 만들어 시작하세요." : "다시 오신 것을 환영해요."}</h2>
            <form className="auth-form" onSubmit={submitAuthentication}>
              <label>사용자명<input autoComplete="username" minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" required value={usernameInput} onChange={(event) => setUsernameInput(event.target.value)} /></label>
              <label>비밀번호<input autoComplete={authMode === "register" ? "new-password" : "current-password"} type="password" minLength={10} maxLength={128} required value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} /></label>
              {authError && <p className="form-error">{authError}</p>}
              <button className="button button-dark full-button">{authMode === "register" ? "계정 만들기" : "로그인"}</button>
            </form>
            <button className="text-button auth-switch" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthError(""); }}>{authMode === "register" ? "이미 계정이 있나요? 로그인" : "계정이 없나요? 회원가입"}</button>
            <p className="auth-disclaimer">이 MVP는 로컬 사용자명·비밀번호 계정을 사용하며 이메일 인증과 비밀번호 복구는 제공하지 않습니다.</p>
          </section>
        </div>
      )}

      {inboxOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInboxOpen(false); }}>
          <section className="inbox-panel" role="dialog" aria-modal="true" aria-label="메시지함">
            <button className="modal-close" onClick={() => setInboxOpen(false)} aria-label="닫기">×</button>
            <div className="eyebrow">PRIVATE MESSAGES</div><h2>메시지함</h2>
            {messageError && <p className="form-error">{messageError}</p>}
            {inbox.length === 0 ? <p className="inbox-empty">아직 대화가 없습니다. 매물에서 판매자에게 문의해 보세요.</p> : <div className="inbox-list">{inbox.map((conversation) => <button key={conversation.id} className={`inbox-item ${activeConversation?.id === conversation.id ? "active" : ""}`} onClick={() => void openConversationFromInbox(conversation)}><strong>{conversation.listingTitle}</strong><span>{conversation.otherUsername}</span><small>{conversation.lastMessage || "대화를 시작해 보세요."}</small></button>)}</div>}
            {activeConversation && <section className="chat-panel"><h3>{activeConversation.listingTitle} · {activeConversation.otherUsername}</h3><div className="chat-messages">{chatMessages.map((chat) => <p key={chat.id} className={chat.senderId === user?.id ? "chat-message mine" : "chat-message"}><strong>{chat.senderUsername}</strong>{chat.body}</p>)}</div><form className="chat-compose" onSubmit={sendMessage}><input aria-label="메시지 내용" maxLength={2000} value={messageInput} onChange={(event) => setMessageInput(event.target.value)} placeholder="메시지 작성" /><button className="button button-dark" disabled={!messageInput.trim()}>전송</button></form></section>}
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
