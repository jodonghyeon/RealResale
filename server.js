import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
const maxImageCount = 120;
const minDetailFrames = 20;
const maxDetailFrames = 40;
const minDetailResolution = 3840;
const minDetailVideoSeconds = 20;
const maxDetailVideoSeconds = 30;
const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const idPattern = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const maxScanBytes = 512 * 1024 * 1024;
const maxVideoSeconds = 120;
const maxTotalVideoSeconds = 90;
const maxVideoUploadFiles = 19;
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
    category TEXT NOT NULL DEFAULT 'Other',
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
  ["category", "TEXT NOT NULL DEFAULT 'Other'"],
  ["price", "INTEGER NOT NULL DEFAULT 0"],
  ["owner_user_id", "TEXT REFERENCES users(id)"],
];
for (const [name, declaration] of scanMigrations) {
  if (!scanColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE scans ADD COLUMN ${name} ${declaration}`);
  }
}
const legacyCategoryLabels = [
  ["디지털 · 카메라", "Electronics & cameras"],
  ["패션 · 의류", "Fashion & clothing"],
  ["가구 · 인테리어", "Furniture & home"],
  ["생활 · 취미", "Home & hobbies"],
  ["기타", "Other"],
];
for (const [legacyLabel, englishLabel] of legacyCategoryLabels) {
  db.prepare("UPDATE scans SET category = ? WHERE category = ?").run(englishLabel, legacyLabel);
  db.prepare("UPDATE listings SET category = ? WHERE category = ?").run(englishLabel, legacyLabel);
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
      error = 'The server restarted and interrupted the previous scan. Start a new scan.'
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
          res.status(403).json({ error: "Requests are allowed only from the configured RealResale address." });
          return;
        }
      } catch {
        res.status(403).json({ error: "Could not verify the request origin." });
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
    res.status(401).json({ error: "Sign in to your account to continue." });
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
      callback(new Error("Only JPEG, PNG, WebP, or AVIF images can be scanned."));
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
  limits: { files: maxVideoUploadFiles, fileSize: maxScanBytes },
  fileFilter: (_req, file, callback) => {
    const supportedType = ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"].includes(file.mimetype);
    const supportedExtension = /\.(mov|mp4|m4v|webm)$/i.test(file.originalname);
    if (!supportedType && !supportedExtension) {
      callback(new Error("Only MOV, MP4, M4V, or WebM videos are supported."));
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
        throw new Error("Could not copy the complete uploaded image into scan storage.");
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
      reject(new Error(`${description} timed out.`));
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
        reject(new Error(`Could not start the video processing program: ${spawnError.message}`));
      } else if (code !== 0) {
        const details = stderr.split(/\r?\n/).filter(Boolean).slice(-5).join(" ");
        reject(new Error(`${description} failed.${details ? ` ${details}` : ""}`));
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
  if (!duration) throw new Error("Could not read the video duration. Check that it is a playable MOV, MP4, or WebM file.");
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
      reject(new Error(`${stepName} did not finish within 45 minutes. Reduce the number of images and try again.`));
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
        reject(new Error(`Could not start COLMAP: ${spawnError.message}`));
      } else if (code !== 0) {
        const details = stderr.split(/\r?\n/).filter(Boolean).slice(-8).join(" ");
        const cudaHint = /cuda|gpu|patch.?match/i.test(details)
          ? " Check GPU/CUDA support for PatchMatchStereo."
          : "";
        reject(
          new Error(
            `${stepName} failed.${cudaHint}${details ? ` ${details}` : ` (exit code ${code ?? signal})`}`,
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
    const message = error instanceof Error ? error.message : "An unknown reconstruction error occurred.";
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

async function extractSingleVideoFrames(scanId, directory, video) {
  const videoDirectory = path.join(directory, "videos");
  const candidateDirectory = path.join(directory, "frame-candidates");
  const imagesDirectory = path.join(directory, "images");
  await fs.mkdir(candidateDirectory, { recursive: true });
  await fs.mkdir(imagesDirectory, { recursive: true });
  await setProgress(scanId, "Selecting sharp, varied frames from the scan video", 3);

  const sourcePath = path.join(videoDirectory, video.name);
  const duration = await getVideoDuration(sourcePath);
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxVideoSeconds) {
    throw new Error(`The scan video must be no longer than ${maxVideoSeconds} seconds.`);
  }
  const candidatesLimit = Math.max(1, Math.ceil(duration * 5));
  await runFfmpeg(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-vf",
      `fps=${Math.min(5, candidatesLimit / duration).toFixed(5)},scale=3840:3840:force_original_aspect_ratio=decrease`,
      "-frames:v",
      String(candidatesLimit),
      "-q:v",
      "2",
      path.join(candidateDirectory, "%04d.jpg"),
      "-y",
    ],
    "Sampling frames from the scan video",
  );

  const filenames = (await fs.readdir(candidateDirectory))
    .filter((name) => /^\d{4}\.jpg$/.test(name))
    .sort((left, right) => Number(path.parse(left).name) - Number(path.parse(right).name));
  const targetCount = Math.min(maxImageCount, Math.max(1, Math.ceil(duration * 2.5)));
  const bestByInterval = new Map();
  for (const [index, filename] of filenames.entries()) {
    const source = path.join(candidateDirectory, filename);
    const metadata = await sharp(source).metadata();
    if (!metadata.width || !metadata.height || Math.min(metadata.width, metadata.height) < 600) continue;
    const { data, info } = await sharp(source)
      .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sharpness = measureLaplacianVariance(data, info.width, info.height);
    const bucket = Math.min(targetCount - 1, Math.floor((index / Math.max(1, filenames.length)) * targetCount));
    const current = bestByInterval.get(bucket);
    if (!current || sharpness > current.sharpness) {
      bestByInterval.set(bucket, { filename, sharpness });
    }
  }

  const selected = [...bestByInterval.values()]
    .sort((left, right) => Number(path.parse(left.filename).name) - Number(path.parse(right.filename).name));
  if (selected.length === 0) {
    throw new Error("Could not extract readable frames from the scan video.");
  }
  const imageNames = [];
  for (const [index, frame] of selected.entries()) {
    const name = `${String(index + 1).padStart(3, "0")}.jpg`;
    await fs.copyFile(path.join(candidateDirectory, frame.filename), path.join(directory, name));
    imageNames.push(name);
  }
  await fs.rm(candidateDirectory, { recursive: true, force: true });
  db.prepare("UPDATE scans SET image_count = ?, images_json = ? WHERE id = ?").run(
    imageNames.length,
    JSON.stringify(imageNames),
    scanId,
  );
  await setProgress(scanId, `Selected ${imageNames.length} frames from the scan video`, 20);
}

async function extractVideoFrames(scanId, directory, videos) {
  if (!ffmpegPath) throw new Error("Could not find the FFmpeg executable required to process videos.");
  if (videos.length === 1 && videos[0].stage === "scan") {
    await extractSingleVideoFrames(scanId, directory, videos[0]);
    return;
  }
  const videoDirectory = path.join(directory, "videos");
  const extractedDirectory = path.join(directory, "extracted");
  const imagesDirectory = path.join(directory, "images");
  await fs.mkdir(extractedDirectory, { recursive: true });
  await fs.mkdir(imagesDirectory, { recursive: true });
  await setProgress(scanId, "Analyzing two full-item routes and the close-up video", 2);

  const durations = new Map();
  for (const video of videos) {
    const duration = await getVideoDuration(path.join(videoDirectory, video.name));
    const minimumDuration = video.stage === detailVideoStage ? minDetailVideoSeconds : 3;
    const maximumDuration = video.stage === detailVideoStage ? maxDetailVideoSeconds : maxVideoSeconds;
    if (duration < minimumDuration || duration > maximumDuration + (video.stage === detailVideoStage ? 1 : 0)) {
      throw new Error(
        video.stage === detailVideoStage
          ? `Record the close-up video for ${minDetailVideoSeconds}–${maxDetailVideoSeconds} seconds.`
          : `Record the ${video.stage} video for 3–${maxVideoSeconds} seconds.`,
      );
    }
    durations.set(video.name, duration);
  }
  const routeDuration = videos
    .filter((video) => videoSectors.includes(video.stage))
    .reduce((total, video) => total + durations.get(video.name), 0);
  if (routeDuration > maxTotalVideoSeconds) {
    throw new Error("The combined duration of the two routes exceeds the limit. Review the route videos.");
  }

  const imageNames = [];
  for (let index = 0; index < videoSectors.length; index += 1) {
    const stage = videoSectors[index];
    const routeVideos = videos.filter((video) => video.stage === stage);
    const stageDuration = routeVideos.reduce((total, video) => total + durations.get(video.name), 0);
    const sectorImageStart = imageNames.length;
    const frameLimit = Math.floor(maxImageCount / videoSectors.length);
    for (const video of routeVideos) {
      const duration = durations.get(video.name);
      const segmentFrameLimit = Math.max(1, Math.floor(frameLimit * duration / stageDuration));
      const stageDirectory = path.join(extractedDirectory, stage, path.parse(video.name).name);
      await fs.mkdir(stageDirectory, { recursive: true });
      await runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          path.join(videoDirectory, video.name),
          "-vf",
          `fps=${Math.min(1.5, segmentFrameLimit / duration).toFixed(5)},scale=3840:3840:force_original_aspect_ratio=decrease`,
          "-frames:v",
          String(segmentFrameLimit),
          "-q:v",
          "2",
          path.join(stageDirectory, "%03d.jpg"),
          "-y",
        ],
        `Extracting sharp frames from a ${stage} route segment`,
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
        await fs.copyFile(imagePath, path.join(directory, outputName));
        imageNames.push(outputName);
      }
    }
    const sectorImageCount = imageNames.length - sectorImageStart;
    if (sectorImageCount < minFramesPerSector) {
      throw new Error(
        `Only ${sectorImageCount} valid frames were extracted from the ${stage} route. Each route requires at least ${minFramesPerSector} frames.`,
      );
    }
    await setProgress(
      scanId,
      `Checking frames from the ${stage} route`,
      Math.min(20, 2 + Math.floor(((index + 1) / videoSectors.length) * 18)),
    );
  }

  if (imageNames.length < minImageCount) {
    throw new Error(
      `Only ${imageNames.length} valid frames were extracted from the two routes. At least ${minImageCount} are required.`,
    );
  }
  db.prepare("UPDATE scans SET image_count = ?, images_json = ? WHERE id = ?").run(
    imageNames.length,
    JSON.stringify(imageNames),
    scanId,
  );

  const detailVideo = videos.find((video) => video.stage === detailVideoStage);
  if (!detailVideo) {
    throw new Error("A close-up video is required to inspect fine item details.");
  }
  const detailDirectory = path.join(directory, "details");
  const extractedDetailsDirectory = path.join(directory, "detail-extracted");
  await fs.mkdir(detailDirectory, { recursive: true });
  await fs.mkdir(extractedDetailsDirectory, { recursive: true });
  await setProgress(scanId, "Checking resolution and focus of 4K close-up frames", 23);
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
    "Extracting high-resolution frames from the close-up video",
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
      `Could not obtain ${minDetailFrames} original frames at ${minDetailResolution}px or higher from the close-up video. Check the camera's 4K setting and focus, then record again.`,
    );
  }
  const sortedSharpness = detailCandidates.map((frame) => frame.sharpness).sort((left, right) => left - right);
  const sharpnessThreshold = Math.max(12, sortedSharpness[Math.floor((sortedSharpness.length - 1) * 0.2)] * 0.35);
  const selectedDetails = detailCandidates.filter((frame) => frame.sharpness >= sharpnessThreshold);
  if (selectedDetails.length < minDetailFrames) {
    throw new Error(
      `Fewer than ${minDetailFrames} sharp 4K close-up frames were found. Improve the lighting, move the camera slowly, and record again.`,
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
  await setProgress(scanId, "Saving high-resolution close-up evidence", 25);
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
    throw new Error("COLMAP was not found on the server. Install COLMAP and restart the server.");
  }

  await fs.mkdir(imagesDir, { recursive: true });
  await fs.mkdir(sparseDir, { recursive: true });
  await fs.mkdir(denseDir, { recursive: true });

  await setProgress(scanId, "Normalizing extracted high-resolution frames", 25);
  for (let index = 0; index < imageRows.images.length; index += 1) {
    const filename = imageRows.images[index];
    await sharp(path.join(directory, filename), { limitInputPixels: 70_000_000 })
      .rotate()
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toFile(path.join(imagesDir, `${String(index).padStart(3, "0")}.jpg`));
    await setProgress(
      scanId,
      "Normalizing extracted high-resolution frames",
      25 + Math.floor(((index + 1) / imageRows.images.length) * 8),
    );
  }
  await setProgress(scanId, "Analyzing 3D features and camera data", 33);

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
    "Analyzing image features and camera positions",
    45 * 60 * 1000,
    { start: 33, end: 43 },
  );
  await runColmap(
    {
      ...base,
      command: ["exhaustive_matcher", "--database_path", databasePath, "--FeatureMatching.use_gpu", "1"],
    },
    "Matching overlapping photos",
    45 * 60 * 1000,
    { start: 43, end: 53 },
  );
  await runColmap(
    { ...base, command: ["mapper", "--database_path", databasePath, "--image_path", imagesDir, "--output_path", sparseDir] },
    "Calculating 3D camera positions from the captured images",
    45 * 60 * 1000,
    { start: 53, end: 63 },
  );

  const sparseModels = (await fs.readdir(sparseDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => Number(left.name) - Number(right.name));
  if (sparseModels.length === 0) {
    throw new Error("Not enough matching features were found. Take sharp photos from multiple angles and try again.");
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
      "Counting images registered to each 3D candidate",
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
    throw new Error("Could not verify 3D camera positions from the images. Take sharp photos from multiple angles and try again.");
  }
  await runColmap(
    { ...base, command: ["image_undistorter", "--image_path", imagesDir, "--input_path", sparseModel, "--output_path", denseDir, "--output_type", "COLMAP", "--max_image_size", "4096"] },
    "Aligning high-resolution images in 3D space",
    45 * 60 * 1000,
    { start: 68, end: 74 },
  );
  await runColmap(
    { ...base, command: ["patch_match_stereo", "--workspace_path", denseDir, "--workspace_format", "COLMAP", "--PatchMatchStereo.geom_consistency", "true"] },
    "Reconstructing surface depth and color from multiple angles",
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
    "Generating a color 3D point cloud",
    45 * 60 * 1000,
    { start: 90, end: 96 },
  );
  await setProgress(scanId, "Verifying the high-density color 3D surface", 96);
  const modelPath = path.join(directory, "model.ply");
  await fs.copyFile(fusedPath, modelPath, fs.constants.COPYFILE_EXCL);

  const modelStat = await fs.stat(modelPath);
  if (modelStat.size < 1_000_000) {
    throw new Error("The color 3D point cloud is not complete enough to publish. Capture every side more clearly.");
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
    throw new Error("A high-density 3D point cloud with real color data was not completed. Review the capture videos.");
  }

  await setProgress(scanId, "Color 3D result verified", 99);
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
    res.status(400).json({ error: "Use 3–24 letters, numbers, or underscores for the username and a 10–128 byte password." });
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
      res.status(409).json({ error: "That username is already taken." });
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
    res.status(400).json({ error: "Check your username and password." });
    return;
  }
  const account = db.prepare("SELECT id, username, password_salt, password_hash FROM users WHERE username = ? COLLATE NOCASE").get(username);
  const valid = account
    ? await verifyPassword(password, account.password_salt, account.password_hash)
    : false;
  if (!valid) {
    res.status(401).json({ error: "Incorrect username or password." });
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

app.get("/api/item-selection-model", async (_req, res, next) => {
  try {
    const modelResponse = await fetch(
      "https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/latest/interactive_segmentation.task",
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!modelResponse.ok || !modelResponse.body) {
      res.status(502).json({ error: `Could not retrieve the item selection model (HTTP ${modelResponse.status}).` });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const contentLength = modelResponse.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    await pipeline(Readable.fromWeb(modelResponse.body), res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    next(error);
  }
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
    requiredCaptureSectors: [],
    requiredCaptureStages: ["scan"],
    maxVideoSeconds,
    maxTotalVideoSeconds: maxVideoSeconds,
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
    res.status(413).json({ error: "The total size of scan images must not exceed 512 MB." });
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
      res.status(400).json({ error: `At least ${minImageCount} images are required for server reconstruction. Received ${files.length}.` });
      return;
    }
    if (files.reduce((total, file) => total + file.size, 0) > maxScanBytes) {
      await cleanupUploads(files);
      res.status(413).json({ error: "The total size of scan images must not exceed 512 MB." });
      return;
    }
    if (runningJobs + jobQueue.length >= maxScansInFlight + maxQueuedScans) {
      await cleanupUploads(files);
      res.status(503).json({ error: "The reconstruction queue is full. Try again shortly." });
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
            throw new Error("The file contents are not a valid JPEG, PNG, WebP, or AVIF image.");
          }
          if (!metadata.width || !metadata.height || metadata.width < 800 || metadata.height < 600) {
            throw new Error("Each image must be at least 800 × 600 pixels for detailed item inspection.");
          }
          imageFormats.push(metadata.format);
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message.includes("file contents")
              ? error.message
              : error instanceof Error && error.message.includes("800 × 600")
                ? error.message
                : `Could not read image ${index + 1}. Check that the original is a JPEG, PNG, WebP, or AVIF file.`,
          );
        }
      }

      if (!reconstructionAvailable) {
        await cleanupUploads(files);
        res.status(503).json({
          error: "COLMAP or a CUDA GPU was not found on the server. Set up CUDA-enabled COLMAP and an NVIDIA GPU, then restart the server.",
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
      ).run(scanId, files.length, JSON.stringify(imageNames), "Queued for reconstruction", req.authUser.id);
      res.status(202).json({ scan: publicScan(getScan.get(scanId)) });
      scheduleScan(scanId);
    } catch (error) {
      await cleanupUploads(files);
      await removeTemporaryPaths([directory]);
      const serverError = isServerError(error);
      console.error("Scan upload failed:", error);
      res.status(serverError ? 500 : 400).json({
        error: isWindowsFileLockError(error)
          ? "The image file is in use by another program and could not be saved. Try again shortly."
          : serverError
            ? "Could not process or save the images. Check the server error log."
            : error instanceof Error
              ? error.message
              : "An error occurred while checking the images.",
      });
    }
  });
});

