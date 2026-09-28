# Offline Static Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save supported same-origin images and icon fonts beside each demo so editor and player can replay them without VPN, while reporting assets that could not be captured.

**Architecture:** A recorder-side collector discovers static resource URLs in rrweb events and browser resource entries, fetches allowlisted same-origin bytes, and streams bounded chunks to the existing side panel. The side panel persists content-addressed files and a versioned index. Editor and player create temporary Blob URLs, rewrite only replay copies of asset references, and surface coverage status.

**Tech Stack:** TypeScript, React, `@rrweb/record`, `@rrweb/replay`, Chrome/Edge MV3, File System Access API, Node test runner, Playwright-core Edge smoke test.

**Spec:** `docs/superpowers/specs/2026-09-26-offline-assets-design.md`

## Global Constraints

- Do not modify the recorded Web platform, add `debugger` permission, upload assets, or change the existing hotspot and playback-speed behavior.
- Auto-fetch only the recorded page's HTTP(S) origin and still-valid same-origin `blob:` URLs. `data:` and inline SVG need no separate file. Report discovered cross-origin and unreadable resources as failures.
- Accept only supported image/SVG/font bytes; reject HTML and scripts. Limit one resource to 10 MB and unique stored bytes per demo to 200 MB.
- Capture concurrency is 4, per-resource timeout 10 seconds, and recorder-stop drain timeout 30 seconds.
- New demos use format version 2; version 1 remains readable, unchanged, and labelled as having no offline assets.
- `complete` means only discovered supported resources were saved; never imply the entire Web site is offline. Redact query and fragment in user-visible failure URLs.
- This workspace is not a Git repository. Do not initialize one or run commit commands; use test/build checkpoints in place of commits.

## Review Focus

- A resource URL with a query token or fragment must match exactly for replay, but the UI must not reveal the token; Task 1 tests both.
- A same-origin URL returning HTML, an error status, or >10 MB must be a named failure rather than a saved asset; Task 2 and Task 3 test this.
- Two different URLs returning identical bytes must consume storage only once while both replay references resolve; Task 2 tests the index and Task 4 tests replay.
- `srcset` and quoted CSS `url(...)`, including external SVG fragments, must map to local bytes without contacting the original server; Task 1 and Task 4 test this.
- A tab reload or side-panel disconnect during capture must preserve recorded events and mark pending assets incomplete; Task 3 tests this.

---

### Task 1: Asset references and versioned model

**Files:** Create `src/asset-refs.ts`, `tests/assets.test.ts`; modify `src/model.ts`, `package.json`.

**Interfaces:**
- Produce `AssetReference { url: string; context: 'img' | 'srcset' | 'svg' | 'css' | 'stylesheet'; firstSeenAt: number }`.
- Produce `collectAssetReferences(event: RecordedEvent, pageUrl: string): AssetReference[]`, `rewriteRecordedEvents(events: readonly RecordedEvent[], replacements: ReadonlyMap<string, string>): RecordedEvent[]`, and `redactAssetUrl(url: string): string` in `src/asset-refs.ts`.
- Produce `AssetEntry { url, context, status: 'pending' | 'saved' | 'failed', filename?, mime?, bytes?, reason? }`, `AssetIndex { version: 1, entries: AssetEntry[] }`, and `AssetSummary { discovered, saved, failed, uniqueBytes, status: 'complete' | 'partial' | 'no-candidates' | 'legacy' }` in `src/model.ts`. Extend `DemoManifest.formatVersion` to `1 | 2` and add optional `offlineAssets?: AssetSummary`; `LoadedDemo.assets` is `AssetIndex | null`.

- [ ] **Step 1: Write failing pure tests** in `tests/assets.test.ts` for a hand-built full snapshot plus mutation: `<img src>`, `srcset`, SVG `image/use`, CSS background and `@font-face url()` yield absolute candidates; navigation links, script URLs, and `data:` do not. Assert a URL with `?token=secret#icon` remains exact in the map while `redactAssetUrl()` omits query and fragment. Assert rewritten events contain Blob URLs and input events remain deep-equal to their pre-call value.
- [ ] **Step 2: Run tests to verify failure.** Run `npm.cmd test` after adding `tests/assets.test.ts` to the `test` script. Expected: missing exports or wrong candidate/rewrite assertions; existing core tests remain green.
- [ ] **Step 3: Implement minimal model and parser.** Traverse only recognized rrweb snapshot nodes, mutation attributes, inline CSS text and style-rule events. Normalize relative URLs against the recording page URL; preserve fragments for external SVG. Parse `srcset` and CSS `url()` without replacing arbitrary prose or navigation URLs.
- [ ] **Step 4: Verify.** Run `npm.cmd test` and `npm.cmd run typecheck`; both exit 0.

