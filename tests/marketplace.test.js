import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  getAdaptiveScanGuidance,
  getDetailCaptureGuidance,
  getFramingGuidance,
  hasDetailCaptureFraming,
  measureLaplacianVariance,
  measureForegroundMask,
  measureFrameBrightness,
  normalizeDegrees,
  recordHeadingCoverage,
  supportsDetailCaptureResolution,
} from "../src/scan-guidance.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const serverPath = path.join(root, "server.js");
const colmapPath = process.env.COLMAP_PATH;
const port = 3127 + crypto.randomInt(0, 250);
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "realresale-api-test-"));
const databasePath = path.join(tempDir, "marketplace.sqlite");
const env = {
  ...process.env,
  DATA_DIR: path.join(tempDir, "data"),
  COLMAP_PATH: colmapPath || "",
  PORT: String(port),
};
let child;
let stdout = "";
let stderr = "";
let seller;
let buyer;
let thirdUser;

async function waitForServer() {
  const endTime = Date.now() + 30000;
  while (Date.now() < endTime) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited unexpectedly.\n${stderr}\n${stdout}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      await delay(200);
    }
  }
  throw new Error(`Timed out waiting for test server.\n${stderr}\n${stdout}`);
}

async function registerUser(username) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ username, password: "test-password-123" }),
  });
  const user = await response.json();
  assert.equal(response.status, 201, user.error);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return { ...user.user, cookie };
}

async function requestListing(body, origin = "http://127.0.0.1:5173", cookie = seller?.cookie) {
  return fetch(`${baseUrl}/api/listings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE scans (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
      image_count INTEGER NOT NULL,
      images_json TEXT NOT NULL,
      progress TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  legacyDatabase.close();
  child = spawn(process.execPath, [serverPath], {
    cwd: tempDir,
    env: { ...env, DATABASE_PATH: databasePath },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`; });
  const health = await waitForServer();
  assert.equal(health.ok, true);
  assert.equal(health.videoProcessingAvailable, true);
  assert.deepEqual(health.requiredCaptureSectors, ["route-a", "route-b"]);
  assert.deepEqual(health.requiredCaptureStages, ["route-a", "route-b", "detail"]);
  assert.equal(health.minDetailFrames, 20);
  assert.equal(health.minDetailResolution, 3840);
  assert.equal(typeof health.reconstructionAvailable, "boolean");
  seller = await registerUser("seller_user");
  buyer = await registerUser("buyer_user");
  thirdUser = await registerUser("third_user");
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5000),
    ]);
  }
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test("serves local health and an empty marketplace", async () => {
  const [healthResponse, listingsResponse] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(`${baseUrl}/api/listings`),
  ]);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(typeof health.reconstructionAvailable, "boolean");
  const listings = await listingsResponse.json();
  assert.deepEqual(listings.listings, []);
});

test("creates, restores, and clears authenticated sessions", async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ username: "SELLER_USER", password: "test-password-123" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const current = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.deepEqual(await current.json(), { user: { id: seller.id, username: seller.username } });

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:5173", cookie },
  });
  assert.equal(logout.status, 204);
  const signedOut = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: logout.headers.get("set-cookie")?.split(";")[0] },
  });
  assert.deepEqual(await signedOut.json(), { user: null });
});

test("migrates scan progress and exposes its percentage through the API", async () => {
  const database = new DatabaseSync(databasePath);
  try {
    const columns = database.prepare("PRAGMA table_info(scans)").all();
    assert.ok(columns.some((column) => column.name === "progress_percent"));
    assert.ok(columns.some((column) => column.name === "videos_json"));
    assert.ok(columns.some((column) => column.name === "details_json"));
    assert.ok(columns.some((column) => column.name === "description"));

    database.prepare(
      "INSERT INTO scans (id, status, image_count, images_json, progress, progress_percent, owner_user_id) VALUES (?, 'processing', ?, ?, ?, ?, ?)",
    ).run("progress-test", 24, "[]", "Reconstructing surface depth", 63, seller.id);
    const response = await fetch(`${baseUrl}/api/scans`, { headers: { cookie: seller.cookie } });
    const { scans } = await response.json();
    assert.equal(scans[0].id, "progress-test");
    assert.equal(scans[0].progressPercent, 63);
  } finally {
    database.prepare("DELETE FROM scans WHERE id = ?").run("progress-test");
    database.close();
  }
});

