import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { promisify } from "node:util";
import { measureLaplacianVariance } from "./src/scan-guidance.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, "data");
const incomingDir = path.join(dataDir, "incoming");
const scanDir = path.join(dataDir, "scans");
const distDir = path.join(root, "dist");
const databasePath = process.env.DATABASE_PATH || path.join(dataDir, "realresale.sqlite");
const port = Number(process.env.PORT || 3001);
const httpsKeyPath = process.env.REALRESALE_HTTPS_KEY;
const httpsCertPath = process.env.REALRESALE_HTTPS_CERT;
const colmapPath = process.env.COLMAP_PATH || "colmap";
const videoSectors = ["route-a", "route-b"];
const detailVideoStage = "detail";
const requiredVideoStages = [...videoSectors, detailVideoStage];
const maxScansInFlight = 1;
const maxQueuedScans = 1;
const minImageCount = 24;
const minFramesPerSector = minImageCount / videoSectors.length;
const maxImageCount = 80;
const minDetailFrames = 20;
const maxDetailFrames = 40;
const minDetailResolution = 3840;
const minDetailVideoSeconds = 20;
const maxDetailVideoSeconds = 30;
const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const idPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const maxScanBytes = 512 * 1024 * 1024;
const maxVideoSeconds = 45;
const maxTotalVideoSeconds = 90;
const scryptAsync = promisify(crypto.scrypt);
const sessionCookieName = "realresale_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

await fs.mkdir(incomingDir, { recursive: true });
await fs.mkdir(scanDir, { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
    image_count INTEGER NOT NULL,
    images_json TEXT NOT NULL,
    progress TEXT,
    progress_percent INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    videos_json TEXT NOT NULL DEFAULT '[]',
    details_json TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '기타',
    price INTEGER NOT NULL DEFAULT 0,
    owner_user_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL UNIQUE REFERENCES scans(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL CHECK (price >= 0),
    seller_user_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (listing_id, buyer_user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const scanColumns = db.prepare("PRAGMA table_info(scans)").all();
const scanMigrations = [
  ["progress_percent", "INTEGER NOT NULL DEFAULT 0"],
  ["videos_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["details_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["title", "TEXT NOT NULL DEFAULT ''"],
  ["description", "TEXT NOT NULL DEFAULT ''"],
  ["category", "TEXT NOT NULL DEFAULT '기타'"],
  ["price", "INTEGER NOT NULL DEFAULT 0"],
  ["owner_user_id", "TEXT REFERENCES users(id)"],
];
for (const [name, declaration] of scanMigrations) {
  if (!scanColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE scans ADD COLUMN ${name} ${declaration}`);
  }
}
const listingColumns = db.prepare("PRAGMA table_info(listings)").all();
if (!listingColumns.some((column) => column.name === "seller_user_id")) {
  db.exec("ALTER TABLE listings ADD COLUMN seller_user_id TEXT REFERENCES users(id)");
}
const listedScans = db.prepare(`
  SELECT s.*, EXISTS(SELECT 1 FROM listings AS l WHERE l.scan_id = s.id) AS listed
  FROM scans AS s
  ORDER BY s.created_at DESC, s.rowid DESC
  LIMIT 20
`);

db.prepare(`
  UPDATE scans
  SET status = 'failed',
      progress = NULL,
      error = '서버가 다시 시작되어 이전 스캔이 중단됐어요. 새 스캔을 시작해 주세요.'
  WHERE status IN ('queued', 'processing')
`).run();

const colmapCheck = spawnSync(colmapPath, ["-h"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 10000,
});
const colmapAvailable = !colmapCheck.error && colmapCheck.status === 0;
const nvidiaSmiCheck = spawnSync("nvidia-smi", ["-L"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 10000,
});
const cudaAvailable =
  !nvidiaSmiCheck.error && nvidiaSmiCheck.status === 0 && nvidiaSmiCheck.stdout.trim().length > 0;
const colmapCudaAvailable =
  colmapAvailable && /with CUDA\b/i.test(`${colmapCheck.stdout || ""}\n${colmapCheck.stderr || ""}`);
const reconstructionAvailable = colmapAvailable && cudaAvailable && colmapCudaAvailable;
if (!reconstructionAvailable) {
  console.warn(
    `3D scanning is unavailable. COLMAP detected: ${colmapAvailable}; NVIDIA CUDA GPU detected: ${cudaAvailable}; CUDA-enabled COLMAP detected: ${colmapCudaAvailable}.`,
  );
}

const app = express();
app.set("trust proxy", false);
app.disable("x-powered-by");
const configuredOrigins = new Set(
  (process.env.REALRESALE_APP_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean),
);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.get("origin");
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const hostname = originUrl.hostname;
        const sameHost = originUrl.host === req.get("host");
        const loopback =
          hostname === "localhost" ||
          hostname === "127.0.0.1" ||
          hostname === "[::1]";
        if (!sameHost && !loopback && !configuredOrigins.has(originUrl.origin)) {
          res.status(403).json({ error: "허용된 RealResale 주소에서만 요청할 수 있어요." });
          return;
        }
      } catch {
        res.status(403).json({ error: "요청 출처를 확인할 수 없어요." });
        return;
      }
    }
  }
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use((req, _res, next) => {
  const cookie = req.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));
  const token = cookie?.slice(sessionCookieName.length + 1);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const session = db.prepare(`
      SELECT u.id, u.username
      FROM auth_sessions AS a
      INNER JOIN users AS u ON u.id = a.user_id
      WHERE a.token_hash = ? AND a.expires_at > ?
    `).get(tokenHash, Date.now());
    if (session) req.authUser = { id: session.id, username: session.username };
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.authUser) {
    res.status(401).json({ error: "계정에 로그인한 뒤 이용해 주세요." });
    return;
  }
  next();
}

function setSessionCookie(req, res, token) {
  const secure = process.env.NODE_ENV === "production" || req.get("origin")?.startsWith("https://");
  res.append(
    "Set-Cookie",
    `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeMs / 1000}${secure ? "; Secure" : ""}`,
  );
}

function clearSessionCookie(req, res) {
  const secure = process.env.NODE_ENV === "production" || req.get("origin")?.startsWith("https://");
  res.append(
    "Set-Cookie",
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}

async function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(password, salt, 64, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return { salt, hash: derivedKey.toString("hex") };
}

async function verifyPassword(password, salt, expectedHash) {
  const derivedKey = await scryptAsync(password, salt, 64, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey);
}

function issueSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    crypto.createHash("sha256").update(token).digest("hex"),
    userId,
    Date.now() + sessionLifetimeMs,
  );
  setSessionCookie(req, res, token);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, incomingDir),
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
  }),
  limits: { files: maxImageCount, fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!supportedImageTypes.has(file.mimetype)) {
      callback(new Error("JPEG, PNG, WebP 또는 AVIF 이미지만 스캔할 수 있어요."));
      return;
    }
    callback(null, true);
  },
});
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, incomingDir),
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
  }),
  limits: { files: requiredVideoStages.length, fileSize: maxScanBytes },
  fileFilter: (_req, file, callback) => {
    const supportedType = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"].includes(file.mimetype);
    const supportedExtension = /\.(mov|mp4|m4v|webm)$/i.test(file.originalname);
    if (!supportedType && !supportedExtension) {
      callback(new Error("MOV, MP4, M4V 또는 WebM 동영상만 사용할 수 있어요."));
      return;
    }
    callback(null, true);
  },
});

async function removeTemporaryPaths(paths) {
  const results = await Promise.allSettled(
    paths.map((filePath) =>
      fs.rm(filePath, {
        force: true,
        recursive: true,
        maxRetries: 8,
        retryDelay: 250,
      }),
    ),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(`Could not remove temporary upload data at ${paths[index]}:`, result.reason);
    }
  });
}

function cleanupUploads(files) {
  return removeTemporaryPaths(files.map((file) => file.path));
}

function isWindowsFileLockError(error) {
  return process.platform === "win32" && ["EBUSY", "EPERM", "EACCES"].includes(error?.code);
}

async function copyUploadedFile(source, destination, expectedSize) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      const copiedFile = await fs.stat(destination);
      if (copiedFile.size !== expectedSize) {
        await removeTemporaryPaths([destination]);
        throw new Error("업로드된 사진을 스캔 저장소에 완전히 복사하지 못했어요.");
      }
      return;
    } catch (error) {
      if (!isWindowsFileLockError(error) || attempt >= 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const getScan = db.prepare("SELECT * FROM scans WHERE id = ?");
const listingList = db.prepare(`
  SELECT l.*, s.id AS scan_id, s.image_count, s.images_json, s.videos_json, s.details_json,
         u.username AS seller_username
  FROM listings AS l
  INNER JOIN scans AS s ON s.id = l.scan_id
  LEFT JOIN users AS u ON u.id = l.seller_user_id
  WHERE s.status = 'ready'
  ORDER BY l.created_at DESC, l.rowid DESC
`);

function publicScan(row) {
  const videos = JSON.parse(row.videos_json || "[]");
  const details = JSON.parse(row.details_json || "[]");
  return {
    id: row.id,
    status: row.status,
    imageCount: row.image_count,
    images: JSON.parse(row.images_json),
    listed: Boolean(row.listed),
    progress: row.progress,
    progressPercent: row.progress_percent,
    videos,
    videoCount: videos.length,
    details,
    detailCount: details.length,
    title: row.title,
    description: row.description,
    category: row.category,
    price: row.price,
    error: row.error,
    createdAt: row.created_at,
  };
}

function runFfmpeg(args, description, timeout = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let spawnError;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${description} 단계가 제한 시간 안에 끝나지 않았어요.`));
    }, timeout);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (spawnError) {
        reject(new Error(`동영상 처리 프로그램을 실행할 수 없어요: ${spawnError.message}`));
      } else if (code !== 0) {
        const details = stderr.split(/\r?\n/).filter(Boolean).slice(-5).join(" ");
        reject(new Error(`${description}에 실패했어요.${details ? ` ${details}` : ""}`));
      } else {
        resolve(stderr);
      }
    });
  });
}

