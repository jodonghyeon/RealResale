import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  getAdaptiveScanGuidance,
  getDetailCaptureGuidance,
  hasDetailCaptureFraming,
  getRouteCoverage,
  recordHeadingCoverage,
  supportsDetailCaptureResolution,
} from "./scan-guidance.js";

const MIN_IMAGES = 24;
const MAX_IMAGES = 80;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 30;
const CAMERA_PASS_SECONDS = 30;
const MIN_SECTOR_COVERAGE = 9;
const MIN_RECORDING_SECONDS = 5;
const MIN_DETAIL_FRAMES = 20;
const MIN_DETAIL_VIDEO_SECONDS = 20;
const DETAIL_RECORDING_SECONDS = 20;
const MIN_DETAIL_RESOLUTION = 3840;
const DARKNESS_THRESHOLD = 48;
const BRIGHTNESS_RECOVERY_THRESHOLD = 72;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const FRAME_SAMPLE_SECONDS = 0.3;
const MAX_VIDEO_CANDIDATES = 120;
const MAX_FRAME_DIMENSION = 2560;
const scanSectors = [
  { id: "route-a", label: "Level orbit · first half" },
  { id: "route-b", label: "Level orbit · second half" },
];
const captureStages = [
  ...scanSectors,
  { id: "detail", label: "4K close-up capture" },
];
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const displayCategory = (category) => category;
const Viewer = lazy(() => import("./Viewer.jsx"));

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while reading a video frame."));
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
      reject(new Error("Could not read a video frame. Try recording the route again."));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = time;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not save the video frame as an image."))),
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
  if (!context) throw new Error("This browser cannot analyze video frames.");
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
    <Suspense fallback={<div className="model-viewer viewer-loading">Loading 3D model…</div>}>
      <Viewer src={src} />
    </Suspense>
  );
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
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
  const [category, setCategory] = useState("Electronics & cameras");
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
  const [cameraGuide, setCameraGuide] = useState("Open the live camera, then tap the item you want to sell.");
  const [segmenterLoadProgress, setSegmenterLoadProgress] = useState(null);
  const [segmenterLoadStage, setSegmenterLoadStage] = useState(null);
  const [segmenterLoadError, setSegmenterLoadError] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const recordingChunks = useRef([]);
  const framesRef = useRef([]);
  const recordingTimeout = useRef(null);
  const notified = useRef(new Set());
  const workerRef = useRef(null);
  const segmenterInitializationStarted = useRef(false);
  const selectionRef = useRef(null);
  const orientationRef = useRef(null);
  const startingHeadingRef = useRef(null);
  const sectorCoverageRef = useRef(Array(24).fill(false));
  const activeSectorIndexRef = useRef(0);
  const routeVideoPartsRef = useRef({ "route-a": [], "route-b": [] });
  const recordingStartedAtRef = useRef(0);
  const recordingCoverageStartRef = useRef(null);
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
  const completedCaptureStageCount = new Set(videoClips.map((clip) => clip.sector)).size;
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
    startingHeadingRef.current = null;
    routeVideoPartsRef.current = { "route-a": [], "route-b": [] };
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
    const worker = new Worker(new URL("./segmenter.worker.js", import.meta.url));
    workerRef.current = worker;
    segmenterInitializationStarted.current = false;
    worker.addEventListener("message", (event) => {
      if (event.data.type === "loading") {
        setSegmenterLoadStage(event.data.stage);
        setSegmenterLoadProgress(event.data.stage === "download" ? event.data.progress : null);
        if (event.data.stage === "verify" || event.data.stage === "initializing") {
          setSegmenterLoadProgress(100);
        }
        setSegmenterLoadError("");
        setCameraGuide(event.data.stage === "runtime"
          ? "Preparing the on-device vision runtime…"
          : event.data.stage === "download"
            ? `Downloading the item selection model… ${event.data.progress}% of about 30 MB`
            : event.data.stage === "verify"
              ? "Download reached 100%. Verifying the item selection model…"
              : "Download verified. Initializing the item selection model…");
      } else if (event.data.type === "ready") {
        setSegmenterReady(true);
        setSegmenterLoadProgress(null);
        setSegmenterLoadStage("ready");
        setSegmenterLoadError("");
        setCameraGuide("Item selected. Keep it centered and follow the camera guide.");
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
          setCameraError("This browser cannot control the camera flash. Turn on nearby lights and try again.");
          setCameraGuide("There is not enough light. Turn on nearby lights to continue.");
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
              if (enableTorch) setCameraGuide("Low light detected. Flash is on; checking brightness again.");
            })
            .catch((error) => {
              setCameraError(
                error instanceof Error
                  ? `Could not control the required flash, so capture was stopped: ${error.message}`
                  : "The required flash is unavailable, so capture was stopped.",
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
            const routeCoverage = getRouteCoverage(sectorCoverageRef.current, sectorIndex);
            setSectorProgress(routeCoverage.progress);
            const elapsedSeconds = (Date.now() - recordingStartedAtRef.current) / 1000;
            if (routeCoverage.complete && elapsedSeconds >= MIN_RECORDING_SECONDS) {
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
            const detailGuidance = getDetailCaptureGuidance(bounds);
            if (brightnessLevel < DARKNESS_THRESHOLD && !torchEnabledRef.current) {
              setCameraGuide("Close-up capture needs more light. Turn on a light and try again.");
            } else if (recorder?.state === "recording") {
              setCameraGuide(detailGuidance);
            } else {
              setCameraGuide(detailGuidance);
            }
          } else {
            const guidance = getAdaptiveScanGuidance({
              bounds,
              sectorIndex: activeSectorIndexRef.current,
              coverage: sectorCoverageRef.current,
            });
            setSectorProgress(guidance.progress);
            if (!cameraReady) {
              setCameraGuide("Camera disconnected. Reopen it to continue this route.");
            } else if (
              brightnessLevel < DARKNESS_THRESHOLD &&
              !torchEnabledRef.current &&
              torchSupportedRef.current
            ) {
              setCameraGuide("Turning on the flash. Wait for the brightness check to finish.");
            } else if (brightnessLevel < DARKNESS_THRESHOLD && !torchEnabledRef.current) {
              setCameraGuide("There is not enough light. Turn on nearby lights to continue.");
            } else if (!recorder || recorder.state !== "recording") {
              setCameraGuide(guidance.complete ? "This half is complete. Continue to the next step." : guidance.message);
            } else {
              setCameraGuide(guidance.message);
            }
          }
        } else {
          setCameraGuide("The item is out of frame. Bring it back into view.");
        }
      } else if (event.data.type === "error") {
        segmentationBusy.current = false;
        setSegmenterLoadStage("error");
        setSegmenterLoadError(event.data.message);
        setSegmenterLoadProgress(null);
        setCameraGuide(`Item selection model error: ${event.data.message}`);
      }
    });
    worker.addEventListener("error", (event) => {
      segmentationBusy.current = false;
      setSegmenterLoadStage("error");
      setSegmenterLoadError(event.message);
      setSegmenterLoadProgress(null);
      setCameraGuide(`Could not start the on-device item selector: ${event.message}`);
    });
    return () => {
      worker.terminate();
      workerRef.current = null;
      segmenterInitializationStarted.current = false;
      segmentationBusy.current = false;
      selectionRef.current = null;
      setSegmenterReady(false);
      setSegmenterLoadProgress(null);
      setSegmenterLoadStage(null);
      setObjectBounds(null);
      setObjectSelection(null);
    };
  }, [cameraReady, showCamera]);

  useEffect(() => {
    if (
      !showCamera ||
      !objectSelection ||
      segmenterReady ||
      segmenterInitializationStarted.current ||
      !workerRef.current
    ) return;
    segmenterInitializationStarted.current = true;
    setSegmenterLoadProgress(0);
    setSegmenterLoadError("");
    setCameraGuide("Downloading the on-device item selection model… 0% of about 30 MB");
    workerRef.current.postMessage({ type: "initialize" });
  }, [objectSelection, segmenterReady, showCamera]);

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
          setCameraGuide(error instanceof Error ? error.message : "Could not analyze the camera frame.");
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
    setSegmenterLoadError("");
    setCameraGuide(segmenterReady ? "Finding the outline of the selected item…" : "Tap the item you want to sell. The selection model will download after you tap.");
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
      setMessage(`Welcome, ${result.user.username}.`);
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
      setMessage("You have signed out.");
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
              ? "3D reconstruction is complete. Add your item details."
              : "Reconstruction failed. Review the capture videos and start a new scan.",
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
      ? "Resumed an unpublished scan. Continue entering the item details."
      : resumable
        ? "Resumed your scan in progress."
        : "");
    setFormError("");
    setTitle(resumable?.title || "");
    setPrice(resumable?.price ? String(resumable.price) : "");
    setCategory(displayCategory(resumable?.category || "Electronics & cameras"));
    setDescription(resumable?.description || "");
  };

  const processVideoClip = async (clip, sectorId) => {
    const clips = Array.isArray(clip) ? clip : [clip];
    const detailPass = sectorId === "detail";
    if (!detailPass && framesRef.current.length >= MAX_IMAGES) {
      setFormError(`You can use up to ${MAX_IMAGES} selected frames.`);
      return;
    }
    setProcessingVideo(true);
    setCameraError("");
    setFormError("");
    setFrameReport(detailPass
      ? "Checking the 4K close-up video for sharp frames that show the item's surface."
      : "Checking the saved route clips and selecting sharp, distinct views.");
    const sources = [];

    try {
      const candidates = [];
      let totalDuration = 0;
      for (const routeClip of clips) {
        const videoUrl = URL.createObjectURL(routeClip);
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.src = videoUrl;
        sources.push({ video, videoUrl });
        await new Promise((resolve, reject) => {
          video.addEventListener("loadedmetadata", resolve, { once: true });
          video.addEventListener("error", () => reject(new Error("Could not read a saved recording. Reconnect the camera and try again.")), { once: true });
          video.load();
        });
        const minimumDuration = detailPass ? MIN_DETAIL_VIDEO_SECONDS : MIN_RECORDING_SECONDS;
        const maximumDuration = detailPass ? DETAIL_RECORDING_SECONDS : MAX_VIDEO_SECONDS;
        if (!Number.isFinite(video.duration) || video.duration < minimumDuration) {
          throw new Error(detailPass
            ? `The close-up must be at least ${MIN_DETAIL_VIDEO_SECONDS} seconds to capture enough sharp frames.`
            : "A saved route segment is too short. Record it again before continuing.");
        }
        if (video.duration > maximumDuration + 1) {
          throw new Error(`A recording must be ${maximumDuration} seconds or shorter.`);
        }
        if (!video.videoWidth || !video.videoHeight) throw new Error("A saved recording has no readable frames.");
        if (detailPass && !supportsDetailCaptureResolution(video.videoWidth, video.videoHeight)) {
          throw new Error(`The close-up was recorded below ${MIN_DETAIL_RESOLUTION}px. Check whether your device supports 4K recording and try again.`);
        }
        totalDuration += video.duration;
        const candidateLimit = Math.max(12, Math.floor(MAX_VIDEO_CANDIDATES / clips.length));
        const interval = Math.max(detailPass ? 0.5 : FRAME_SAMPLE_SECONDS, video.duration / candidateLimit);
        for (let time = Math.min(0.15, video.duration / 4); time < video.duration - 0.08; time += interval) {
          await seekVideo(video, time);
          candidates.push({ video, time, ...analyzeFrame(video, detailPass ? 960 : 320) });
        }
      }
      if (detailPass && (clips.length !== 1 || totalDuration < MIN_DETAIL_VIDEO_SECONDS)) {
        throw new Error(`The close-up must be at least ${MIN_DETAIL_VIDEO_SECONDS} seconds to capture enough sharp frames.`);
      }
      if (candidates.length === 0) {
        throw new Error("Could not extract frames from the saved recordings.");
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
          throw new Error(`Fewer than ${MIN_DETAIL_FRAMES} distinct, sharp close-up frames were found. Improve the lighting, rotate the item more slowly, and record again.`);
        }
        const currentBytes = videoClipsRef.current.reduce((total, savedClip) => total + savedClip.file.size, 0) +
          clips.reduce((total, savedClip) => total + savedClip.size, 0);
        if (currentBytes > MAX_VIDEO_BYTES) {
          throw new Error("The combined capture videos exceed 512 MB.");
        }
        const extension = clips[0].type.includes("mp4") ? "mp4" : "webm";
        const videoFile = new File([clips[0]], `${sectorId}.${extension}`, { type: clips[0].type || "video/webm" });
        videoClipsRef.current = [
          ...videoClipsRef.current.filter((video) => video.sector !== sectorId),
          { sector: sectorId, file: videoFile },
        ];
        setVideoClips(videoClipsRef.current);
        setActiveSectorIndex(captureStages.length);
        activeSectorIndexRef.current = captureStages.length;
        setSectorProgress(100);
        setFrameReport(`Found ${selected.length} sharp 4K close-up frames. The server will verify focus and source resolution.`);
        return;
      }

      const extracted = [];
      for (const candidate of selected) {
        const { video } = candidate;
        await seekVideo(video, candidate.time);
        const scale = Math.min(1, MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        const imageCanvas = document.createElement("canvas");
        imageCanvas.width = width;
        imageCanvas.height = height;
        const imageContext = imageCanvas.getContext("2d");
        if (!imageContext) throw new Error("Could not convert the video frame to an image.");
        imageContext.drawImage(video, 0, 0, width, height);
        const imageBlob = await canvasToBlob(imageCanvas, "image/jpeg", 0.94);
        if (imageBlob.size > MAX_IMAGE_BYTES) {
          throw new Error("An extracted image exceeds 20 MB. Record the video at a lower resolution.");
        }
        const previewCanvas = document.createElement("canvas");
        const previewScale = Math.min(1, 512 / Math.max(width, height));
        previewCanvas.width = Math.max(1, Math.round(width * previewScale));
        previewCanvas.height = Math.max(1, Math.round(height * previewScale));
        const previewContext = previewCanvas.getContext("2d");
        if (!previewContext) throw new Error("Could not create a frame preview.");
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
        throw new Error("The selected frames exceed 512 MB in total.");
      }
      if (videoClipsRef.current.reduce((total, savedClip) => total + savedClip.file.size, 0) +
        clips.reduce((total, routeClip) => total + routeClip.size, 0) > MAX_VIDEO_BYTES) {
        throw new Error("The combined videos for both routes exceed 512 MB.");
      }
      if (extracted.length < MIN_IMAGES / scanSectors.length) {
        throw new Error("Not enough sharp, overlapping frames were found on this route. Follow the direction shown and record again.");
      }
      framesRef.current = [...framesRef.current, ...extracted];
      setFrames(framesRef.current);
      const videoFiles = clips.map((routeClip, index) => {
        const extension = routeClip.type.includes("mp4") ? "mp4" : "webm";
        return {
          sector: sectorId,
          file: new File([routeClip], `${sectorId}-part-${index + 1}.${extension}`, { type: routeClip.type || "video/webm" }),
        };
      });
      videoClipsRef.current = [
        ...videoClipsRef.current.filter((video) => video.sector !== sectorId),
        ...videoFiles,
      ];
      setVideoClips(videoClipsRef.current);
      routeVideoPartsRef.current[sectorId] = [];
      const nextSectorIndex = sectorId === "route-a" ? 1 : 2;
      setActiveSectorIndex(nextSectorIndex);
      activeSectorIndexRef.current = nextSectorIndex;
      setSectorProgress(nextSectorIndex < scanSectors.length
        ? getRouteCoverage(sectorCoverageRef.current, nextSectorIndex).progress
        : 0);
      setFrameReport(
        `${extracted.length} frames selected · ${blurryCount} blurry and ${duplicateCount} duplicate views excluded`,
      );
      if (framesRef.current.length < MIN_IMAGES) {
        setFrameReport(`${framesRef.current.length}/${MIN_IMAGES} frames selected · checked again after the second route`);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not analyze the video frames.");
      setFrameReport("");
      if (!detailPass) routeVideoPartsRef.current[sectorId] = clips;
    } finally {
      for (const { video, videoUrl } of sources) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(videoUrl);
      }
      setProcessingVideo(false);
    }
  };

  const startCamera = async () => {
    setCameraError("");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Live capture requires an HTTPS address trusted by this device.");
      }
      if (!("DeviceOrientationEvent" in window)) {
        throw new Error("This device's orientation sensor is required for route guidance.");
      }
      const orientationEvent = window.DeviceOrientationEvent;
      if (typeof orientationEvent.requestPermission === "function") {
        const permission = await orientationEvent.requestPermission();
        if (permission !== "granted") throw new Error("Allow orientation access to receive camera movement guidance.");
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
          throw new Error(`Could not verify camera flash access: ${error.message}`);
        }
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;
      cameraTrack?.addEventListener("ended", () => {
        if (streamRef.current !== stream) return;
        cancelledRecordingRef.current = true;
        stopRecording();
        streamRef.current = null;
        setCameraReady(false);
        setOrientationReady(false);
        orientationRef.current = null;
        setCameraError("Camera connection interrupted. Reconnect to continue; saved route progress will be kept.");
        setCameraGuide("Reconnect the camera and continue this same half-circle.");
      }, { once: true });
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
      setCameraError(error instanceof Error ? error.message : "Camera, orientation sensor, and flash access are required.");
    }
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === "undefined" || !orientationRef.current) {
      setCameraError("The orientation sensor and live video recording are not ready.");
      return;
    }
    if (!objectBounds || brightness === null || brightness < DARKNESS_THRESHOLD || torchUpdateRef.current) {
      setCameraError("Wait for the flash and brightness checks to finish before recording the route.");
      return;
    }
    const sector = captureStages[activeSectorIndexRef.current];
    if (!sector) return;
    const detailPass = sector.id === "detail";
    if (detailPass) {
      const settings = stream.getVideoTracks()[0]?.getSettings?.();
      if (!supportsDetailCaptureResolution(settings?.width, settings?.height)) {
        setCameraError(`To capture fine surface details, the camera must record in 4K (${MIN_DETAIL_RESOLUTION}px or higher). Check your device's camera resolution settings.`);
        return;
      }
      if (!hasDetailCaptureFraming(objectBounds)) {
        setCameraError("Move closer until the item fills 55–88% of the frame without being cut off.");
        return;
      }
    }
    try {
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordingChunks.current = [];
      if (!detailPass && !Number.isFinite(startingHeadingRef.current)) {
        startingHeadingRef.current = orientationRef.current.alpha;
      }
      if (!detailPass) {
        recordingCoverageStartRef.current = [...sectorCoverageRef.current];
        sectorCoverageRef.current = recordHeadingCoverage(
          sectorCoverageRef.current,
          orientationRef.current.alpha,
          startingHeadingRef.current,
        );
        setSectorProgress(getRouteCoverage(
          sectorCoverageRef.current,
          scanSectors.findIndex((route) => route.id === sector.id),
        ).progress);
      }
      cancelledRecordingRef.current = false;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) recordingChunks.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const clip = new Blob(recordingChunks.current, { type: recorder.mimeType || "video/webm" });
        recordingChunks.current = [];
        recorderRef.current = null;
        setRecording(false);
        const elapsedSeconds = (Date.now() - recordingStartedAtRef.current) / 1000;
        if (detailPass && cancelledRecordingRef.current) {
          setCameraGuide("Close-up capture stopped. Reopen the camera and record the full close-up.");
        } else if (clip.size === 0) {
          setFormError("The recorded video is empty.");
        } else if (!detailPass && elapsedSeconds < MIN_RECORDING_SECONDS) {
          if (recordingCoverageStartRef.current) {
            sectorCoverageRef.current = recordingCoverageStartRef.current;
          }
          const routeIndex = scanSectors.findIndex((route) => route.id === sector.id);
          const coverage = getRouteCoverage(sectorCoverageRef.current, routeIndex);
          setSectorProgress(coverage.progress);
          setCameraGuide("Recording was too short to keep. Reopen the camera and continue this same route.");
        } else if (detailPass) {
          void processVideoClip(clip, sector.id);
        } else {
          const routeIndex = scanSectors.findIndex((route) => route.id === sector.id);
          routeVideoPartsRef.current[sector.id].push(clip);
          const coverage = getRouteCoverage(sectorCoverageRef.current, routeIndex);
          setSectorProgress(coverage.progress);
          if (coverage.complete) {
            void processVideoClip([...routeVideoPartsRef.current[sector.id]], sector.id);
          } else {
            setCameraGuide(`Saved ${coverage.progress}% of this route. Reopen the camera and continue the same half-circle; your footage and progress are kept.`);
          }
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
      setCameraError(error instanceof Error ? error.message : "Could not start video recording.");
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
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
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
    setCameraGuide("Open the live camera and tap the item again.");
    setSegmenterLoadProgress(null);
    setSegmenterLoadError("");
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
    if (activeSectorIndexRef.current < captureStages.length || new Set(videoClipsRef.current.map((clip) => clip.sector)).size !== captureStages.length) {
      setFormError("Complete both full-item routes and the required 4K close-up before starting the scan.");
      return;
    }
    if (!title.trim() || !price || !Number.isSafeInteger(Number(price)) || Number(price) < 0) {
      setFormError("Enter an item title and price before starting the capture.");
      return;
    }
    if (files.length < MIN_IMAGES) {
      setFormError(`At least ${MIN_IMAGES} multi-angle images are required. You currently have ${files.length}.`);
      return;
    }
    setBusy(true);
    const form = new FormData();
    videoClipsRef.current.forEach(({ sector, file }) => {
      form.append("videos", file, file.name);
    });
    form.append("title", title.trim());
    form.append("description", description);
    form.append("category", category);
    form.append("price", String(Number(price)));
    try {
      const result = await request("/api/scans/videos", { method: "POST", body: form });
      setDraft(result.scan);
      notified.current.delete(result.scan.id);
      setMessage("Full-item and 4K close-up videos saved. The server will validate reconstruction frames and surface-detail images.");
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
      setMessage("Item description and price saved.");
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
      setFormError("You can publish only after the platform finishes reconstructing the scan.");
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
      setMessage("Your listing is live with its reconstructed 3D model.");
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
        <button className="brand" onClick={() => setPage("market")} aria-label="RealResale home">
          <span className="brand-mark">R<span>.</span></span>
          <span className="brand-copy">REAL<span>RESALE</span></span>
        </button>
        <div className="topbar-right">
          <span className={`engine-chip ${health?.reconstructionAvailable ? "online" : "offline"}`}>
            <span className="status-dot" />
            {health?.reconstructionAvailable ? "3D engine online" : "3D engine unavailable"}
          </span>
          <button className="button button-primary header-cta" onClick={openScanner}>
            <span aria-hidden="true">＋</span> Scan an item
          </button>
          <button className="button button-outline account-action" onClick={() => void openInbox()}>Messages</button>
          {user ? <><span className="account-name">{user.username}</span><button className="text-button" onClick={() => void logout()}>Sign out</button></> : <button className="text-button" onClick={() => { setAuthMode("login"); setAuthError(""); setAuthOpen(true); }}>Sign in</button>}
        </div>
      </header>

      <main>
        {page === "market" && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <div className="eyebrow"><span className="eyebrow-dot" /> REAL RESALE, REAL DETAIL</div>
                <h1>Buy secondhand.<br /><span>Look at every angle.</span></h1>
                <p>Don't rely on a few photos.<br className="desktop-break" /> Inspect the color 3D model and the seller's original capture videos.</p>
                <button className="button button-dark hero-button" onClick={openScanner}>
                  Scan an item to sell <span aria-hidden="true">↗</span>
                </button>
                <div className="hero-proof">
                  <span className="proof-icon">◎</span> Listings require a platform-reconstructed 3D scan
                </div>
              </div>
              <div className="hero-art" aria-label="Illustration of a real listing's 3D scan">
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
                  <div className="scan-card-bottom"><span>Inspect it from every angle</span><span className="scan-arrows">⤺</span></div>
                </div>
                <div className="floating-chip"><span className="floating-dot" /> 3D SCANNED</div>
                <span className="art-label">01 / 360° VIEW</span>
              </div>
              <span className="hero-watermark" aria-hidden="true">R</span>
            </section>

            <section className="market-section">
              <div className="section-heading">
                <div><div className="eyebrow section-eyebrow">THE MARKETPLACE</div><h2>Browse. Inspect. Decide.</h2></div>
                <span className="listing-count">{listings.length.toString().padStart(2, "0")} listings</span>
              </div>
              {listings.length === 0 ? (
                <div className="empty-market">
                  <div className="empty-icon">◇</div>
                  <h3>Create the first 3D listing.</h3>
                  <p>Complete a 3D scan from the item's capture videos to publish it here.</p>
                  <button className="button button-outline" onClick={openScanner}>Scan the first item <span>↗</span></button>
                </div>
              ) : (
                <div className="listing-grid">
                  {listings.map((listing) => (
                    <article className="listing-card" key={listing.id}>
                      <button className="listing-open" onClick={() => setSelected(listing)} aria-label={`View details for ${listing.title}`}>
                      <div className="listing-model"><ModelPreview src={modelSrc(listing.scan)} /><span className="model-tag"><span>◉</span> 3D VIEW</span></div>
                      <div className="listing-meta"><span>{displayCategory(listing.category)}</span><span>{listing.scan.imageCount} scan images</span></div>
                      <h3>{listing.title}</h3>
                      <p className="listing-description">{listing.description || "No item description."}</p>
                      <div className="listing-price">{money.format(listing.price)}<span className="card-arrow">↗</span></div>
                      </button>
                      <div className="listing-seller">Seller · {listing.seller?.username || "Legacy seller"}</div>
                      <button className="listing-message" onClick={() => void openListingConversation(listing)} disabled={!listing.seller || listing.seller.id === user?.id}>Message seller ↗</button>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="trust-strip">
              <span className="trust-seal">R</span>
              <p>Sellers complete two full-item routes and a 4K close-up. <strong>Buyers can inspect the 3D model, high-resolution surface images, and original videos, then message the seller privately.</strong></p>
              <button onClick={openScanner}>View the capture guide <span>↗</span></button>
            </section>
          </>
        )}

        {page === "scan" && (
          <section className="scan-page">
            <button className="back-link" onClick={() => setPage("market")}>← Back to marketplace</button>
            <div className="scan-header">
              <div className="eyebrow"><span className="eyebrow-dot" /> SELLER SCAN STUDIO</div>
              <h1>Capture it yourself.<br /><span>List it with confidence.</span></h1>
              <p>Sharp frames are selected from your videos and reconstructed on the server. A completed scan is required to publish a listing.</p>
            </div>
            <div className="scan-layout">
              <div className="scan-main">
                <section className="scan-card-panel seller-details">
                  <div className="panel-heading"><span className="step-number">01</span><div><h2>Enter item details first</h2><p>Add details before reconstruction; you can edit them while it runs.</p></div></div>
                  <label>Item title<input required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Mirrorless camera in good condition" /></label>
                  <div className="input-row"><label>Price (USD)<input required type="number" min="0" max="1000000000" step="1" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="300" /></label><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Electronics & cameras</option><option>Fashion & clothing</option><option>Furniture & home</option><option>Home & hobbies</option><option>Other</option></select></label></div>
                  <label>Item description<textarea maxLength={2000} rows="4" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Include how long it was used, repair history, and any scratches or damage you have found." /></label>
                  {draft && <button type="button" className="button button-outline full-button" disabled={busy} onClick={() => void saveDraftDetails()}>Save item details</button>}
                </section>
                {!draft ? (
                  <form className="scan-card-panel" onSubmit={startScan}>
                    <div className="panel-heading"><span className="step-number">02</span><div><h2>Full-item and 4K close-up capture</h2><p>The two route stages are the first and second halves of one level orbit, moving in the same direction. Interrupted route footage is saved so you can continue later.</p></div><span className="step-status">{completedCaptureStageCount}/{captureStages.length} stages captured</span></div>
                    <div className="capture-tips">
                      <span className="tip-icon">✳</span>
                      <div><strong>After the full-item routes, move close and capture every side in 4K.</strong><p>For the final stage, keep the camera close and slowly rotate or turn the item over to capture its entire surface. At least {MIN_DETAIL_FRAMES} sharp frames are required from the 4K original. Listings are blocked if the check fails. This capture target is intended to help record 0.5 mm defects; it does not guarantee they will be visible.</p></div>
                    </div>
                    <div className="surface-pass-list" aria-label="Full-surface routes and close-up capture stages">
                      {captureStages.map((sector, index) => {
                        const complete = videoClips.some((clip) => clip.sector === sector.id);
                        const active = activeSectorIndex === index && !complete;
                        return <div key={sector.id} className={`surface-pass ${active ? "active" : ""} ${complete ? "complete" : ""}`} aria-current={active ? "step" : undefined}><span>{complete ? "✓" : String(index + 1).padStart(2, "0")}</span>{sector.label}</div>;
                      })}
                    </div>
                    <div className="current-pass-tip"><strong>{activeCaptureStage?.label || "Required capture complete"}</strong><span>{cameraGuide}</span></div>
                    {(segmenterLoadProgress !== null || segmenterLoadStage === "runtime") && <div className="model-download-progress" role="status"><span>{segmenterLoadStage === "runtime" ? "Preparing the on-device vision runtime…" : segmenterLoadStage === "download" ? `Downloading the item selection model… ${segmenterLoadProgress}% of about 30 MB` : segmenterLoadStage === "verify" ? "Download reached 100%. Verifying the model…" : "Download verified. Initializing the model…"}</span>{segmenterLoadProgress !== null && <span className="counter-track"><i style={{ width: `${segmenterLoadProgress}%` }} /></span>}</div>}
                    {segmenterLoadError && <button type="button" className="button button-outline" onClick={() => { setSegmenterLoadError(""); setSegmenterLoadStage("runtime"); setSegmenterLoadProgress(null); segmenterInitializationStarted.current = true; workerRef.current?.postMessage({ type: "initialize" }); }}>Retry item selector download</button>}
                    <div className="photo-counter"><span className="counter-track"><i style={{ width: `${sectorProgress}%` }} /></span><span><strong>{sectorProgress}%</strong> {activeCaptureStage?.id === "detail" ? "close-up progress" : "route coverage"}</span></div>
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
                          }} role="button" tabIndex={0} aria-label="Tap the item you want to sell so it can be separated from the background">
                            {!objectSelection && <span className="camera-touch-prompt">Tap the item you want to sell</span>}
                            {objectSelection && <span className="selection-point" style={{ left: `${objectSelection.x * 100}%`, top: `${objectSelection.y * 100}%` }}><span>Selected point</span></span>}
                            {objectBounds && <span className="object-outline" style={{ left: `${objectBounds.left * 100}%`, top: `${objectBounds.top * 100}%`, width: `${(objectBounds.right - objectBounds.left) * 100}%`, height: `${(objectBounds.bottom - objectBounds.top) * 100}%` }} />}
                            <span className={`camera-guide ${objectBounds ? "detected" : ""}`}>{cameraGuide}</span>
                          </div>
                        </div>
                        <div className="camera-controls">
                          <button type="button" className="button button-outline" disabled={processingVideo || recording || !segmenterReady || !objectBounds || !orientationReady || brightness === null || brightness < DARKNESS_THRESHOLD || !activeCaptureStage || !detailCaptureReady} onClick={startRecording}>● {recording ? "Recording…" : activeCaptureStage?.id === "detail" ? "Start 4K close-up capture" : "Start route recording"}</button>
                          <button type="button" className="text-button" disabled={recording} onClick={stopCamera}>Close camera</button>
                        </div>
                        <p className="recording-indicator"><span className={torchEnabled ? "torch-on" : ""} />{recording ? `Recording · ${sectorProgress}% · ${cameraGuide}` : `Camera ${cameraSettings?.width || "?"}×${cameraSettings?.height || "?"} · Brightness ${brightness === null ? "checking" : Math.round(brightness)} · Flash ${torchSupported ? (torchEnabled ? "on" : "off") : "unsupported (bright light required)"} · Orientation ${orientationReady ? "ready" : "connecting"}`}</p>
                      </div>
                    )}
                    {cameraError && <p className="form-error">{cameraError}</p>}
                    <div className="capture-options">
                      <button type="button" className="capture-option" onClick={startCamera}>
                        <span className="capture-icon">◎</span><strong>{showCamera ? "Reconnect camera" : "Start guided live capture"}</strong><span>Camera and orientation access are required. The flash is enabled automatically on supported devices; otherwise, capture requires bright lighting.</span>
                      </button>
                    </div>
                    <div className="photo-counter"><span className="counter-track"><i style={{ width: `${Math.min((files.length / MIN_IMAGES) * 100, 100)}%` }} /></span><span><strong>{files.length}</strong> / {MIN_IMAGES}–{MAX_IMAGES} frames for 3D reconstruction</span></div>
                    {processingVideo && <div className="frame-processing"><span className="spinner" /> Checking videos for blur and duplicate views…</div>}
                    {frameReport && <p className="frame-report">{frameReport}</p>}
                    <div className="photo-grid">
                      {frames.map((frame, index) => {
                        const key = `${frame.file.name}:${frame.file.size}:${frame.file.lastModified}`;
                        return <div className="photo-thumb" key={key}><img src={previews[key]} alt={`Selected scan frame ${index + 1}`} /><span>{String(index + 1).padStart(2, "0")}</span><button type="button" aria-label={`Remove frame ${index + 1}`} onClick={() => removeFrame(index)}>×</button></div>;
                      })}
                    </div>
                    <div className="scan-disclosure"><span>ⓘ</span> Original route videos are sent to the server for reconstruction. Item selection and live frame analysis run on your device. Browsers do not show a separate flash permission prompt; flash support is checked through the camera.</div>
                    {formError && <p className="form-error">{formError}</p>}
                    <button className="button button-dark full-button" disabled={busy || processingVideo || recording || activeSectorIndex < captureStages.length || completedCaptureStageCount !== captureStages.length || files.length < MIN_IMAGES || !health?.reconstructionAvailable}>
                      {busy ? "Uploading videos to the server…" : !health?.reconstructionAvailable ? "GPU reconstruction engine unavailable" : `Reconstruct 3D from ${completedCaptureStageCount} capture stages and ${files.length} frames →`}
                    </button>
                    {!health?.reconstructionAvailable && <p className="engine-warning">{health?.colmapAvailable === false ? "COLMAP was not found." : ""}{health?.cudaAvailable === false ? " An NVIDIA GPU or nvidia-smi was not found." : ""}{health?.colmapCudaAvailable === false ? " The installed COLMAP build does not support CUDA." : ""} A CUDA-enabled COLMAP build and an NVIDIA GPU are required. Check the README setup instructions, then restart the server.</p>}
                  </form>
                ) : (
                  <div className="scan-card-panel">
                    <div className="panel-heading"><span className="step-number">02</span><div><h2>{draft.status === "ready" ? "Scan complete" : draft.status === "failed" ? "Scan failed" : "Reconstructing on server"}</h2><p>{draft.imageCount} images · {draft.id.slice(0, 8)}</p></div><span className={`scan-badge ${draft.status}`}>{draft.status === "ready" ? "RECONSTRUCTED" : draft.status.toUpperCase()}</span></div>
                    {(draft.status === "processing" || draft.status === "queued") && <div className="processing-state"><span className="spinner" /><div className="processing-details"><strong>{draft.status === "queued" ? "Your scan is queued." : "Computing the 3D surface from selected frames."}</strong><p>This may take several minutes or longer, depending on the server and number of frames. You can close the browser; progress will be saved.</p><div className="progress-heading"><span>Estimated progress by stage</span><strong>{draft.progressPercent ?? 0}%</strong></div><div className="progress-track" role="progressbar" aria-label={`3D reconstruction progress ${draft.progressPercent ?? 0}%`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={draft.progressPercent ?? 0}><span style={{ width: `${draft.progressPercent ?? 0}%` }} /></div><span className="process-stage">{draft.progress || "Waiting for server processing"}</span></div></div>}
                    {draft.status === "failed" && <div className="failure-state"><strong>These selected video frames did not produce a publishable 3D model.</strong><p>{draft.error}</p><p>Record again in even lighting, keeping the camera in focus as you move it slowly.</p><button type="button" className="button button-outline" onClick={() => { setDraft(null); clearFrames(); setMessage(""); }}>Start a new scan</button></div>}
                    {draft.status === "ready" && <><div className="draft-model"><ModelPreview src={modelSrc(draft)} /><span className="model-tag"><span>◉</span> High-density color 3D point cloud</span></div><div className="scan-disclosure"><span>ⓘ</span> Close-up photos are high-resolution source evidence. AI does not automatically identify every scratch or guarantee detection of 0.5 mm defects.</div>
                      <form className="listing-form" onSubmit={publish}>
                        <div className="originals-strip">{draft.images.slice(0, 8).map((image, index) => <img key={image} src={`/media/scans/${draft.id}/images/${encodeURIComponent(image)}`} alt={`Original scan image ${index + 1}`} />)}<span>{draft.imageCount} original scan images for item inspection</span></div>
                        <div className="detail-evidence"><h3>4K close-up surface photos · {draft.detailCount}</h3><p>Open at full resolution to inspect small surface marks.</p><div>{draft.details.map((frame, index) => <a key={frame.name} href={`/media/scans/${draft.id}/details/${encodeURIComponent(frame.name)}`} target="_blank" rel="noreferrer"><img src={`/media/scans/${draft.id}/details/${encodeURIComponent(frame.name)}`} alt={`Close-up surface photo ${index + 1}`} loading="lazy" /><span>{frame.width}×{frame.height}</span></a>)}</div></div>
                        {formError && <p className="form-error">{formError}</p>}
                        <button className="button button-dark full-button" disabled={busy}>{busy ? "Publishing…" : "Publish listing with completed 3D scan →"}</button>
                      </form>
                      <div className="video-evidence-grid seller-video-evidence">{draft.videos.map((video) => <figure key={video.name}><figcaption>{captureStages.find((stage) => stage.id === video.stage)?.label || video.stage}{video.name.includes("-part-") ? ` · Part ${video.name.match(/-part-(\d+)/)?.[1]}` : ""}</figcaption><video controls playsInline preload="metadata" src={`/media/scans/${draft.id}/videos/${encodeURIComponent(video.name)}`} /></figure>)}</div>
                      <button type="button" className="button button-outline full-button" disabled={busy} onClick={() => { setDraft(null); clearFrames(); setTitle(""); setPrice(""); setCategory("Electronics & cameras"); setDescription(""); setMessage(""); setFormError(""); }}>Scan another item</button>
                    </>}
                  </div>
                )}
              </div>
              <aside className="scan-sidebar">
                <div className="sidebar-card"><div className="eyebrow">SCAN QUALITY</div><h3>One level orbit<br />split into two parts</h3><ol className="quality-list"><li><span>01</span><div><strong>Tap the item to sell</strong><p>Tap the item in the camera view to track its area on your device.</p></div></li><li><span>02</span><div><strong>Keep it centered as you orbit</strong><p>Move smoothly around the item in one direction. The first and second stages cover the two halves of the same orbit.</p></div></li><li><span>03</span><div><strong>Rotate the item up close</strong><p>Record every side slowly in 4K, keeping the item large in frame.</p></div></li><li><span>04</span><div><strong>Verify source quality</strong><p>The server checks 4K resolution and focus, then saves sharp close-up frames.</p></div></li></ol></div>
                <div className="sidebar-note"><span>R.</span><p>0.5 mm is a capture design target, not a detection guarantee. If a defect is blurry, hidden, or missing from the source video, the model cannot reconstruct it.</p></div>
              </aside>
            </div>
          </section>
        )}

        <footer className="footer"><span className="footer-brand">REAL<span>RESALE</span></span><p>Look again. Choose well. © 2026 RealResale</p><span>Look closer. Buy better.</span></footer>
      </main>

      {message && <div className="toast" role="status"><span>✓</span>{message}<button onClick={() => setMessage("")} aria-label="Dismiss">×</button></div>}

      {selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <article className="listing-modal" role="dialog" aria-modal="true" aria-label={selected.title}>
            <button className="modal-close" onClick={() => setSelected(null)} aria-label="Close">×</button>
            <div className="modal-view"><ModelPreview src={modelSrc(selected.scan)} /></div>
            <div className="modal-content"><div className="listing-meta"><span>{displayCategory(selected.category)}</span><span>Platform-reconstructed · {selected.scan.imageCount} scan images</span></div><h2>{selected.title}</h2><strong className="modal-price">{money.format(selected.price)}</strong><p>{selected.description || "No item description."}</p><p className="seller-byline">Seller · {selected.seller?.username || "Legacy seller"}</p>
              <button className="button button-dark" onClick={() => void openListingConversation(selected)} disabled={!selected.seller || selected.seller.id === user?.id}>Send a private message to the seller</button>
              {messageError && <p className="form-error">{messageError}</p>}
              {activeConversation?.listingId === selected.id && <section className="chat-panel"><h3>{activeConversation.listingTitle} · Message with {activeConversation.otherUsername}</h3><div className="chat-messages">{chatMessages.map((chat) => <p key={chat.id} className={chat.senderId === user?.id ? "chat-message mine" : "chat-message"}><strong>{chat.senderUsername}</strong>{chat.body}</p>)}</div><form className="chat-compose" onSubmit={sendMessage}><input aria-label="Message" maxLength={2000} value={messageInput} onChange={(event) => setMessageInput(event.target.value)} placeholder="Message the seller" /><button className="button button-dark" disabled={!messageInput.trim()}>Send</button></form></section>}
              <div className="originals-heading"><strong>Original capture frames</strong><span>Inspect the item and 3D result from multiple angles.</span></div>
              <div className="modal-originals">{selected.scan.images.map((image, index) => <img key={image} src={`/media/scans/${selected.scan.id}/images/${encodeURIComponent(image)}`} alt={`${selected.title} original photo ${index + 1}`} loading="lazy" />)}</div>
              {selected.scan.details?.length > 0 && <div className="detail-evidence"><h3>4K close-up surface photos · {selected.scan.details.length}</h3><p>Open photos at full resolution to inspect them. These are not automated defect assessments.</p><div>{selected.scan.details.map((frame, index) => <a key={frame.name} href={`/media/scans/${selected.scan.id}/details/${encodeURIComponent(frame.name)}`} target="_blank" rel="noreferrer"><img src={`/media/scans/${selected.scan.id}/details/${encodeURIComponent(frame.name)}`} alt={`${selected.title} close-up surface photo ${index + 1}`} loading="lazy" /><span>{frame.width}×{frame.height}</span></a>)}</div></div>}
              {selected.scan.videos?.length > 0 && <div className="video-evidence"><h3>Full-item routes and close-up videos</h3><div className="video-evidence-grid">{selected.scan.videos.map((video) => <figure key={video.name}><figcaption>{captureStages.find((stage) => stage.id === video.stage)?.label || video.stage}{video.name.includes("-part-") ? ` · Part ${video.name.match(/-part-(\d+)/)?.[1]}` : ""}</figcaption><video controls playsInline preload="metadata" src={`/media/scans/${selected.scan.id}/videos/${encodeURIComponent(video.name)}`} /></figure>)}</div></div>}
            </div>
          </article>
        </div>
      )}

      {authOpen && (
        <div className="modal-backdrop auth-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className="auth-panel" role="dialog" aria-modal="true" aria-label={authMode === "register" ? "Create account" : "Sign in"}>
            <button className="modal-close" onClick={() => setAuthOpen(false)} aria-label="Close">×</button>
            <div className="eyebrow">REALRESALE ACCOUNT</div>
            <h2>{authMode === "register" ? "Create an account to get started." : "Welcome back."}</h2>
            <form className="auth-form" onSubmit={submitAuthentication}>
              <label>Username<input autoComplete="username" minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" required value={usernameInput} onChange={(event) => setUsernameInput(event.target.value)} /></label>
              <label>Password<input autoComplete={authMode === "register" ? "new-password" : "current-password"} type="password" minLength={10} maxLength={128} required value={passwordInput} onChange={(event) => setPasswordInput(event.target.value)} /></label>
              {authError && <p className="form-error">{authError}</p>}
              <button className="button button-dark full-button">{authMode === "register" ? "Create account" : "Sign in"}</button>
            </form>
            <button className="text-button auth-switch" onClick={() => { setAuthMode(authMode === "register" ? "login" : "register"); setAuthError(""); }}>{authMode === "register" ? "Already have an account? Sign in" : "Need an account? Register"}</button>
            <p className="auth-disclaimer">This MVP uses local username and password accounts. Email verification and password recovery are not available.</p>
          </section>
        </div>
      )}

      {inboxOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInboxOpen(false); }}>
          <section className="inbox-panel" role="dialog" aria-modal="true" aria-label="Inbox">
            <button className="modal-close" onClick={() => setInboxOpen(false)} aria-label="Close">×</button>
            <div className="eyebrow">PRIVATE MESSAGES</div><h2>Inbox</h2>
            {messageError && <p className="form-error">{messageError}</p>}
            {inbox.length === 0 ? <p className="inbox-empty">No conversations yet. Open a listing to message its seller.</p> : <div className="inbox-list">{inbox.map((conversation) => <button key={conversation.id} className={`inbox-item ${activeConversation?.id === conversation.id ? "active" : ""}`} onClick={() => void openConversationFromInbox(conversation)}><strong>{conversation.listingTitle}</strong><span>{conversation.otherUsername}</span><small>{conversation.lastMessage || "Start a conversation"}</small></button>)}</div>}
            {activeConversation && <section className="chat-panel"><h3>{activeConversation.listingTitle} · {activeConversation.otherUsername}</h3><div className="chat-messages">{chatMessages.map((chat) => <p key={chat.id} className={chat.senderId === user?.id ? "chat-message mine" : "chat-message"}><strong>{chat.senderUsername}</strong>{chat.body}</p>)}</div><form className="chat-compose" onSubmit={sendMessage}><input aria-label="Message" maxLength={2000} value={messageInput} onChange={(event) => setMessageInput(event.target.value)} placeholder="Write a message" /><button className="button button-dark" disabled={!messageInput.trim()}>Send</button></form></section>}
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