test("requires both guided video routes", async () => {
  const form = new FormData();
  form.append("videos", new Blob(["not an actual video"], { type: "video/mp4" }), "route-a.mp4");
  form.append("title", "Test product");
  form.append("description", "Details");
  form.append("category", "Other");
  form.append("price", "100");
  const response = await fetch(`${baseUrl}/api/scans/videos`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:5173", cookie: seller.cookie },
    body: form,
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Two route videos and one high-resolution close-up video/);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/scans`, { headers: { cookie: seller.cookie } })).json()).scans, []);
  assert.deepEqual(await fs.promises.readdir(path.join(tempDir, "data", "incoming")), []);

  const missingCloseup = new FormData();
  for (const stage of ["route-a", "route-b"]) {
    missingCloseup.append("videos", new Blob(["not an actual video"], { type: "video/mp4" }), `${stage}.mp4`);
  }
  missingCloseup.append("title", "Test product");
  missingCloseup.append("description", "Details");
  missingCloseup.append("category", "Other");
  missingCloseup.append("price", "100");
  const missingCloseupResponse = await fetch(`${baseUrl}/api/scans/videos`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:5173", cookie: seller.cookie },
    body: missingCloseup,
  });
  assert.equal(missingCloseupResponse.status, 400);
  assert.match((await missingCloseupResponse.json()).error, /high-resolution close-up video/);
  assert.deepEqual(await fs.promises.readdir(path.join(tempDir, "data", "incoming")), []);
});

test("measures a selected foreground and returns distance guidance", () => {
  const values = new Float32Array(100 * 100);
  for (let y = 20; y < 80; y += 1) {
    for (let x = 30; x < 70; x += 1) values[y * 100 + x] = 0.9;
  }
  const bounds = measureForegroundMask(values, 100, 100);
  assert.ok(bounds);
  assert.ok(bounds.left >= 0.29 && bounds.left <= 0.31);
  assert.ok(bounds.right >= 0.69 && bounds.right <= 0.71);
  assert.match(getFramingGuidance(bounds), /Good/);
  assert.match(getFramingGuidance({ left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 }), /Move closer/);
  assert.match(getFramingGuidance({ left: 0.1, top: 0.1, right: 0.99, bottom: 0.9 }), /Move back/);
  assert.equal(measureForegroundMask(new Float32Array(10000).fill(1), 100, 100), null);
});

test("guides the camera across two direction sectors and measures illumination", () => {
  const coverage = Array(24).fill(false);
  assert.equal(normalizeDegrees(-15), 345);
  const firstHeading = recordHeadingCoverage(coverage, 350, 350);
  const secondHeading = recordHeadingCoverage(firstHeading, 5, 350);
  assert.equal(firstHeading.filter(Boolean).length, 1);
  assert.equal(secondHeading.filter(Boolean).length, 2);
  const secondSector = recordHeadingCoverage(secondHeading, 200, 350);
  assert.equal(secondSector.slice(12).filter(Boolean).length, 1);
  const guidance = getAdaptiveScanGuidance({
    bounds: { left: 0.3, top: 0.3, right: 0.7, bottom: 0.7 },
    previousBounds: { left: 0.31, top: 0.31, right: 0.71, bottom: 0.71 },
    heading: 200,
    startingHeading: 350,
    sectorIndex: 1,
    coverage: secondSector,
  });
  assert.ok(guidance.aimPoint.x >= 0.49 && guidance.aimPoint.x <= 0.51);
  assert.equal(guidance.complete, false);
  assert.equal(guidance.targetDirection, "left");
  assert.equal(measureFrameBrightness(new Uint8ClampedArray([0, 0, 0, 255])), 0);
  assert.ok(measureFrameBrightness(new Uint8ClampedArray([255, 255, 255, 255])) > 254);
});

test("requires close, uncropped framing and 4K resolution for defect evidence", () => {
  const closeBounds = { left: 0.15, top: 0.12, right: 0.85, bottom: 0.88 };
  assert.equal(hasDetailCaptureFraming(closeBounds), true);
  assert.equal(hasDetailCaptureFraming({ ...closeBounds, right: 0.98 }), false);
  assert.match(getDetailCaptureGuidance({ ...closeBounds, right: 0.98 }), /Move back/);
  assert.match(getDetailCaptureGuidance({ left: 0.3, top: 0.3, right: 0.7, bottom: 0.7 }), /Move closer/);
  assert.match(getDetailCaptureGuidance(closeBounds), /slowly rotate the item to capture every side up close/);
  assert.equal(supportsDetailCaptureResolution(3840, 2160), true);
  assert.equal(supportsDetailCaptureResolution(1920, 1080), false);
  const smooth = new Uint8Array(16 * 16).fill(128);
  const textured = Uint8Array.from({ length: 16 * 16 }, (_, index) => (
    (index % 16 + Math.floor(index / 16)) % 2 ? 255 : 0
  ));
  assert.equal(measureLaplacianVariance(smooth, 16, 16), 0);
  assert.ok(measureLaplacianVariance(textured, 16, 16) > 0);
  assert.equal(measureLaplacianVariance(null, 0, 0), 0);
});

test("rejects direct listing submissions and untrusted browser origins", async () => {
  const rejectedListing = await requestListing({
    title: "Unscanned item",
    description: "",
    category: "Other",
    price: 1,
    scanId: crypto.randomUUID(),
  });
  assert.equal(rejectedListing.status, 409);
  assert.match((await rejectedListing.json()).error, /scans reconstructed by the platform/);

  const rejectedOrigin = await requestListing({}, "https://untrusted.example");
  assert.equal(rejectedOrigin.status, 403);
  assert.match((await rejectedOrigin.json()).error, /configured RealResale address/);

  const anonymousListing = await requestListing({
    title: "No account",
    description: "",
    category: "Other",
    price: 1,
    scanId: crypto.randomUUID(),
  }, "http://127.0.0.1:5173", null);
  assert.equal(anonymousListing.status, 401);
});

test("validates uploaded frames before queuing reconstruction", async () => {
  const form = new FormData();
  for (let index = 0; index < 23; index += 1) {
    form.append(
      "images",
      new Blob(["this upload must never be queued or stored"], { type: "image/jpeg" }),
      `${index}.jpg`,
    );
  }

  const scanResponse = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:5173", cookie: seller.cookie },
    body: form,
  });
  assert.equal(scanResponse.status, 400);
  assert.match((await scanResponse.json()).error, /At least 24 images/);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/scans`, { headers: { cookie: seller.cookie } })).json()).scans, []);
  assert.deepEqual(await fs.promises.readdir(path.join(tempDir, "data", "incoming")), []);

  const untrustedImages = new FormData();
  for (let index = 0; index < 24; index += 1) {
    untrustedImages.append(
      "images",
      new Blob(["not an actual image"], { type: "image/jpeg" }),
      `${index}.jpg`,
    );
  }
  const invalidImageResponse = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:5173", cookie: seller.cookie },
    body: untrustedImages,
  });
  assert.equal(invalidImageResponse.status, 400);
  assert.match((await invalidImageResponse.json()).error, /Could not read image 1/);
  assert.deepEqual((await (await fetch(`${baseUrl}/api/scans`, { headers: { cookie: seller.cookie } })).json()).scans, []);
  assert.deepEqual(await fs.promises.readdir(path.join(tempDir, "data", "incoming")), []);
});