async function getVideoDuration(filePath) {
  const metadata = await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", filePath], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.on("error", reject);
    child.on("close", () => resolve(stderr));
  });
  const duration = metadata.match(/Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/);
  if (!duration) throw new Error("동영상 길이를 읽지 못했어요. 재생 가능한 MOV, MP4 또는 WebM인지 확인해 주세요.");
  return Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
}

function isServerError(error) {
  const code = error?.code;
  return (
    typeof code === "string" &&
    (code.startsWith("SQLITE_") || (/^E[A-Z]+$/.test(code) && !code.startsWith("ERR_")))
  );
}

async function runColmap(
  args,
  stepName,
  timeout = 45 * 60 * 1000,
  progress = { start: 0, end: 0 },
) {
  await setProgress(args.scanId, stepName, progress.start);
  const commandArgs = args.command;

  await new Promise((resolve, reject) => {
    const child = spawn(colmapPath, commandArgs, {
      cwd: args.cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let spawnError;
    let checkingProgress = false;
    const progressTimer = progress.directory && progress.expectedFiles
      ? setInterval(async () => {
          if (checkingProgress) return;
          checkingProgress = true;
          try {
            const entries = await fs.readdir(progress.directory, { withFileTypes: true });
            const completed = entries.filter(
              (entry) => entry.isFile() && entry.name.endsWith(".geometric.bin"),
            ).length;
            const percent = Math.min(
              progress.end,
              progress.start + Math.floor((completed / progress.expectedFiles) * (progress.end - progress.start)),
            );
            if (percent > progress.start) await setProgress(args.scanId, stepName, percent);
          } catch (error) {
            console.warn(`Could not measure scan progress in ${progress.directory}:`, error);
          } finally {
            checkingProgress = false;
          }
        }, 1500)
      : null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${stepName} 단계가 45분 안에 끝나지 않았어요. 사진 수를 줄여 다시 시도해 주세요.`));
    }, timeout);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      if (spawnError) {
        reject(new Error(`COLMAP을 실행할 수 없습니다: ${spawnError.message}`));
      } else if (code !== 0) {
        const details = stderr.split(/\r?\n/).filter(Boolean).slice(-8).join(" ");
        const cudaHint = /cuda|gpu|patch.?match/i.test(details)
          ? " PatchMatchStereo의 GPU/CUDA 지원을 확인해 주세요."
          : "";
        reject(
          new Error(
            `${stepName} 단계에 실패했습니다.${cudaHint}${details ? ` ${details}` : ` (종료 코드 ${code ?? signal})`}`,
          ),
        );
      } else {
        setProgress(args.scanId, stepName, progress.end).then(resolve, reject);
      }
    });
  });
}

async function setProgress(scanId, progress, progressPercent) {
  db.prepare("UPDATE scans SET status = 'processing', progress = ?, progress_percent = ?, error = NULL WHERE id = ?").run(
    progress,
    Math.max(0, Math.min(100, Math.round(progressPercent))),
    scanId,
  );
}

const jobQueue = [];
let runningJobs = 0;

function scheduleScan(scanId) {
  jobQueue.push(scanId);
  void drainQueue();
}

async function drainQueue() {
  if (runningJobs >= maxScansInFlight) return;
  const scanId = jobQueue.shift();
  if (!scanId) return;
  runningJobs += 1;

  try {
    await reconstructScan(scanId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 재구성 오류가 발생했어요.";
    console.error(`3D reconstruction failed for scan ${scanId}:`, message);
    db.prepare("UPDATE scans SET status = 'failed', progress = NULL, error = ? WHERE id = ?").run(
      message.slice(0, 1600),
      scanId,
    );
  } finally {
    runningJobs -= 1;
    void drainQueue();
  }
}

async function extractVideoFrames(scanId, directory, videos) {
  if (!ffmpegPath) throw new Error("동영상 처리를 위한 FFmpeg 실행 파일을 찾을 수 없어요.");
  const videoDirectory = path.join(directory, "videos");
  const extractedDirectory = path.join(directory, "extracted");
  const imagesDirectory = path.join(directory, "images");
  await fs.mkdir(extractedDirectory, { recursive: true });
  await fs.mkdir(imagesDirectory, { recursive: true });
  await setProgress(scanId, "두 전체 경로와 근접 세부 영상 분석", 2);

  const durations = new Map();
  for (const video of videos) {
    const duration = await getVideoDuration(path.join(videoDirectory, video.name));
    const minimumDuration = video.stage === detailVideoStage ? minDetailVideoSeconds : 3;
    const maximumDuration = video.stage === detailVideoStage ? maxDetailVideoSeconds : maxVideoSeconds;
    if (duration < minimumDuration || duration > maximumDuration + (video.stage === detailVideoStage ? 1 : 0)) {
      throw new Error(
        video.stage === detailVideoStage
          ? `근접 세부 영상은 ${minDetailVideoSeconds}~${maxDetailVideoSeconds}초로 촬영해 주세요.`
          : `${video.stage} 영상은 3~${maxVideoSeconds}초로 촬영해 주세요.`,
      );
    }
    durations.set(video.stage, duration);
  }
  const routeDuration = videoSectors.reduce((total, stage) => total + (durations.get(stage) || 0), 0);
  if (routeDuration > maxTotalVideoSeconds) {
    throw new Error("두 이동 경로의 전체 촬영 시간이 제한을 넘었습니다. 경로 영상을 다시 확인하세요.");
  }

  const imageNames = [];
  const routeVideos = videos.filter((video) => videoSectors.includes(video.stage));
  for (let index = 0; index < routeVideos.length; index += 1) {
    const video = routeVideos[index];
    const sectorImageStart = imageNames.length;
    const frameLimit = Math.floor(maxImageCount / routeVideos.length);
    const fps = Math.min(1.5, frameLimit / durations.get(video.stage));
    const stageDirectory = path.join(extractedDirectory, video.stage);
    await fs.mkdir(stageDirectory, { recursive: true });
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path.join(videoDirectory, video.name),
        "-vf",
        `fps=${fps.toFixed(5)},scale=3840:3840:force_original_aspect_ratio=decrease`,
        "-frames:v",
        String(frameLimit),
        "-q:v",
        "2",
        path.join(stageDirectory, "%03d.jpg"),
        "-y",
      ],
      `${video.stage} 촬영 영상의 선명한 프레임 추출`,
    );
    const frameFiles = (await fs.readdir(stageDirectory))
      .filter((name) => /^\d{3}\.jpg$/.test(name))
      .sort((left, right) => Number(path.parse(left).name) - Number(path.parse(right).name));
    for (const filename of frameFiles) {
      const imagePath = path.join(stageDirectory, filename);
      const metadata = await sharp(imagePath).metadata();
      if (!metadata.width || !metadata.height || Math.min(metadata.width, metadata.height) < 600) {
        continue;
      }
      const outputName = `${String(imageNames.length + 1).padStart(3, "0")}.jpg`;
      await fs.copyFile(imagePath, path.join(imagesDirectory, outputName));
      imageNames.push(outputName);
    }
    const sectorImageCount = imageNames.length - sectorImageStart;
    if (sectorImageCount < minFramesPerSector) {
      throw new Error(
        `${video.stage} 이동 경로에서 유효한 프레임을 ${sectorImageCount}장만 추출했어요. 각 경로에서 최소 ${minFramesPerSector}장이 필요합니다.`,
      );
    }
    await setProgress(
      scanId,
      `${video.stage} 이동 경로의 프레임을 검사`,
      Math.min(20, 2 + Math.floor(((index + 1) / routeVideos.length) * 18)),
    );
  }

  if (imageNames.length < minImageCount) {
    throw new Error(
      `두 이동 경로에서 유효한 프레임 ${imageNames.length}장만 추출했어요. 최소 ${minImageCount}장이 필요합니다.`,
    );
  }
  db.prepare("UPDATE scans SET image_count = ?, images_json = ? WHERE id = ?").run(
    imageNames.length,
    JSON.stringify(imageNames),
    scanId,
  );

  const detailVideo = videos.find((video) => video.stage === detailVideoStage);
  if (!detailVideo) {
    throw new Error("상품의 미세한 상태를 확인할 근접 세부 영상이 필요해요.");
  }
  const detailDirectory = path.join(directory, "details");
  const extractedDetailsDirectory = path.join(directory, "detail-extracted");
  await fs.mkdir(detailDirectory, { recursive: true });
  await fs.mkdir(extractedDetailsDirectory, { recursive: true });
  await setProgress(scanId, "4K 근접 세부 프레임의 해상도와 초점을 검사", 23);
  await runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path.join(videoDirectory, detailVideo.name),
      "-vf",
      "fps=1.5",
      "-frames:v",
      String(maxDetailFrames),
      "-q:v",
      "1",
      path.join(extractedDetailsDirectory, "%03d.jpg"),
      "-y",
    ],
    "근접 세부 영상에서 고해상도 프레임 추출",
  );
  const detailFiles = (await fs.readdir(extractedDetailsDirectory))
    .filter((name) => /^\d{3}\.jpg$/.test(name))
    .sort((left, right) => Number(path.parse(left).name) - Number(path.parse(right).name));
  const detailCandidates = [];
  for (const filename of detailFiles) {
    const sourcePath = path.join(extractedDetailsDirectory, filename);
    const metadata = await sharp(sourcePath).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      Math.max(metadata.width, metadata.height) < minDetailResolution
    ) {
      continue;
    }
    const { data, info } = await sharp(sourcePath)
      .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sharpness = measureLaplacianVariance(data, info.width, info.height);
    detailCandidates.push({ filename, sourcePath, width: metadata.width, height: metadata.height, sharpness });
  }
  if (detailCandidates.length < minDetailFrames) {
    throw new Error(
      `근접 영상에서 ${minDetailResolution}px 이상 원본 프레임을 ${minDetailFrames}장 확보하지 못했어요. 카메라의 4K 촬영 설정과 초점을 확인해 다시 촬영하세요.`,
    );
  }
  const sortedSharpness = detailCandidates.map((frame) => frame.sharpness).sort((left, right) => left - right);
  const sharpnessThreshold = Math.max(12, sortedSharpness[Math.floor((sortedSharpness.length - 1) * 0.2)] * 0.35);
  const selectedDetails = detailCandidates.filter((frame) => frame.sharpness >= sharpnessThreshold);
  if (selectedDetails.length < minDetailFrames) {
    throw new Error(
      `초점이 선명한 4K 근접 프레임이 ${minDetailFrames}장 미만이에요. 조명을 밝히고 카메라를 천천히 움직여 다시 촬영하세요.`,
    );
  }
  const detailRecords = [];
  for (const [index, frame] of selectedDetails.entries()) {
    const name = `${String(index + 1).padStart(3, "0")}.jpg`;
    await fs.copyFile(frame.sourcePath, path.join(detailDirectory, name));
    detailRecords.push({ name, width: frame.width, height: frame.height });
  }
  await fs.rm(extractedDetailsDirectory, { recursive: true, force: true });
  db.prepare("UPDATE scans SET details_json = ? WHERE id = ?").run(
    JSON.stringify(detailRecords),
    scanId,
  );
  await setProgress(scanId, "고해상도 근접 결함 증거를 저장", 25);
}

async function reconstructScan(scanId) {
  const directory = path.join(scanDir, scanId);
  const imagesDir = path.join(directory, "images");
  const workDir = path.join(directory, "colmap");
  const sparseDir = path.join(workDir, "sparse");
  const denseDir = path.join(workDir, "dense");
  const databasePath = path.join(workDir, "database.db");
  let imageRows = publicScan(getScan.get(scanId));

  if (imageRows.videoCount > 0) {
    await extractVideoFrames(scanId, directory, imageRows.videos);
    imageRows = publicScan(getScan.get(scanId));
  }

  if (!reconstructionAvailable) {
    throw new Error("서버에서 COLMAP을 찾을 수 없어요. COLMAP을 설치한 뒤 서버를 다시 시작해 주세요.");
  }

  await fs.mkdir(imagesDir, { recursive: true });
  await fs.mkdir(sparseDir, { recursive: true });
  await fs.mkdir(denseDir, { recursive: true });

  await setProgress(scanId, "추출한 고해상도 프레임 정규화", 25);
  for (let index = 0; index < imageRows.images.length; index += 1) {
    const filename = imageRows.images[index];
    await sharp(path.join(directory, filename), { limitInputPixels: 70_000_000 })
      .rotate()
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toFile(path.join(imagesDir, `${String(index).padStart(3, "0")}.jpg`));
    await setProgress(
      scanId,
      "추출한 고해상도 프레임 정규화",
      25 + Math.floor(((index + 1) / imageRows.images.length) * 8),
    );
  }
  await setProgress(scanId, "3D 특징점과 카메라 정보 분석", 33);

  const base = { cwd: workDir, scanId };
  await runColmap(
    {
      ...base,
      command: [
        "feature_extractor",
        "--database_path",
        databasePath,
        "--image_path",
        imagesDir,
        "--ImageReader.single_camera",
        "1",
        "--ImageReader.camera_model",
        "SIMPLE_RADIAL",
        "--FeatureExtraction.max_image_size",
        "4096",
        "--FeatureExtraction.use_gpu",
        "1",
      ],
    },
    "사진의 특징점과 카메라 위치 분석",
    45 * 60 * 1000,
    { start: 33, end: 43 },
  );
  await runColmap(
    {
      ...base,
      command: ["exhaustive_matcher", "--database_path", databasePath, "--FeatureMatching.use_gpu", "1"],
    },
    "겹쳐 찍은 사진들의 연결 확인",
    45 * 60 * 1000,
    { start: 43, end: 53 },
  );
  await runColmap(
    { ...base, command: ["mapper", "--database_path", databasePath, "--image_path", imagesDir, "--output_path", sparseDir] },
    "촬영된 사진으로 3D 카메라 위치 계산",
    45 * 60 * 1000,
    { start: 53, end: 63 },
  );

  const sparseModels = (await fs.readdir(sparseDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => Number(left.name) - Number(right.name));
  if (sparseModels.length === 0) {
    throw new Error("겹치는 특징점을 충분히 찾지 못했어요. 선명한 사진을 여러 각도에서 다시 찍어 주세요.");
  }
  let sparseModel;
  let registeredImageCount = 0;
  for (let candidateIndex = 0; candidateIndex < sparseModels.length; candidateIndex += 1) {
    const candidate = sparseModels[candidateIndex];
    const candidateModel = path.join(sparseDir, candidate.name);
    const candidateTextDir = path.join(workDir, "sparse-text", candidate.name);
    await fs.mkdir(candidateTextDir, { recursive: true });
    await runColmap(
      {
        ...base,
        command: [
          "model_converter",
          "--input_path",
          candidateModel,
          "--output_path",
          candidateTextDir,
          "--output_type",
          "TXT",
        ],
      },
      "각 3D 후보에 연결된 사진 수 확인",
      45 * 60 * 1000,
      {
        start: 63 + Math.floor((candidateIndex / sparseModels.length) * 5),
        end: 63 + Math.floor(((candidateIndex + 1) / sparseModels.length) * 5),
      },
    );
    const registeredImagesText = await fs.readFile(path.join(candidateTextDir, "images.txt"), "utf8");
    const candidateImageCount = registeredImagesText
      .split(/\r?\n/)
      .filter((line) => {
        const columns = line.trim().split(/\s+/);
        return columns.length === 10 && /^\d+$/.test(columns[0]) && /^\d{3}\.jpg$/.test(columns[9]);
      })
      .length;
    if (candidateImageCount > registeredImageCount) {
      sparseModel = candidateModel;
      registeredImageCount = candidateImageCount;
    }
  }

  if (!sparseModel) {
    throw new Error("사진에서 3D 카메라 위치를 검증할 수 없어요. 여러 각도에서 선명한 사진을 다시 찍어 주세요.");
  }
  const requiredImageCount = Math.ceil(imageRows.images.length * 0.7);
  if (registeredImageCount < requiredImageCount) {
    throw new Error(
      `사진 ${imageRows.images.length}장 중 ${registeredImageCount}장만 3D 공간에 연결됐어요. 최소 ${requiredImageCount}장이 필요하므로 촬영 방향과 사진 간 겹치는 영역을 확인해 주세요.`,
    );
  }

  await runColmap(
    { ...base, command: ["image_undistorter", "--image_path", imagesDir, "--input_path", sparseModel, "--output_path", denseDir, "--output_type", "COLMAP", "--max_image_size", "4096"] },
    "고해상도 사진을 3D 공간에 정렬",
    45 * 60 * 1000,
    { start: 68, end: 74 },
  );
  await runColmap(
    { ...base, command: ["patch_match_stereo", "--workspace_path", denseDir, "--workspace_format", "COLMAP", "--PatchMatchStereo.geom_consistency", "true"] },
    "여러 각도에서 표면 깊이와 색상 복원",
    90 * 60 * 1000,
    {
      start: 74,
      end: 90,
      directory: path.join(denseDir, "stereo", "depth_maps"),
      expectedFiles: registeredImageCount,
    },
  );
  const fusedPath = path.join(denseDir, "fused.ply");
  await runColmap(
    { ...base, command: ["stereo_fusion", "--workspace_path", denseDir, "--workspace_format", "COLMAP", "--input_type", "geometric", "--output_path", fusedPath] },
    "색상이 포함된 3D 점군 생성",
    45 * 60 * 1000,
    { start: 90, end: 96 },
  );
  await setProgress(scanId, "고밀도 컬러 3D 표면을 확인", 96);
  const modelPath = path.join(directory, "model.ply");
  await fs.copyFile(fusedPath, modelPath, fs.constants.COPYFILE_EXCL);

  const modelStat = await fs.stat(modelPath);
  if (modelStat.size < 1_000_000) {
    throw new Error("컬러 3D 점군이 충분히 복원되지 않아 등록할 수 없어요. 모든 면을 더 선명하게 촬영해 주세요.");
  }
  const modelFile = await fs.open(modelPath, "r");
  const headerBuffer = Buffer.alloc(8192);
  let headerLength;
  try {
    ({ bytesRead: headerLength } = await modelFile.read(headerBuffer, 0, headerBuffer.length, 0));
  } finally {
    await modelFile.close();
  }
  const modelHeader = headerBuffer.subarray(0, headerLength).toString("ascii");
  const vertices = Number(modelHeader.match(/element vertex (\d+)/)?.[1] || 0);
  const hasColor = /\bproperty uchar red\b/.test(modelHeader) &&
    /\bproperty uchar green\b/.test(modelHeader) &&
    /\bproperty uchar blue\b/.test(modelHeader);
  if (!modelHeader.startsWith("ply") || vertices < 20_000 || !hasColor) {
    throw new Error("실제 색상 정보가 포함된 고밀도 3D 점군이 완성되지 않았어요. 촬영 영상을 다시 확인해 주세요.");
  }

  await setProgress(scanId, "색상 포함 3D 결과 검증 완료", 99);
  db.prepare("UPDATE scans SET status = 'ready', progress = NULL, progress_percent = 100, error = NULL WHERE id = ?").run(scanId);
}

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.authUser || null });
});

app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_]{3,24}$/.test(username) ||
    typeof password !== "string" ||
    Buffer.byteLength(password, "utf8") < 10 ||
    Buffer.byteLength(password, "utf8") > 128
  ) {
    res.status(400).json({ error: "사용자명은 영문·숫자·밑줄 3~24자, 비밀번호는 10~128바이트로 입력해 주세요." });
    return;
  }
  const { salt, hash } = await createPasswordRecord(password);
  const userId = crypto.randomUUID();
  try {
    db.prepare("INSERT INTO users (id, username, password_salt, password_hash) VALUES (?, ?, ?, ?)").run(
      userId,
      username,
      salt,
      hash,
    );
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      res.status(409).json({ error: "이미 사용 중인 사용자명이에요." });
      return;
    }
    throw error;
  }
  issueSession(req, res, userId);
  res.status(201).json({ user: { id: userId, username } });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    Buffer.byteLength(password, "utf8") > 128
  ) {
    res.status(400).json({ error: "사용자명과 비밀번호를 확인해 주세요." });
    return;
  }
  const account = db.prepare("SELECT id, username, password_salt, password_hash FROM users WHERE username = ? COLLATE NOCASE").get(username);
  const valid = account
    ? await verifyPassword(password, account.password_salt, account.password_hash)
    : false;
  if (!valid) {
    res.status(401).json({ error: "사용자명 또는 비밀번호가 올바르지 않아요." });
    return;
  }
  issueSession(req, res, account.id);
  res.json({ user: { id: account.id, username: account.username } });
});

app.post("/api/auth/logout", (req, res) => {
  if (req.authUser) {
    const cookie = req.get("cookie")?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${sessionCookieName}=`));
    const token = cookie?.slice(sessionCookieName.length + 1);
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(
        crypto.createHash("sha256").update(token).digest("hex"),
      );
    }
  }
  clearSessionCookie(req, res);
  res.status(204).end();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    videoProcessingAvailable: Boolean(ffmpegPath),
    colmapAvailable,
    cudaAvailable,
    colmapCudaAvailable,
    reconstructionAvailable,
    activeScans: runningJobs,
    queuedScans: jobQueue.length,
    minImages: minImageCount,
    maxImages: maxImageCount,
    requiredCaptureSectors: videoSectors,
    requiredCaptureStages: requiredVideoStages,
    minDetailFrames,
    minDetailResolution,
    maxVideoSeconds,
    maxTotalVideoSeconds: maxTotalVideoSeconds + maxDetailVideoSeconds,
  });
});

