# RealResale

A secondhand marketplace MVP with an iPhone Safari capture experience. Sellers
record two guided whole-item camera passes and one required 4K close-up pass.
On-device product segmentation and orientation history guide capture; the
server validates close-up resolution and sharpness, runs COLMAP on the whole-item
passes, and stores close-up evidence images separately. Buyers can inspect
listings and send private messages to sellers.

## Requirements

- Windows 10/11 or another desktop operating system
- Node.js 22.13 or newer
- An NVIDIA GPU and working driver. `nvidia-smi -L` must list the GPU.
- COLMAP's CUDA-enabled command-line executable (`colmap.exe`).

## Use it now

For a local PC demo, open PowerShell in this directory and run:

```powershell
npm run dev
```

Then open <http://localhost:5173>. This checkout has a CUDA-enabled COLMAP
binary and an NVIDIA GPU available, so local reconstruction can run on this PC.
To use the live camera from an iPhone, follow the HTTPS setup below; the
development address on plain HTTP is for the PC browser only.

The optional Runpod deployment is **not created or running**. No Runpod account,
GPU Pod, registry image, or payment has been configured for you. To use it,
create a Runpod account, add funds/payment details in its console, and publish
the repository to GitHub. The included GitHub Actions workflow builds the
Docker image in GitHub and publishes it to GitHub Container Registry (GHCR);
no Docker engine on this PC is needed. Make the GHCR package public so Runpod
can pull it without a stored registry password. Then deploy the image with the
local controller below. Never put Runpod API keys, registry passwords, or TLS
private keys in source files or commit them.

COLMAP can run the feature-matching stages on the CPU, but the dense
`patch_match_stereo` stage used here requires CUDA support. If COLMAP is missing,
or was built without CUDA, scans are disabled or fail explicitly; the app never
pretends an uploaded model or failed reconstruction is a completed scan.

### Windows installation