test("requires both route videos and 20 high-resolution detail frames for listings", async () => {
  const legacyScanId = crypto.randomUUID();
  const incompleteScanId = crypto.randomUUID();
  const videoScanId = crypto.randomUUID();
  const stages = ["route-a", "route-b", "detail"];
  const videos = stages.map((stage) => ({ stage, name: `${stage}.mp4` }));
  const detailFrames = Array.from({ length: 20 }, (_, index) => ({
    name: `${String(index + 1).padStart(3, "0")}.jpg`,
    width: 3840,
    height: 2160,
  }));
  const database = new DatabaseSync(databasePath);
  const videoDirectory = path.join(tempDir, "data", "scans", videoScanId, "videos");
  const detailDirectory = path.join(tempDir, "data", "scans", videoScanId, "details");
  try {
    const insertScan = database.prepare(`
      INSERT INTO scans (id, status, image_count, images_json, videos_json, details_json, title, description, category, price, owner_user_id)
      VALUES (?, 'ready', 24, '[]', ?, ?, ?, ?, ?, ?, ?)
    `);
    insertScan.run(legacyScanId, "[]", "[]", "Legacy scan", "", "Other", 100, seller.id);
    const rejected = await requestListing({
      title: "Legacy scan",
      description: "",
      category: "Other",
      price: 100,
      scanId: legacyScanId,
    });
    assert.equal(rejected.status, 409);
    assert.match((await rejected.json()).error, /both capture routes/);

    insertScan.run(
      incompleteScanId,
      JSON.stringify(videos),
      "[]",
      "Missing details",
      "",
      "Other",
      100,
      seller.id,
    );
    const missingDetails = await requestListing({
      title: "Missing details",
      description: "",
      category: "Other",
      price: 100,
      scanId: incompleteScanId,
    });
    assert.equal(missingDetails.status, 409);
    assert.match((await missingDetails.json()).error, /at least 20 close-up frames/);

    insertScan.run(videoScanId, JSON.stringify(videos), JSON.stringify(detailFrames), "Video scan", "", "Other", 100, seller.id);
    await fs.promises.mkdir(videoDirectory, { recursive: true });
    await fs.promises.mkdir(detailDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(videoDirectory, "route-a.mp4"), Buffer.from("test video"));
    await fs.promises.writeFile(path.join(videoDirectory, "route-b.mp4"), Buffer.from("test video"));
    await fs.promises.writeFile(path.join(videoDirectory, "detail.mp4"), Buffer.from("test video"));
    await fs.promises.writeFile(path.join(detailDirectory, detailFrames[0].name), Buffer.from("test detail image"));
    const created = await requestListing({
      title: "Video scan",
      description: "",
      category: "Other",
      price: 100,
      scanId: videoScanId,
    });
    assert.equal(created.status, 201);

    const listings = await (await fetch(`${baseUrl}/api/listings`)).json();
    const { listing: createdListing } = await created.json();
    const listing = listings.listings.find((item) => item.id === createdListing.id);
    assert.deepEqual(listing.scan.videos.map((video) => video.stage), stages);
    assert.equal(listing.scan.details.length, 20);
    const media = await fetch(`${baseUrl}/media/scans/${videoScanId}/videos/route-a`);
    assert.equal(media.status, 200);
    assert.equal(await media.text(), "test video");
    const detailMedia = await fetch(`${baseUrl}/media/scans/${videoScanId}/details/${detailFrames[0].name}`);
    assert.equal(detailMedia.status, 200);
    assert.equal(await detailMedia.text(), "test detail image");
    assert.equal(listing.seller.username, seller.username);
  } finally {
    database.prepare("DELETE FROM listings WHERE scan_id IN (?, ?, ?)").run(legacyScanId, incompleteScanId, videoScanId);
    database.prepare("DELETE FROM scans WHERE id IN (?, ?, ?)").run(legacyScanId, incompleteScanId, videoScanId);
    database.close();
    await fs.promises.rm(path.dirname(videoDirectory), { recursive: true, force: true });
  }
});