app.get("/api/listings", (_req, res) => {
  const listings = listingList.all().map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    price: row.price,
    createdAt: row.created_at,
    seller: row.seller_user_id ? { id: row.seller_user_id, username: row.seller_username } : null,
    scan: {
      id: row.scan_id,
      status: "ready",
      imageCount: row.image_count,
      images: JSON.parse(row.images_json),
      videos: JSON.parse(row.videos_json || "[]"),
      details: JSON.parse(row.details_json || "[]"),
    },
  }));
  res.json({ listings });
});

app.get("/api/scans", (req, res) => {
  const scans = req.authUser
    ? db.prepare(`
        SELECT s.*, EXISTS(SELECT 1 FROM listings AS l WHERE l.scan_id = s.id) AS listed
        FROM scans AS s
        WHERE s.owner_user_id = ?
        ORDER BY s.created_at DESC, s.rowid DESC
        LIMIT 20
      `).all(req.authUser.id).map(publicScan)
    : [];
  res.json({ scans });
});

app.post("/api/scans", requireAuth, (req, res, next) => {
  const contentLength = Number(req.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxScanBytes) {
    res.status(413).json({ error: "스캔 사진 전체 용량은 512MB 이하여야 해요." });
    return;
  }
  upload.array("images", maxImageCount)(req, res, async (uploadError) => {
    if (uploadError) {
      await cleanupUploads(req.files || []);
      next(uploadError);
      return;
    }

    const files = req.files || [];
    if (files.length < minImageCount) {
      await cleanupUploads(files);
      res.status(400).json({ error: `서버 재구성에는 최소 ${minImageCount}장의 사진이 필요해요. 현재 ${files.length}장입니다.` });
      return;
    }
    if (files.reduce((total, file) => total + file.size, 0) > maxScanBytes) {
      await cleanupUploads(files);
      res.status(413).json({ error: "스캔 사진 전체 용량은 512MB 이하여야 해요." });
      return;
    }
    if (runningJobs + jobQueue.length >= maxScansInFlight + maxQueuedScans) {
      await cleanupUploads(files);
      res.status(503).json({ error: "현재 재구성 작업이 가득 찼어요. 잠시 후 다시 시도해 주세요." });
      return;
    }
    const scanId = crypto.randomUUID();
    const directory = path.join(scanDir, scanId);
    const imageFormats = [];

    try {
      for (let index = 0; index < files.length; index += 1) {
        try {
          const metadata = await sharp(files[index].path, { limitInputPixels: 70_000_000 }).metadata();
          if (!["jpeg", "png", "webp", "avif"].includes(metadata.format)) {
            throw new Error("파일 내용이 올바른 JPEG, PNG, WebP 또는 AVIF 이미지가 아니에요.");
          }
          if (!metadata.width || !metadata.height || metadata.width < 800 || metadata.height < 600) {
            throw new Error("상품을 자세히 확인할 수 있도록 사진 한 장당 최소 800 × 600 픽셀이 필요해요.");
          }
          imageFormats.push(metadata.format);
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message.includes("파일 내용")
              ? error.message
              : error instanceof Error && error.message.includes("800 × 600")
                ? error.message
                : `사진 ${index + 1}장을 읽을 수 없어요. JPEG, PNG, WebP 또는 AVIF 원본을 확인해 주세요.`,
          );
        }
      }

      if (!reconstructionAvailable) {
        await cleanupUploads(files);
        res.status(503).json({
          error: "서버에서 COLMAP 또는 CUDA GPU를 찾을 수 없어요. CUDA를 지원하는 COLMAP과 NVIDIA GPU를 설정하고 서버를 다시 시작해 주세요.",
        });
        return;
      }

      const imageNames = imageFormats.map((format, index) => {
        const extension = format === "jpeg" ? "jpg" : format;
        return `${String(index + 1).padStart(3, "0")}.${extension}`;
      });
      await fs.mkdir(directory, { recursive: true });
      await fs.mkdir(path.join(directory, "images"), { recursive: true });
      for (let index = 0; index < files.length; index += 1) {
        await copyUploadedFile(
          files[index].path,
          path.join(directory, imageNames[index]),
          files[index].size,
        );
      }
      await cleanupUploads(files);
      db.prepare(
        "INSERT INTO scans (id, status, image_count, images_json, progress, owner_user_id) VALUES (?, 'queued', ?, ?, ?, ?)",
      ).run(scanId, files.length, JSON.stringify(imageNames), "재구성 대기 중", req.authUser.id);
      res.status(202).json({ scan: publicScan(getScan.get(scanId)) });
      scheduleScan(scanId);
    } catch (error) {
      await cleanupUploads(files);
      await removeTemporaryPaths([directory]);
      const serverError = isServerError(error);
      console.error("Scan upload failed:", error);
      res.status(serverError ? 500 : 400).json({
        error: isWindowsFileLockError(error)
          ? "사진 파일이 다른 프로그램에서 사용 중이라 저장하지 못했어요. 잠시 후 다시 시도해 주세요."
          : serverError
            ? "사진을 처리하거나 저장하지 못했어요. 서버 오류를 확인해 주세요."
            : error instanceof Error
              ? error.message
              : "사진을 확인하는 중 오류가 발생했어요.",
      });
    }
  });
});