app.post("/api/scans/videos", requireAuth, (req, res, next) => {
  const contentLength = Number(req.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxScanBytes) {
    res.status(413).json({ error: "The total size of the capture videos must not exceed 512 MB." });
    return;
  }
  videoUpload.array("videos", maxVideoUploadFiles)(req, res, async (uploadError) => {
    const files = req.files || [];
    if (uploadError) {
      await cleanupUploads(files);
      next(uploadError);
      return;
    }
    const { title, description = "", category, price } = req.body || {};
    const videoDescriptors = files.map((file) => {
      const basename = path.basename(file.originalname, path.extname(file.originalname)).toLowerCase();
      const routeMatch = /^(route-a|route-b)(?:-part-([1-9]\d*))?$/.exec(basename);
      return {
        basename,
        stage: basename === "scan"
          ? "scan"
          : routeMatch?.[1] || (basename === detailVideoStage ? detailVideoStage : null),
      };
    });
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const parsedPrice = Number(price);
    const videoNames = videoDescriptors.map(({ basename }) => basename);
    const hasEachRoute = videoSectors.every((stage) => videoDescriptors.some((video) => video.stage === stage));
    const isSingleScan = files.length === 1 && videoDescriptors[0]?.stage === "scan";
    const isLegacyCapture = files.length >= requiredVideoStages.length &&
      videoDescriptors.every((video) => video.stage !== "scan" && video.stage) &&
      new Set(videoNames).size === files.length &&
      hasEachRoute &&
      videoDescriptors.filter((video) => video.stage === detailVideoStage).length === 1;
    if (
      (!isSingleScan && !isLegacyCapture) ||
      new Set(videoNames).size !== files.length
    ) {
      await cleanupUploads(files);
      res.status(400).json({ error: "Upload one scan video to reconstruct the item." });
      return;
    }
    if (totalBytes > maxScanBytes) {
      await cleanupUploads(files);
      res.status(413).json({ error: "The total size of the capture videos must not exceed 512 MB." });
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
      res.status(400).json({ error: "Enter a valid title, description, category, and price between $0 and $1,000,000,000 USD." });
      return;
    }
    if (runningJobs + jobQueue.length >= maxScansInFlight + maxQueuedScans) {
      await cleanupUploads(files);
      res.status(503).json({ error: "The reconstruction queue is full. Try again shortly." });
      return;
    }
    if (!reconstructionAvailable) {
      await cleanupUploads(files);
      res.status(503).json({
        error: "CUDA-enabled COLMAP and an NVIDIA GPU are required. Set up a GPU reconstruction server and try again.",
      });
      return;
    }

    const scanId = crypto.randomUUID();
    const directory = path.join(scanDir, scanId);
    const videoDirectory = path.join(directory, "videos");
    const videos = files.map((file, index) => ({
      stage: videoDescriptors[index].stage,
      name: `${videoDescriptors[index].basename}${path.extname(file.originalname).toLowerCase()}`,
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
        "Queued for GPU reconstruction",
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
          ? "The video file is in use by another program and could not be saved. Try again."
          : serverError
            ? "Could not safely save the capture videos."
            : error instanceof Error
              ? error.message
              : "Could not process the capture videos.",
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
    res.status(400).json({ error: "Enter a valid title, description, category, and price between $0 and $1,000,000,000 USD." });
    return;
  }
  const scan = getScan.get(req.params.id);
  if (!scan || scan.owner_user_id !== req.authUser.id || scan.status === "failed") {
    res.status(404).json({ error: "Could not find the scan to update." });
    return;
  }
  if (scan.status === "ready" && db.prepare("SELECT 1 FROM listings WHERE scan_id = ?").get(req.params.id)) {
    res.status(409).json({ error: "Details for an already-published listing cannot be changed." });
    return;
  }
  db.prepare(
    "UPDATE scans SET title = ?, description = ?, category = ?, price = ? WHERE id = ?",
  ).run(title.trim(), description.trim(), category.trim(), parsedPrice, req.params.id);
  res.json({ scan: publicScan(getScan.get(req.params.id)) });
});

app.post("/api/listings", (req, res) => {
  if (!req.authUser) {
    res.status(401).json({ error: "Sign in as a seller to publish a listing." });
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
    res.status(400).json({ error: "Enter a valid title, description, category, and price between $0 and $1,000,000,000 USD." });
    return;
  }

  const scan = getScan.get(scanId);
  if (!scan || scan.status !== "ready") {
    res.status(409).json({ error: "Only scans reconstructed by the platform can be published as listings." });
    return;
  }
  if (scan.owner_user_id !== req.authUser.id) {
    res.status(403).json({ error: "You can publish only scans created by your account." });
    return;
  }
  const videos = JSON.parse(scan.videos_json || "[]");
  const isSingleVideoScan = videos.length === 1 && videos[0].stage === "scan";
  if (!isSingleVideoScan) {
    const uploadedStages = new Set(videos.map((video) => video.stage));
    if (videoSectors.some((sector) => !uploadedStages.has(sector))) {
      res.status(409).json({ error: "This scan does not include all required capture routes." });
      return;
    }
    if (!uploadedStages.has(detailVideoStage)) {
      res.status(409).json({ error: "This scan does not include its original close-up video." });
      return;
    }
    const details = JSON.parse(scan.details_json || "[]");
    if (details.length < minDetailFrames) {
      res.status(409).json({
        error: `This scan does not include ${minDetailFrames} verified close-up frames.`,
      });
      return;
    }
  }

  const listingId = crypto.randomUUID();
  try {
    db.prepare(
      "INSERT INTO listings (id, scan_id, title, description, category, price, seller_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(listingId, scanId, title.trim(), description.trim(), category.trim(), price, req.authUser.id);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      res.status(409).json({ error: "This scan has already been published as a listing." });
      return;
    }
    throw error;
  }

  res.status(201).json({ listing: { id: listingId } });
});

app.post("/api/listings/:id/conversations", requireAuth, (req, res) => {
  if (!idPattern.test(req.params.id)) {
    res.status(404).json({ error: "Item not found." });
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
    res.status(404).json({ error: "Active listing not found." });
    return;
  }
  if (!listing.seller_user_id || listing.seller_user_id === req.authUser.id) {
    res.status(409).json({ error: "You cannot message yourself about your own listing." });
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
    res.status(404).json({ error: "This conversation does not exist or you do not have access to it." });
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
    res.status(404).json({ error: "This conversation does not exist or you do not have permission to send messages." });
    return;
  }
  const { body } = req.body || {};
  if (typeof body !== "string" || !body.trim() || body.trim().length > 2000) {
    res.status(400).json({ error: "Messages must contain 1–2,000 characters." });
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
      res.status(404).json({ error: "No reconstructed scan model is available to publish." });
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
      res.status(404).json({ error: "Original image not found." });
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
    const videos = row && row.status === "ready" ? JSON.parse(row.videos_json || "[]") : [];
    const video = videos.find((item) => item.name === req.params.stage) ||
      videos.find((item) => item.stage === req.params.stage);
    if (!video) {
      res.status(404).json({ error: "Original capture video not found." });
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
      res.status(404).json({ error: "Close-up detail photo not found." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    await res.sendFile(path.join(scanDir, req.params.id, "details", filename));
  } catch (error) {
    next(error);
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});
app.use("/media", (_req, res) => {
  res.status(404).json({ error: "Scan file not found." });
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
        res.status(413).json({ error: "Each capture video is limited to 512 MB; total uploads are also limited to 512 MB." });
        return;
      }
      res.status(413).json({ error: "Each image must be 20 MB or smaller." });
      return;
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      if (error.field === "videos") {
        res.status(413).json({ error: `You can upload at most ${maxVideoUploadFiles} capture videos.` });
        return;
      }
      res.status(413).json({ error: `You can upload at most ${maxImageCount} images at a time.` });
      return;
    }
  }
  if (isServerError(error)) {
    res.status(500).json({ error: "The server could not complete the request. Check the server error log." });
    return;
  }
  res.status(400).json({
    error: error instanceof Error ? error.message : "An unknown error occurred while processing the request.",
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