### Task 2: Bounded, content-addressed asset storage

**Files:** Create `src/asset-store.ts`; extend `tests/assets.test.ts`; modify `src/storage.ts`, `src/model.ts`.

**Interfaces:**
- Produce `validateAssetResponse(url: string, mime: string, bytes: Uint8Array): { mime: string; extension: string } | { reason: string }` and `summarizeAssetIndex(index: AssetIndex): AssetSummary` in `src/asset-store.ts`.
- Produce `recordAssetCandidate(root: FileSystemDirectoryHandle, demoId: string, reference: AssetReference): Promise<AssetIndex>`, `saveCapturedAsset(root: FileSystemDirectoryHandle, demoId: string, input: { url: string; mime: string; sha256: string; bytes: Uint8Array }): Promise<AssetIndex>`, `recordAssetFailure(root: FileSystemDirectoryHandle, demoId: string, input: { url: string; context: AssetReference['context']; reason: string }): Promise<AssetIndex>`, and `loadAssetFile(root: FileSystemDirectoryHandle, demoId: string, filename: string): Promise<File>` in `src/storage.ts`. File and index writes for one demo must be serialized.
- New demos create `assets/index.json`; successful files are `assets/<sha256>.<extension>`; `finishDemo()` converts pending entries to failures and copies the final summary to the manifest. `loadDemo()` loads version 2 index and returns `assets: null` for version 1.

- [ ] **Step 1: Write failing tests** for rejecting HTML and oversize bytes, accepting SVG/font MIME, converting pending entries to partial, and counting two URLs with the same SHA-256 as one stored file. Add a browser-backed storage assertion to `scripts/smoke.mjs` that a new demo creates `assets/index.json` and uses format version 2. Load a synthetic version 1 demo and assert `assets === null` without rewriting its files.
- [ ] **Step 2: Run tests to verify failure.** Run `npm.cmd test` and, with the pre-change `dist`, `npm.cmd run smoke`; each new assertion fails for the intended missing behavior.
- [ ] **Step 3: Implement minimal store.** Verify the claimed SHA-256 against bytes before writing; apply 10 MB and 200 MB limits to unique bytes; write content file before a success index entry. Keep exact URLs in the index but expose only redacted URLs to UI. Preserve existing `EventBatch` writes and do not delete user demos or change version 1 files.
- [ ] **Step 4: Verify.** Run `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`, and `npm.cmd run smoke`; each exits 0.

### Task 3: Recorder-side capture and side-panel transport

**Files:** Create `src/asset-capture.ts`, `src/asset-protocol.ts`; modify `src/recorder.ts`, `src/main.tsx`, `scripts/smoke.mjs`, `public/fixture.html`.

**Interfaces:**
- Produce `startAssetCapture(sessionId: string, pageUrl: string): { observeEvent(event: RecordedEvent): void; stop(): Promise<void> }` in `src/asset-capture.ts`.
- Port name `ASSET_CAPTURE`; JSON messages `ASSET_DISCOVERED`, `ASSET_BEGIN`, `ASSET_CHUNK`, `ASSET_END`, `ASSET_FAILED`, and side-panel `ASSET_ACK`, all keyed by session ID and asset ID. `ASSET_CHUNK` holds bounded base64 text; the side panel persists via Task 2 interfaces and acknowledges only after index/file writes.
- Content script scans rrweb events and filtered `PerformanceObserver` resource entries, fetches same-origin candidates with credentials, and sends success/failure. Side panel accepts messages only from the active session tab and records per-demo updates in a serialized queue.