test("isolates buyer-seller conversations and protects each user's scans", async () => {
  const scanId = crypto.randomUUID();
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  try {
    database.prepare(`
      INSERT INTO scans (id, status, image_count, images_json, videos_json, details_json, owner_user_id)
      VALUES (?, 'ready', 24, '[]', ?, ?, ?)
    `).run(
      scanId,
      JSON.stringify([
        { stage: "route-a", name: "route-a.mp4" },
        { stage: "route-b", name: "route-b.mp4" },
        { stage: "detail", name: "detail.mp4" },
      ]),
      JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
        name: `${String(index + 1).padStart(3, "0")}.jpg`,
        width: 3840,
        height: 2160,
      }))),
      seller.id,
    );

    const listingResponse = await requestListing({
      title: "Message test item",
      description: "",
      category: "Other",
      price: 100,
      scanId,
    });
    assert.equal(listingResponse.status, 201);
    const { listing } = await listingResponse.json();

    const buyerConversationResponse = await fetch(`${baseUrl}/api/listings/${listing.id}/conversations`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:5173", cookie: buyer.cookie },
    });
    assert.equal(buyerConversationResponse.status, 200);
    const { conversation } = await buyerConversationResponse.json();
    assert.equal(conversation.listingId, listing.id);

    const sentResponse = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173", cookie: buyer.cookie },
      body: JSON.stringify({ body: "Is this item still available?" }),
    });
    const sentResult = await sentResponse.json();
    assert.equal(sentResponse.status, 201, sentResult.error);
    assert.equal(sentResult.message.body, "Is this item still available?");

    const sellerInbox = await fetch(`${baseUrl}/api/conversations`, {
      headers: { cookie: seller.cookie },
    });
    const { conversations } = await sellerInbox.json();
    assert.equal(conversations.some((item) => item.id === conversation.id), true);

    const sellerReply = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173", cookie: seller.cookie },
      body: JSON.stringify({ body: "Yes, it is still available." }),
    });
    assert.equal(sellerReply.status, 201);

    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
        method,
        headers: {
          origin: "http://127.0.0.1:5173",
          cookie: thirdUser.cookie,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify({ body: "unauthorized" }) } : {}),
      });
      assert.equal(response.status, 404);
    }

    const ownInquiry = await fetch(`${baseUrl}/api/listings/${listing.id}/conversations`, {
      method: "POST",
      headers: { origin: "http://127.0.0.1:5173", cookie: seller.cookie },
    });
    assert.equal(ownInquiry.status, 409);

    const otherOwnerListing = await requestListing({
      title: "Wrong seller",
      description: "",
      category: "Other",
      price: 100,
      scanId,
    }, "http://127.0.0.1:5173", buyer.cookie);
    assert.equal(otherOwnerListing.status, 403);

    const messageHistory = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
      headers: { cookie: buyer.cookie },
    });
    const { messages } = await messageHistory.json();
    assert.deepEqual(messages.map((item) => item.body), ["Is this item still available?", "Yes, it is still available."]);
  } finally {
    database.prepare("DELETE FROM listings WHERE scan_id = ?").run(scanId);
    database.prepare("DELETE FROM scans WHERE id = ?").run(scanId);
    database.close();
  }
});

test("returns JSON for missing resources and blocks unauthenticated uploads from other origins", async () => {
  const missingMedia = await fetch(`${baseUrl}/media/scans/missing/model.ply`);
  assert.equal(missingMedia.status, 404);
  assert.match(missingMedia.headers.get("content-type"), /application\/json/);

  const remoteScan = await fetch(`${baseUrl}/api/scans`, {
    method: "POST",
    headers: { origin: "https://untrusted.example", cookie: seller.cookie },
    body: new FormData(),
  });
  assert.equal(remoteScan.status, 403);
});

test("rejects oversized scan requests before accepting any image data", async () => {
  const response = await new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}/api/scans`, {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "multipart/form-data; boundary=realresale-test",
        "content-length": String(513 * 1024 * 1024),
        cookie: seller.cookie,
      },
    }, (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { body += chunk; });
      incoming.on("end", () => resolve({ status: incoming.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(response.status, 413);
  assert.match(response.body.error, /512 MB/);
});
