# RealResale launch readiness

**Status: the local MVP can run on this PC with CUDA-enabled COLMAP. No cloud
GPU Pod has been created or deployed. Not ready for a public or commercial
launch.**

The app has completed GPU dense reconstruction and produced a visibility-based
surface mesh from 32 synthetic, 800 × 600 product views. Real item capture and
real-world scan quality have not been validated.

## Before calling the product launch-ready

### Required before a public beta

- Harden the implemented local username/password accounts, session handling,
  seller identity, and per-seller ownership and authorization for scans,
  listings, photos, editing, and deletion. Add account recovery and abuse
  protection.
- Replace the current local-only SQLite and in-memory scan queue with durable,
  backed-up production database, job queue, private object storage, and worker
  deployment. Add disk quotas, retention/deletion controls, retry handling,
  queue metrics, and operations alerts.
- Add upload protection against abusive traffic, CSRF and origin spoofing,
  malformed/decompression-bomb files, quota exhaustion, rate limits, and
  excessive GPU/CPU work. Validate image dimensions and media bytes before
  expensive processing.
- Add privacy disclosures, terms, prohibited-items rules, moderation and
  takedown procedures, and an incident-response contact/process.
- Configure production HTTPS, secure secrets, host allowlists, security
  headers, backups, monitoring, recovery procedures, and a staging/production
  deployment.
- Conduct human safety and quality review before a seller can publish. The
  current automatic mesh-size and registered-photo checks are not an
  independently validated grade or proof of item condition.
- Test real items and intentionally bad inputs on the production GPU class:
  matte, dark, shiny, transparent, reflective, repeated-pattern, small, large,
  scratched and occluded surfaces. Measure repeatable capture-to-registration
  success, scan latency, memory, file usage, and whether defects are visible.
  The new 4K close-up gate verifies source resolution and a server-side
  sharpness score, not scratch presence. Validate the roughly 0.5 mm capture
  target across representative iPhone models and known defect samples before
  describing the workflow as defect detection.
- Review licensing, accessibility, and consumer/legal requirements for the
  actual operating region. Implement and verify marketplace purchase, messaging,
  shipping, returns and support before representing those as available.

### Current demo boundaries

- Can run on the developer's own PC. Local accounts, scan ownership, and
  private one-to-one buyer/seller messaging are implemented. Marketplace
  payments, shipping, moderation, account recovery, and production backups are
  not.
- The local development server binds to loopback; **do not expose it to the
  public internet**.
- For local runs, submitted scans and generated models remain on this PC under
  the ignored `data/` directory. Back up or remove this directory deliberately.
- No Runpod account, Pod, registry image, or paid cloud resource has been
  created by this project. A cloud deployment requires the developer's own
  provider account, payment setup, image publishing, and explicit Pod deploy
  command. The PowerShell helper under `scripts/` stores the Runpod API key
  encrypted for the current Windows user and can start/stop the configured Pod.
- A reconstructed surface can omit or smooth tiny scratches. Always inspect the
  retained 4K close-up evidence and never describe an automated 3D scan as proof
  that an item is flawless. The close-up gate checks recording resolution and
  image sharpness; it does not identify or guarantee capture of every flaw.

## Local verification

```powershell
npm install
npm test
npm run check
npm run build
npm audit
npm run dev
```

The automated API tests require `COLMAP_PATH` to point to a CUDA-enabled COLMAP
executable and `nvidia-smi` to be able to see the NVIDIA GPU. The included API
tests reject unsafe registration requests and malformed or untrusted requests.
The complete application path was exercised with 32 synthetic photos: the
generated PLY contained 6,371 vertices and 12,654 faces, its model endpoint
returned HTTP 200, and a temporary listing appeared in the marketplace API.
The temporary listing and the identified synthetic verification scan were
removed after the check. Real product-scene testing still needs representative
physical items.