- [ ] **Step 1: Extend Edge smoke test first.** Serve a small same-origin raster image, SVG image, CSS background image, and font fixture from distinct URLs; after recording, assert the index has saved entries and files, including only one file for duplicate image bytes. Serve an HTML response disguised as an image, an oversize resource, an HTTP error, a cross-origin URL, and an external stylesheet rrweb did not inline; assert named failures without downloading scripts or XHR. Add a reload/disconnect case asserting persisted rrweb events survive and pending assets become partial.
- [ ] **Step 2: Run test to verify failure.** Run `npm.cmd run smoke` against the old build. Expected: missing asset entries/files or incomplete-state assertions fail.
- [ ] **Step 3: Implement capture and transport.** Keep the existing event-batch flow unchanged. Filter non-asset performance entries; mark an external stylesheet that cannot be safely inlined as an unsupported failure. Limit four concurrent fetches, abort each after 10 seconds, limit response bytes while reading, hash bytes, send base64 in chunks, and wait at most 30 seconds on stop. Acknowledge completed assets only after persistence; on port loss or navigation, retain pending entries for `finishDemo()` to mark failed without discarding already saved events.
- [ ] **Step 4: Verify.** Run `npm.cmd run typecheck`, `npm.cmd run build`, and `npm.cmd run smoke`; each exits 0.

### Task 4: Offline replay mapping and preloading

**Files:** Create `src/asset-replay.ts`; extend `tests/assets.test.ts`, `scripts/smoke.mjs`; modify `src/replay.tsx`, `src/main.tsx`.

**Interfaces:**
- Produce `prepareReplayAssets(root: FileSystemDirectoryHandle, demo: LoadedDemo): Promise<{ events: RecordedEvent[]; preloadThrough(at: number): Promise<void>; release(): void }>` in `src/asset-replay.ts`.
- `ReplayCanvas` receives the selected library root and `preloadThroughAt?: number`. It constructs `Replayer` only after the initial asset mapping is ready, calls `preloadThrough(0)` before starting, and preloads through the next gate in the background. It releases Blob URLs and cancels pending preloads on unmount/demo change.
- Version 1 demos return unchanged replay events and a no-op release. Missing version 2 asset files become explicit playback failures, without mutating the original event JSON.

- [ ] **Step 1: Write failing tests.** Pure tests assert exact URL, `srcset`, CSS `url()` and SVG fragment replacements without altering stored events; a browser smoke test stops the fixture server after recording and verifies captured images, CSS background and icon font remain available in editor/player, hotspot and acceleration still work, and no request for a successfully captured image/font reaches the original server. Failed entries may still request the original URL when VPN is on.
- [ ] **Step 2: Run tests to verify failure.** Run `npm.cmd test` and `npm.cmd run smoke` on the pre-change build. Expected: replacement/offline assertions fail.
- [ ] **Step 3: Implement replay preparation.** Read only indexed files, create MIME-aware Blob URLs, rewrite a copy through Task 1, and predecode initial/next-step images with bounded concurrency. Failed entries retain their original URL for VPN-on fallback and report partial status. Do not block hotspot interaction on noncritical preloads; keep editor seek and player gate timestamps unchanged.
- [ ] **Step 4: Verify.** Run `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`, and `npm.cmd run smoke`; each exits 0.

### Task 5: Coverage UI, documentation, and final acceptance

**Files:** Modify `src/main.tsx`, `src/styles.css`, `README.md`, `scripts/smoke.mjs`; extend `tests/assets.test.ts` for summary copy and URL redaction.

**Interfaces:** The side panel, editor and player use `AssetSummary` from Task 2. Display saved/discovered counts and a failure list with resource context, redacted URL and reason; show distinct complete/partial/no-candidates/legacy states. No new permission prompt or data upload.

- [ ] **Step 1: Write failing browser assertions** for summary text after recording, partial state and redacted failure URLs, legacy version 1 notice, and warning when an indexed file is missing. Assert saved-asset status does not claim the entire site is offline.
- [ ] **Step 2: Run test to verify failure.** Run `npm.cmd run smoke` against the pre-change build. Expected: new UI assertions fail.
- [ ] **Step 3: Implement UI and README.** Keep status visible but non-blocking; do not prevent editing or playback of partial demos. Document 10 MB/200 MB limits, unsupported resource classes, local-only storage, and the need to re-record old demos while VPN is connected.
- [ ] **Step 4: Final verification.** Run `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, and `npm.cmd run smoke` from the workspace root. Record output for each; inspect the browser screenshot and measure demo size, open time and maximum frame gap against the same fixture without resource capture. Report that real VPN-site acceptance remains user-side unless access is supplied.

## Execution Note

The tasks are coupled through the new `AssetReference`, `AssetIndex`, and capture protocol interfaces, so execute them in order. The folder has no `.git`; do not initialize a repository or pretend commits exist. Each task ends at a green test/build checkpoint, and any unexpected browser limitation should pause implementation for a design decision rather than adding `debugger` permission silently.