app.post("/api/scans/videos", requireAuth, (req, res, next) => {
  const contentLength = Number(req.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxScanBytes) {
    res.status(413).json({ error: "전체 촬영 영상 용량은 512MB 이하여야 해요." });
    return;
  }
  videoUpload.array("videos", requiredVideoStages.length)(req, res, async (uploadError) => {
    const files = req.files || [];
    if (uploadError) {
      await cleanupUploads(files);
      next(uploadError);
      return;
    }
    const { title, description = "", category, price } = req.body || {};
    const stages = files.map((file) => path.basename(file.originalname, path.extname(file.originalname)).toLowerCase());
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const parsedPrice = Number(price);
    if (
      files.length !== requiredVideoStages.length ||
      new Set(stages).size !== requiredVideoStages.length ||
      requiredVideoStages.some((stage) => !stages.includes(stage))
    ) {
      await cleanupUploads(files);
      res.status(400).json({ error: "두 이동 경로 영상과 고해상도 근접 세부 영상이 각각 필요해요." });
      return;
    }
    if (totalBytes > maxScanBytes) {
      await cleanupUploads(files);
      res.status(413).json({ error: "전체 촬영 영상 용량은 512MB 이하여야 해요." });
      return;
    }
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.trim().length > 100 ||
      typeof description !== "string" ||
      description.length > 2000 ||
      typeof category !== "string" ||
      !category.trim() ||
      !Number.isSafeInteger(parsedPrice) ||
      parsedPrice < 0 ||
      parsedPrice > 1_000_000_000
    ) {
      await cleanupUploads(files);
      res.status(400).json({ error: "상품명, 설명, 카테고리와 0~10억 원 사이의 가격을 올바르게 입력해 주세요." });
      return;
    }
    if (runningJobs + jobQueue.length >= maxScansInFlight + maxQueuedScans) {
      await cleanupUploads(files);
      res.status(503).json({ error: "현재 재구성 작업이 가득 찼어요. 잠시 후 다시 시도해 주세요." });
      return;
    }
    if (!reconstructionAvailable) {
      await cleanupUploads(files);
      res.status(503).json({
        error: "CUDA 지원 COLMAP과 NVIDIA GPU가 필요해요. GPU 재구성 서버를 설정한 뒤 다시 시도해 주세요.",
      });
      return;
    }

    const scanId = crypto.randomUUID();
    const directory = path.join(scanDir, scanId);
    const videoDirectory = path.join(directory, "videos");
    const videos = files.map((file) => ({
      stage: path.basename(file.originalname, path.extname(file.originalname)).toLowerCase(),
      name: `${path.basename(file.originalname, path.extname(file.originalname)).toLowerCase()}${path.extname(file.originalname).toLowerCase()}`,
    }));
    try {
      await fs.mkdir(videoDirectory, { recursive: true });
      for (let index = 0; index < files.length; index += 1) {
        await copyUploadedFile(
          files[index].path,
          path.join(videoDirectory, videos[index].name),
          files[index].size,
        );
      }
      await cleanupUploads(files);
      db.prepare(`
        INSERT INTO scans
          (id, status, image_count, images_json, progress, videos_json, title, description, category, price, owner_user_id)
        VALUES (?, 'queued', 0, '[]', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scanId,
        "GPU 재구성 대기 중",
        JSON.stringify(videos),
        title.trim(),
        description.trim(),
        category.trim(),
        parsedPrice,
        req.authUser.id,
      );
      res.status(202).json({ scan: publicScan(getScan.get(scanId)) });
      scheduleScan(scanId);
    } catch (error) {
      await cleanupUploads(files);
      await removeTemporaryPaths([directory]);
      const serverError = isServerError(error);
      console.error("Scan video upload failed:", error);
      res.status(serverError ? 500 : 400).json({
        error: isWindowsFileLockError(error)
          ? "동영상 파일이 다른 프로그램에서 사용 중이라 저장하지 못했어요. 다시 시도해 주세요."
          : serverError
            ? "촬영 영상을 안전하게 저장하지 못했어요."
            : error instanceof Error
              ? error.message
              : "촬영 영상을 처리하지 못했어요.",
      });
    }
  });
});

app.put("/api/scans/:id/details", requireAuth, (req, res) => {
  const { title, description = "", category, price } = req.body || {};
  const parsedPrice = Number(price);
  if (
    !idPattern.test(req.params.id) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 100 ||
    typeof description !== "string" ||
    description.length > 2000 ||
    typeof category !== "string" ||
    !category.trim() ||
    !Number.isSafeInteger(parsedPrice) ||
    parsedPrice < 0 ||
    parsedPrice > 1_000_000_000
  ) {
    res.status(400).json({ error: "상품명, 설명, 카테고리와 0~10억 원 사이의 가격을 올바르게 입력해 주세요." });
    return;
  }
  const scan = getScan.get(req.params.id);
  if (!scan || scan.owner_user_id !== req.authUser.id || scan.status === "failed") {
    res.status(404).json({ error: "수정할 스캔 작업을 찾을 수 없어요." });
    return;
  }
  if (scan.status === "ready" && db.prepare("SELECT 1 FROM listings WHERE scan_id = ?").get(req.params.id)) {
    res.status(409).json({ error: "이미 등록된 상품 정보는 수정할 수 없어요." });
    return;
  }
  db.prepare(
    "UPDATE scans SET title = ?, description = ?, category = ?, price = ? WHERE id = ?",
  ).run(title.trim(), description.trim(), category.trim(), parsedPrice, req.params.id);
  res.json({ scan: publicScan(getScan.get(req.params.id)) });
});

app.post("/api/listings", (req, res) => {
  if (!req.authUser) {
    res.status(401).json({ error: "로그인한 판매자만 매물을 등록할 수 있어요." });
    return;
  }
  const { title, description = "", category, price, scanId } = req.body || {};
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.trim().length > 100 ||
    typeof description !== "string" ||
    description.length > 2000 ||
    typeof category !== "string" ||
    category.trim().length === 0 ||
    !Number.isSafeInteger(price) ||
    price < 0 ||
    price > 1_000_000_000 ||
    typeof scanId !== "string" ||
    !idPattern.test(scanId)
  ) {
    res.status(400).json({ error: "상품명, 설명, 카테고리, 0~10억 원 사이의 가격을 올바르게 입력해 주세요." });
    return;
  }

  const scan = getScan.get(scanId);
  if (!scan || scan.status !== "ready") {
    res.status(409).json({ error: "플랫폼에서 실제 3D 재구성을 완료한 스캔만 매물로 등록할 수 있어요." });
    return;
  }
  if (scan.owner_user_id !== req.authUser.id) {
    res.status(403).json({ error: "본인 계정으로 만든 스캔만 매물로 등록할 수 있어요." });
    return;
  }
  const uploadedStages = new Set(JSON.parse(scan.videos_json || "[]").map((video) => video.stage));
  if (videoSectors.some((sector) => !uploadedStages.has(sector))) {
    res.status(409).json({ error: "두 이동 경로를 모두 담은 스캔만 매물로 등록할 수 있어요." });
    return;
  }
  if (!uploadedStages.has(detailVideoStage)) {
    res.status(409).json({ error: "4K 근접 결함 촬영 원본이 있는 스캔만 매물로 등록할 수 있어요." });
    return;
  }
  const details = JSON.parse(scan.details_json || "[]");
  if (details.length < minDetailFrames) {
    res.status(409).json({
      error: `4K 해상도와 선명도를 확인한 근접 프레임 ${minDetailFrames}장 이상이 있는 스캔만 등록할 수 있어요.`,
    });
    return;
  }

  const listingId = crypto.randomUUID();
  try {
    db.prepare(
      "INSERT INTO listings (id, scan_id, title, description, category, price, seller_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(listingId, scanId, title.trim(), description.trim(), category.trim(), price, req.authUser.id);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      res.status(409).json({ error: "이 스캔은 이미 매물로 등록되었어요." });
      return;
    }
    throw error;
  }

  res.status(201).json({ listing: { id: listingId } });
});

app.post("/api/listings/:id/conversations", requireAuth, (req, res) => {
  if (!idPattern.test(req.params.id)) {
    res.status(404).json({ error: "상품을 찾을 수 없어요." });
    return;
  }
  const listing = db.prepare(`
    SELECT l.id, l.seller_user_id, l.title, u.username AS seller_username
    FROM listings AS l
    INNER JOIN scans AS s ON s.id = l.scan_id AND s.status = 'ready'
    LEFT JOIN users AS u ON u.id = l.seller_user_id
    WHERE l.id = ?
  `).get(req.params.id);
  if (!listing) {
    res.status(404).json({ error: "판매 중인 상품을 찾을 수 없어요." });
    return;
  }
  if (!listing.seller_user_id || listing.seller_user_id === req.authUser.id) {
    res.status(409).json({ error: "본인이 판매 중인 상품에는 문의할 수 없어요." });
    return;
  }
  db.prepare(`
    INSERT OR IGNORE INTO conversations (id, listing_id, buyer_user_id)
    VALUES (?, ?, ?)
  `).run(crypto.randomUUID(), listing.id, req.authUser.id);
  const conversation = db.prepare(
    "SELECT id FROM conversations WHERE listing_id = ? AND buyer_user_id = ?",
  ).get(listing.id, req.authUser.id);
  res.status(200).json({
    conversation: {
      id: conversation.id,
      listingId: listing.id,
      listingTitle: listing.title,
      otherUsername: listing.seller_username,
    },
  });
});

app.get("/api/conversations", requireAuth, (req, res) => {
  const conversations = db.prepare(`
    SELECT c.id, c.listing_id AS listingId, l.title AS listingTitle,
           c.updated_at AS updatedAt, l.seller_user_id AS sellerId,
           CASE WHEN c.buyer_user_id = ? THEN seller.username ELSE buyer.username END AS otherUsername,
           (SELECT m.body FROM messages AS m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS lastMessage
    FROM conversations AS c
    INNER JOIN listings AS l ON l.id = c.listing_id
    INNER JOIN scans AS s ON s.id = l.scan_id
    INNER JOIN users AS buyer ON buyer.id = c.buyer_user_id
    LEFT JOIN users AS seller ON seller.id = l.seller_user_id
    WHERE c.buyer_user_id = ? OR l.seller_user_id = ?
    ORDER BY c.updated_at DESC
    LIMIT 100
  `).all(req.authUser.id, req.authUser.id, req.authUser.id);
  res.json({ conversations });
});

function getConversationAccess(conversationId, userId) {
  if (!idPattern.test(conversationId)) return null;
  return db.prepare(`
    SELECT c.id, c.listing_id, c.buyer_user_id, l.seller_user_id
    FROM conversations AS c
    INNER JOIN listings AS l ON l.id = c.listing_id
    INNER JOIN scans AS s ON s.id = l.scan_id
    WHERE c.id = ? AND (c.buyer_user_id = ? OR l.seller_user_id = ?)
  `).get(conversationId, userId, userId);
}

app.get("/api/conversations/:id/messages", requireAuth, (req, res) => {
  const conversation = getConversationAccess(req.params.id, req.authUser.id);
  if (!conversation) {
    res.status(404).json({ error: "이 대화를 볼 권한이 없거나 대화가 없습니다." });
    return;
  }
  const messages = db.prepare(`
    SELECT m.id, m.sender_user_id AS senderId, u.username AS senderUsername,
           m.body, m.created_at AS createdAt
    FROM messages AS m
    INNER JOIN users AS u ON u.id = m.sender_user_id
    WHERE m.conversation_id = ?
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT 100
  `).all(conversation.id).reverse();
  res.json({ messages });
});

app.post("/api/conversations/:id/messages", requireAuth, (req, res) => {
  const conversation = getConversationAccess(req.params.id, req.authUser.id);
  if (!conversation) {
    res.status(404).json({ error: "이 대화에 메시지를 보낼 권한이 없거나 대화가 없습니다." });
    return;
  }
  const { body } = req.body || {};
  if (typeof body !== "string" || !body.trim() || body.trim().length > 2000) {
    res.status(400).json({ error: "메시지는 1~2,000자로 입력해 주세요." });
    return;
  }
  const messageId = crypto.randomUUID();
  db.prepare("INSERT INTO messages (id, conversation_id, sender_user_id, body) VALUES (?, ?, ?, ?)").run(
    messageId,
    conversation.id,
    req.authUser.id,
    body.trim(),
  );
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation.id);
  res.status(201).json({
    message: {
      id: messageId,
      senderId: req.authUser.id,
      senderUsername: req.authUser.username,
      body: body.trim(),
    },
  });
});

app.get("/media/scans/:id/model.ply", async (req, res, next) => {
  try {
    if (!idPattern.test(req.params.id) || getScan.get(req.params.id)?.status !== "ready") {
      res.status(404).json({ error: "등록 가능한 스캔 모델이 없습니다." });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'inline; filename="realresale-model.ply"');
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    await res.sendFile(path.join(scanDir, req.params.id, "model.ply"));
  } catch (error) {
    next(error);
  }
});

app.get("/media/scans/:id/images/:filename", async (req, res, next) => {
  try {
    const row = idPattern.test(req.params.id) ? getScan.get(req.params.id) : null;
    const filename = req.params.filename;
    if (!row || row.status !== "ready" || !JSON.parse(row.images_json).includes(filename)) {
      res.status(404).json({ error: "원본 사진을 찾을 수 없습니다." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    await res.sendFile(path.join(scanDir, req.params.id, filename));
  } catch (error) {
    next(error);
  }
});

app.get("/media/scans/:id/videos/:stage", async (req, res, next) => {
  try {
    const row = idPattern.test(req.params.id) ? getScan.get(req.params.id) : null;
    const video = row && row.status === "ready"
      ? JSON.parse(row.videos_json || "[]").find((item) => item.stage === req.params.stage)
      : null;
    if (!video) {
      res.status(404).json({ error: "촬영 원본 영상을 찾을 수 없어요." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    await res.sendFile(path.join(scanDir, req.params.id, "videos", video.name));
  } catch (error) {
    next(error);
  }
});

app.get("/media/scans/:id/details/:filename", async (req, res, next) => {
  try {
    const row = idPattern.test(req.params.id) ? getScan.get(req.params.id) : null;
    const filename = req.params.filename;
    const details = row && row.status === "ready" ? JSON.parse(row.details_json || "[]") : [];
    if (!details.some((frame) => frame.name === filename)) {
      res.status(404).json({ error: "근접 세부 사진을 찾을 수 없습니다." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    await res.sendFile(path.join(scanDir, req.params.id, "details", filename));
  } catch (error) {
    next(error);
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API 경로를 찾을 수 없습니다." });
});
app.use("/media", (_req, res) => {
  res.status(404).json({ error: "스캔 파일을 찾을 수 없습니다." });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(distDir, { index: false }));
  app.get("*splat", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

app.use((error, _req, res, _next) => {
  console.error("Request failed:", error);
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      if (error.field === "videos") {
        res.status(413).json({ error: "촬영 영상 한 개는 최대 512MB, 전체 영상은 최대 512MB까지 올릴 수 있어요." });
        return;
      }
      res.status(413).json({ error: "사진 한 장의 크기는 20MB 이하여야 해요." });
      return;
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      if (error.field === "videos") {
        res.status(413).json({ error: `촬영 영상은 최대 ${requiredVideoStages.length}개까지 올릴 수 있어요.` });
        return;
      }
      res.status(413).json({ error: `사진은 최대 ${maxImageCount}장까지 한 번에 올릴 수 있어요.` });
      return;
    }
  }
  if (isServerError(error)) {
    res.status(500).json({ error: "서버 작업을 완료하지 못했어요. 서버 오류를 확인해 주세요." });
    return;
  }
  res.status(400).json({
    error: error instanceof Error ? error.message : "요청 처리 중 알 수 없는 오류가 발생했어요.",
  });
});

const host = process.env.HOST || "127.0.0.1";
if (process.env.NODE_ENV === "production" && Boolean(httpsKeyPath) !== Boolean(httpsCertPath)) {
  throw new Error("Set both REALRESALE_HTTPS_KEY and REALRESALE_HTTPS_CERT to enable production HTTPS.");
}
const useHttps = process.env.NODE_ENV === "production" && httpsKeyPath && httpsCertPath;
const server = useHttps
  ? createHttpsServer(
      { key: await fs.readFile(httpsKeyPath), cert: await fs.readFile(httpsCertPath) },
      app,
    )
  : app;
server.listen(port, host, () => {
  const protocol = useHttps ? "https" : "http";
  console.log(`RealResale API listening on ${protocol}://${host}:${port}`);
});