Download the **CUDA-enabled Windows archive** from the official COLMAP
[4.2.1 release](https://github.com/colmap/colmap/releases/tag/4.2.1):
`colmap-x64-windows-cuda.zip`. Its official SHA-256 is
`e9c5cbd84c2ea986d2e970a2473fc2d2e6b34a2cdcf5d3df2765c319a63af881`.

Extract the archive to:

```text
%LOCALAPPDATA%\Programs\COLMAP\4.2.1
```

Set the Windows user's `COLMAP_PATH` to the full path to
`%LOCALAPPDATA%\Programs\COLMAP\4.2.1\bin\colmap.exe` and add its `bin` folder
to the user's `PATH`. Restart VS Code or PowerShell after changing user
environment variables. To configure only the current PowerShell session:

```powershell
$colmapBin = Join-Path $env:LOCALAPPDATA "Programs\COLMAP\4.2.1\bin"
$env:COLMAP_PATH = Join-Path $colmapBin "colmap.exe"
$env:PATH = "$colmapBin;$env:PATH"
```

Check that the same terminal used to run the app can find COLMAP:

```powershell
colmap -h
```

Check the CUDA-enabled command-line program from the same terminal used to run
the app:

```powershell
& $env:COLMAP_PATH -h
```

Verify that the GPU and driver are visible to the same terminal:

```powershell
nvidia-smi -L
```

The app disables scan submission unless it finds both the COLMAP CLI and an
NVIDIA GPU. The first COLMAP feature-matching stage can use the CPU or CUDA GPU, and this app
enables GPU-based feature extraction and matching. The
dense reconstruction stage needs a compatible CUDA-enabled COLMAP build and
GPU. The bundled `colmap.exe` output identifies whether it was built with
CUDA. Merely having NVIDIA hardware does not guarantee every COLMAP binary can
use it; COLMAP will report an explicit scan failure if its CUDA runtime is
incompatible.

## Run locally

From this directory:

```powershell
npm install
npm run dev
```

Open <http://localhost:5173>. The Vite development server proxies API and model
requests to the local API at <http://localhost:3001>. Camera access works on
`localhost` after the browser grants camera permission.

### iPhone Safari on the same Wi-Fi

Install [mkcert](https://github.com/FiloSottile/mkcert) on Windows, then create
a certificate for the computer's LAN IP and the loopback hosts:

```powershell
mkcert -install
$lanIp = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -First 1 -ExpandProperty IPAddress
$keyPath = Join-Path $env:TEMP "realresale-key.pem"
$certPath = Join-Path $env:TEMP "realresale-cert.pem"
mkcert -key-file $keyPath -cert-file $certPath localhost 127.0.0.1 $lanIp
$env:REALRESALE_HTTPS_KEY = $keyPath
$env:REALRESALE_HTTPS_CERT = $certPath
npm run dev
```

The iPhone must trust the local certificate authority created by mkcert. Export
only its public root certificate (`mkcert -CAROOT` → `rootCA.pem`), install that
certificate profile on the iPhone, and enable full trust in **Settings → General
→ About → Certificate Trust Settings**. Never transfer or install `rootCA-key.pem`.
Then open `https://<PC-LAN-IP>:5173` in Safari. The Vite proxy keeps the API on
the PC; the camera stream remains in Safari.

For a standalone PWA build, create the bundle with `npm run build`, set
`NODE_ENV=production`, `HOST=0.0.0.0`, and the same certificate environment
variables, then run `npm start`. It serves HTTPS on port 3001; open
`https://<PC-LAN-IP>:3001` and add it to the iPhone Home Screen:

```powershell
npm run build
$env:NODE_ENV = "production"
$env:HOST = "0.0.0.0"
$env:REALRESALE_HTTPS_KEY = $keyPath
$env:REALRESALE_HTTPS_CERT = $certPath
npm start
```

## Runpod GPU Pod (optional)

The [Dockerfile](./Dockerfile) packages the app with the official CUDA-enabled
COLMAP runtime, pinned by image digest. After pushing this repository to GitHub
on its `main` branch, the
[image workflow](./.github/workflows/publish-cloud-image.yml) builds and
publishes `ghcr.io/OWNER/REALRESALE:main`. The first published GHCR package may
be private: in GitHub, open the package settings and change its visibility to
**Public** so Runpod can pull it without registry credentials. The app source
in this repository is also sent to a public container image; do not include
secrets in the repository or Docker build context.

```powershell
# Save the Runpod API key encrypted for the current Windows user.
.\scripts\realresale-cloud.ps1 configure

# Deploy the public image after the workflow has completed and the
# ghcr.io/OWNER/REALRESALE package is public.
.\scripts\realresale-cloud.ps1 deploy -Image ghcr.io/OWNER/REALRESALE:main

# Check, start, or stop the remote server later from this PC.
.\scripts\realresale-cloud.ps1 status
.\scripts\realresale-cloud.ps1 start
.\scripts\realresale-cloud.ps1 stop
```

Before running `configure`, create a Runpod API key in the Runpod console with
Pod management permissions and add funds/payment details in Billing. The key is
entered into a hidden PowerShell prompt and saved encrypted using Windows
DPAPI under `%LOCALAPPDATA%\RealResaleCloud`, outside the repository. The
controller saves the Pod ID and image there too. Never paste the API key into
chat, a command-line argument, or a source file.

The controller creates one **on-demand, non-interruptible NVIDIA L40S** Pod
(48 GB VRAM), exposes HTTP port `3001`, and attaches a 50 GB persistent Pod
volume at `/workspace`. The server stores the database, uploaded videos, and
reconstruction work there. Runpod supplies HTTPS at
`https://<POD_ID>-3001.proxy.runpod.net`. Open the URL on an iPhone or other
phone to use the web app; camera access is available in Safari/Chrome on that
HTTPS origin, subject to the browser's orientation and torch support. The site
is public while the Pod runs. The MVP has local username/password accounts and
private buyer-seller conversations, but no email verification, account
recovery, moderation, or production-grade abuse protection; do not treat it as
production-ready.

As of October 2026, Runpod lists the L40S starting at `$1.09/hour`. The 50 GB
persistent Pod volume is currently billed at `$0.10/GB/month` while running
and `$0.20/GB/month` while stopped (about `$10/month` while stopped); the 30 GB
container disk is listed at `$0.10/GB/month`. Secure Cloud, location, supply,
and account pricing may differ from these starting rates. GPU billing runs
for every hour the Pod is active, including idle time; the provider does not
automatically stop it at a spending limit. Storage alone can consume a
significant part of a `$30/month` budget, before GPU hours, tax, and any other
costs. Check the exact rate in the console before confirming deployment and
monitor billing. See
[Runpod GPU pricing](https://www.runpod.io/pricing),
[storage rates](https://docs.runpod.io/pods/storage/types), and
[HTTP port exposure](https://docs.runpod.io/pods/configuration/expose-ports).
The Pod is a rented cloud server, not a server owned by RealResale. It stays
available at its public URL while running. `stop` releases the GPU and takes
the website offline; the persistent volume remains and continues to be billed.
`start` resumes the same Pod and data. The script intentionally does not
terminate or delete storage. To permanently delete the environment and stop
storage charges, back up the data, then terminate the Pod from the Runpod
console and confirm deletion there.

The repository ignores local `.env*` files (except an optional safe
`.env.example`), TLS `.pem`/`.key` files, SQLite files, and the runtime `data/`
directory. Ignore rules only prevent new untracked files from being added;
they do not remove files that were committed earlier. Check repository history
and rotate any credential that was ever committed.

This one-Pod deployment serves both the web app and the COLMAP job queue, so it
is available only while the GPU Pod is running. Initial image publishing
requires pushing the repository and enabling its GitHub Actions workflow.
Cloud deployment requires running `configure` and explicitly typing `DEPLOY`;
the project does not create cloud resources or incur charges until those steps.

## Seller and buyer flow

1. Enter the product name, price, category, and description before capture.
   Changes can be saved while reconstruction runs.
2. On a secure origin, the seller grants camera and device-orientation access,
   then taps the product in the live preview. MediaPipe Interactive Segmenter
   runs in the browser and provides product framing guidance; its WASM and
   model are downloaded from jsDelivr and Google Storage. The video frames
   themselves are not sent to those model hosts.
3. The seller follows the on-screen aim point and turn direction through two
   180-degree heading sectors, turning or lifting the item as needed. The
   browser samples orientation, checks framing and brightness, and attempts to
   enable the camera torch when the scene is dark. A browser does not show a
   separate flashlight permission prompt: torch use is gated by camera access
   and support in the camera track. The app blocks scanning if torch control is
   unavailable. iPhone Safari camera access requires HTTPS and a certificate
   the iPhone trusts. Browser support for orientation sensors and torch varies;
   test on the target iPhone before relying on it.
4. The browser previews frames and applies sharpness and near-duplicate
   filtering. It requires at least 12 accepted frames from each guided pass
   (24 total). The original two clips are uploaded to the PC-hosted server;
   their combined size is limited to 512 MB. The server independently extracts
   frames, verifies image dimensions, and runs additional registration checks.
5. A required 20–30 second close-up video is captured at 4K source resolution.
   The server independently extracts candidate images, requires at least 20
   sharp frames whose longest dimension is at least 3840 pixels, and keeps those
   images as full-resolution condition evidence. The app also requires the
   selected product mask to fill 55–88% of the camera view before close-up
   recording starts.
6. COLMAP runs feature extraction and matching, camera alignment, dense stereo,
   and point-cloud fusion using the two whole-item passes. Close-up frames are
   deliberately kept out of that whole-item reconstruction: mixing macro
   views into one model can destabilize camera registration. The RGB PLY is not
   the detail evidence; buyers open the separate 4K images and original close-up
   video to inspect surface condition.
7. A seller cannot submit a listing unless the server marks reconstruction
   `ready`, the required close-up video exists, and at least 20 high-resolution
   frames pass the server's sharpness filter. Buyers can inspect the model,
   source photos, close-up evidence, and all three original videos, then start
   a private one-to-one conversation with the seller.

The two heading sectors are a capture guide, not proof that every physical
surface was actually shown. The browser cannot reliably verify that the phone
orbited the product rather than rotating in place. The 4K close-up and its
quality gates increase the chance that a roughly 0.5 mm flaw is represented in
the submitted evidence, but do not detect flaws automatically or guarantee that
any particular defect is visible. Focus, lens quality, lighting, distance,
surface reflectivity, and occlusion all matter; test real items and compare
against known defects before relying on this for resale decisions. Background
segmentation currently guides live framing only; it is not applied to server
reconstruction.

Accounts use local usernames and scrypt-hashed passwords. Sessions use an
HttpOnly cookie. Email verification and password recovery are not implemented.
Messages are private to the buyer and seller; there is no public chat feed.

Processing can take several minutes or longer. The scan screen shows progress
based on completed pipeline stages, prepared frames, and depth maps; it is not a
time-remaining estimate. A local `npm run dev` run uses the local CUDA-enabled
COLMAP install and NVIDIA GPU; a deployed Pod uses its attached CUDA GPU.
COLMAP workspaces and uploaded originals are stored under the ignored local
`data/` directory or the remote Pod's `/workspace/realresale-data` directory,
respectively. Scan status is recorded in SQLite. A server restart marks
interrupted work as failed rather than exposing an unfinished model.

## Validation

```powershell
npm test
npm run check
npm run build
npm audit
```

There is no marketplace payment or shipping. Local accounts and private
buyer-seller messaging are implemented, but authentication and operations are
not production-hardened. The Runpod Pod URL is publicly reachable while the
Pod is running; use it only for a private MVP test, not real transactions.
Smartphone camera access requires the public HTTPS Pod URL. The local PC
development server is not a public website.

Before a public beta, review the detailed blockers and validation requirements
in [LAUNCH_READINESS.md](./LAUNCH_READINESS.md).
