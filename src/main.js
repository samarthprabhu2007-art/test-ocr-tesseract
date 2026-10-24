import { createWorker, PSM } from "tesseract.js";
import "../style.css";

const elements = {
  imageInput: document.querySelector("#imageInput"),
  cameraFrame: document.querySelector("#cameraFrame"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraGuideRegion: document.querySelector(".camera-guide span"),
  cameraTools: document.querySelector("#cameraTools"),
  zoomRange: document.querySelector("#zoomRange"),
  zoomValue: document.querySelector("#zoomValue"),
  flashButton: document.querySelector("#flashButton"),
  cameraToolsHint: document.querySelector("#cameraToolsHint"),
  cameraButton: document.querySelector("#cameraButton"),
  captureButton: document.querySelector("#captureButton"),
  detectedDialog: document.querySelector("#detectedDialog"),
  dialogStudentId: document.querySelector("#dialogStudentId"),
  dialogClose: document.querySelector("#dialogClose"),
  previewCard: document.querySelector("#previewCard"),
  preview: document.querySelector("#imagePreview"),
  imageCaption: document.querySelector("#imageCaption"),
  status: document.querySelector("#statusText"),
  statusRow: document.querySelector("#statusRow"),
  progress: document.querySelector("#progressText"),
  id: document.querySelector("#studentId"),
  fieldNote: document.querySelector("#fieldNote"),
  latency: document.querySelector("#latency"),
  rawText: document.querySelector("#rawText"),
};

let workerPromise;
let worker;
let extraWorkersPromise;
let extraWorkers = [];
let currentImageUrl = "";
let requestId = 0;
let cameraStream = null;
let liveScanId = 0;
let cameraTrack = null;
let torchEnabled = false;

function setStatus(message, kind = "scanning") {
  elements.status.textContent = message;
  elements.statusRow.className = `status-row status-${kind}`;
}

function loadOcrWorker() {
  if (!workerPromise) {
    setStatus("Loading English OCR engine…", "scanning");
    workerPromise = createWorker("eng", 1, {
      logger: (message) => {
        if (message.status === "loading tesseract core") setStatus("Loading OCR engine code…", "scanning");
        else if (message.status === "loading language traineddata") setStatus("Loading English language data…", "scanning");
        else if (message.status === "initializing tesseract") setStatus("Preparing OCR engine…", "scanning");
        else if (message.status === "recognizing text" && Number.isFinite(message.progress)) {
          elements.progress.textContent = `OCR progress: ${Math.round(message.progress * 100)}%`;
        }
      },
    }).then(async (createdWorker) => {
      worker = createdWorker;
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: "1",
      });
      setStatus("OCR engine ready. Start the camera to scan for an RVCE ID.", "success");
      return worker;
    }).catch((error) => {
      workerPromise = null;
      setStatus(`Could not load OCR engine: ${error?.message || error}. Check internet access and retry.`, "error");
      throw error;
    });
  }
  return workerPromise;
}

async function loadOcrWorkers() {
  const primaryWorker = await loadOcrWorker();
  if (!extraWorkersPromise) {
    extraWorkersPromise = Promise.all([PSM.SINGLE_LINE, PSM.SPARSE_TEXT].map(async (mode) => {
      const extraWorker = await createWorker("eng", 1);
      await extraWorker.setParameters({
        tessedit_pageseg_mode: mode,
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      });
      return extraWorker;
    })).then((createdWorkers) => {
      extraWorkers = createdWorkers;
      return extraWorkers;
    }).catch((error) => {
      extraWorkersPromise = null;
      throw error;
    });
  }
  return [primaryWorker, ...(await extraWorkersPromise)];
}

async function terminateOcrWorkers() {
  const activeWorkers = [...(worker ? [worker] : []), ...extraWorkers];
  worker = null;
  workerPromise = null;
  extraWorkers = [];
  extraWorkersPromise = null;
  await Promise.allSettled(activeWorkers.map((activeWorker) => activeWorker.terminate()));
}

function extractStudentId(text) {
  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digitLookalikes = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };
  const letterLookalikes = { 0: "O", 1: "I", 2: "Z", 5: "S", 6: "G", 8: "B" };
  const asDigit = (character) => /\d/.test(character) ? character : digitLookalikes[character];
  const asLetter = (character) => /[A-Z]/.test(character) ? character : letterLookalikes[character];

  // Card ID shape: RVCE + year (2 digits) + fixed B + branch (2 letters)
  // + serial (3 digits). Only accept a complete ID, correcting common OCR
  // digit/letter lookalikes in their known positions.
  let searchFrom = 0;
  while (searchFrom < compact.length) {
    const start = compact.indexOf("RVCE", searchFrom);
    if (start < 0) break;
    const candidate = compact.slice(start, start + 12);
    searchFrom = start + 4;
    if (candidate.length !== 12) continue;

    const year = `${asDigit(candidate[4]) || ""}${asDigit(candidate[5]) || ""}`;
    const commonB = candidate[6] === "B" || candidate[6] === "8" ? "B" : "";
    const branch = `${asLetter(candidate[7]) || ""}${asLetter(candidate[8]) || ""}`;
    const serial = `${asDigit(candidate[9]) || ""}${asDigit(candidate[10]) || ""}${asDigit(candidate[11]) || ""}`;
    if (/^\d{2}$/.test(year) && commonB && /^[A-Z]{2}$/.test(branch) && /^\d{3}$/.test(serial)) {
      return `RVCE${year}B${branch}${serial}`;
    }
  }

  return "Not found";
}

function createEnhancedOcrCanvas(source) {
  const scale = 1.5;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const gray = 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
    const contrast = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128));
    pixels[index] = contrast;
    pixels[index + 1] = contrast;
    pixels[index + 2] = contrast;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

async function recognizeInParallel(image) {
  const activeWorkers = await loadOcrWorkers();
  const hasCanvasDimensions = Number.isFinite(image.width) && image.width > 0
    && Number.isFinite(image.height) && image.height > 0;
  const enhancedImage = hasCanvasDimensions ? createEnhancedOcrCanvas(image) : image;
  const inputs = [image, image, enhancedImage];

  return new Promise((resolve) => {
    let completed = 0;
    let resolved = false;
    const recognizedTexts = [];
    const completeOne = () => {
      completed += 1;
      if (!resolved && completed === activeWorkers.length) {
        resolved = true;
        const bestText = recognizedTexts
          .filter(Boolean)
          .sort((first, second) => second.length - first.length)[0] || "No readable text found.";
        resolve({ text: bestText, studentId: extractStudentId(bestText) });
      }
    };

    activeWorkers.forEach((activeWorker, index) => {
      activeWorker.recognize(inputs[index]).then((result) => {
        const text = result.data.text?.trim() || "";
        recognizedTexts[index] = text;
        const studentId = extractStudentId(text);
        if (!resolved && studentId !== "Not found") {
          resolved = true;
          resolve({ text, studentId });
          return;
        }
        completeOne();
      }).catch(() => {
        completeOne();
      });
    });
  });
}

async function processImage(file) {
  const thisRequest = ++requestId;
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("Choose an image file from the camera or gallery.", "error");
    return;
  }

  if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
  currentImageUrl = URL.createObjectURL(file);
  elements.preview.src = currentImageUrl;
  elements.previewCard.hidden = false;
  elements.imageCaption.textContent = `${file.name || "Card photo"} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  elements.id.textContent = "Reading…";
  elements.fieldNote.textContent = "Searching the full image for an RVCE-format ID.";
  elements.rawText.textContent = "Processing…";
  elements.latency.textContent = "Processing";
  elements.imageInput.disabled = true;
  elements.progress.textContent = "";
  setStatus("Processing the card photo…", "scanning");
  const selectedAt = performance.now();

  try {
    await loadOcrWorkers();
    if (thisRequest !== requestId) return;
    const ocrStartedAt = performance.now();
    const result = await recognizeInParallel(file);
    if (thisRequest !== requestId) return;

    const rawText = result.text;
    const studentId = result.studentId;
    elements.id.textContent = studentId;
    elements.rawText.textContent = rawText;
    const totalSeconds = (performance.now() - selectedAt) / 1000;
    const ocrSeconds = (performance.now() - ocrStartedAt) / 1000;
    elements.latency.textContent = `${totalSeconds.toFixed(2)} s total · ${ocrSeconds.toFixed(2)} s OCR`;

    elements.fieldNote.textContent = studentId === "Not found"
      ? "No RVCE-format ID was recognized. Review the OCR text below or try a clearer photo."
      : "RVCE-format ID detected. Verify it against the card.";
    setStatus("OCR finished. Review the extracted fields and recognized text.", "success");
  } catch (error) {
    if (thisRequest !== requestId) return;
    elements.rawText.textContent = "OCR could not finish for this image.";
    elements.id.textContent = "Not found";
    elements.latency.textContent = "—";
    setStatus(`OCR failed: ${error?.message || error}`, "error");
  } finally {
    if (thisRequest === requestId) {
      elements.imageInput.disabled = false;
      elements.imageInput.value = "";
    }
  }
}

function stopCamera() {
  liveScanId += 1;
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
  elements.cameraPreview.srcObject = null;
  elements.cameraFrame.hidden = true;
  elements.captureButton.disabled = true;
  elements.cameraButton.textContent = "Start camera";
  elements.cameraTools.hidden = true;
  elements.cameraToolsHint.hidden = true;
  cameraTrack = null;
  torchEnabled = false;
  elements.flashButton.setAttribute("aria-pressed", "false");
  elements.flashButton.textContent = "Flash unavailable";
}

function setupCameraTools(track) {
  cameraTrack = track;
  torchEnabled = false;
  elements.cameraTools.hidden = false;
  elements.cameraToolsHint.hidden = false;
  elements.flashButton.setAttribute("aria-pressed", "false");

  let capabilities = {};
  let settings = {};
  try {
    capabilities = track.getCapabilities?.() || {};
    settings = track.getSettings?.() || {};
  } catch {
    // Browsers without track capability reporting get disabled controls below.
  }

  const zoom = capabilities.zoom;
  const supportsZoom = zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max) && zoom.max > zoom.min;
  elements.zoomRange.disabled = !supportsZoom;
  if (supportsZoom) {
    elements.zoomRange.min = String(zoom.min);
    elements.zoomRange.max = String(zoom.max);
    elements.zoomRange.step = String(zoom.step || 0.1);
    elements.zoomRange.value = String(Math.min(zoom.max, Math.max(zoom.min, settings.zoom ?? zoom.min)));
  } else {
    elements.zoomRange.min = "1";
    elements.zoomRange.max = "1";
    elements.zoomRange.value = "1";
  }
  elements.zoomValue.textContent = `${Number(elements.zoomRange.value).toFixed(1)}×`;

  const supportsTorch = capabilities.torch === true;
  elements.flashButton.disabled = !supportsTorch;
  elements.flashButton.textContent = supportsTorch ? "Turn flash on" : "Flash unavailable";
  elements.cameraToolsHint.textContent = [
    supportsZoom ? "Zoom supported" : "Zoom is not exposed by this device/browser",
    supportsTorch ? "flash supported" : "flash is not exposed by this device/browser",
  ].join(" · ");
}

elements.zoomRange.addEventListener("input", () => {
  elements.zoomValue.textContent = `${Number(elements.zoomRange.value).toFixed(1)}×`;
});
elements.zoomRange.addEventListener("change", async () => {
  if (!cameraTrack || elements.zoomRange.disabled) return;
  try {
    await cameraTrack.applyConstraints({ advanced: [{ zoom: Number(elements.zoomRange.value) }] });
  } catch {
    elements.cameraToolsHint.textContent = "The camera could not apply this zoom level.";
  }
});
elements.flashButton.addEventListener("click", async () => {
  if (!cameraTrack || elements.flashButton.disabled) return;
  const nextTorchState = !torchEnabled;
  try {
    await cameraTrack.applyConstraints({ advanced: [{ torch: nextTorchState }] });
    torchEnabled = nextTorchState;
    elements.flashButton.setAttribute("aria-pressed", String(torchEnabled));
    elements.flashButton.textContent = torchEnabled ? "Turn flash off" : "Turn flash on";
  } catch {
    elements.cameraToolsHint.textContent = "The camera could not change the flash setting.";
  }
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function scanVideoFrames(scanId) {
  const startedAt = performance.now();
  let frameCount = 0;
  const video = elements.cameraPreview;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  try {
    await loadOcrWorkers();
    while (scanId === liveScanId && cameraStream) {
      if (!video.videoWidth || !video.videoHeight) {
        await wait(150);
        continue;
      }

      // Crop the source frame to exactly the visible green guide. Account for
      // object-fit: contain letterboxing before mapping screen coordinates to pixels.
      const videoBounds = video.getBoundingClientRect();
      const guideBounds = elements.cameraGuideRegion.getBoundingClientRect();
      const containScale = Math.min(
        videoBounds.width / video.videoWidth,
        videoBounds.height / video.videoHeight,
      );
      const displayedWidth = video.videoWidth * containScale;
      const displayedHeight = video.videoHeight * containScale;
      const displayedLeft = videoBounds.left + (videoBounds.width - displayedWidth) / 2;
      const displayedTop = videoBounds.top + (videoBounds.height - displayedHeight) / 2;
      const cropLeft = Math.max(guideBounds.left, displayedLeft);
      const cropTop = Math.max(guideBounds.top, displayedTop);
      const cropRight = Math.min(guideBounds.right, displayedLeft + displayedWidth);
      const cropBottom = Math.min(guideBounds.bottom, displayedTop + displayedHeight);
      const sourceX = (cropLeft - displayedLeft) / containScale;
      const sourceY = (cropTop - displayedTop) / containScale;
      const sourceWidth = (cropRight - cropLeft) / containScale;
      const sourceHeight = (cropBottom - cropTop) / containScale;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        await wait(50);
        continue;
      }

      const scale = Math.min(1, 1280 / sourceWidth);
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

      const result = await recognizeInParallel(canvas);
      if (scanId !== liveScanId || !cameraStream) return;
      frameCount += 1;

      const rawText = result.text;
      const studentId = result.studentId;
      elements.rawText.textContent = rawText;

      if (studentId !== "Not found") {
        elements.id.textContent = studentId;
        elements.latency.textContent = `${((performance.now() - startedAt) / 1000).toFixed(2)} s to detect`;
        elements.fieldNote.textContent = "RVCE-format ID found in live video OCR. Check it against the card.";
        elements.progress.textContent = `ID found after ${frameCount} frame${frameCount === 1 ? "" : "s"}.`;
        setStatus("RVCE ID detected. Camera stopped.", "success");
        stopCamera();
        elements.dialogStudentId.textContent = studentId;
        if (!elements.detectedDialog.open) elements.detectedDialog.showModal();
        return;
      }

      elements.id.textContent = "Searching…";
      elements.latency.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
      elements.fieldNote.textContent = "Keep the RVCE ID in view, in focus, and well lit.";
      elements.progress.textContent = `Checked ${frameCount} frame${frameCount === 1 ? "" : "s"}. Looking for an RVCE-format ID…`;
      setStatus("Looking for an RVCE ID in the live camera…", "scanning");
      await wait(50);
    }
  } catch (error) {
    if (scanId === liveScanId) {
      setStatus(`Live OCR failed: ${error?.message || error}. Stop and restart the camera to retry.`, "error");
    }
  }
}

function scanAgain() {
  if (!cameraStream) return;
  liveScanId += 1;
  elements.id.textContent = "Searching…";
  elements.rawText.textContent = "Waiting for live OCR text…";
  elements.latency.textContent = "Searching";
  elements.progress.textContent = "";
  elements.fieldNote.textContent = "Keep the RVCE ID in view, in focus, and well lit.";
  setStatus("Looking for an RVCE ID in the live camera…", "scanning");
  void scanVideoFrames(liveScanId);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("This browser cannot access a camera. Open the site in a supported browser over HTTPS.", "error");
    return;
  }

  elements.cameraButton.disabled = true;
  setStatus("Requesting camera access…", "scanning");
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    const videoTrack = cameraStream.getVideoTracks()[0];
    try {
      if (videoTrack.getCapabilities?.().focusMode?.includes("continuous")) {
        await videoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      }
    } catch {
      // Keep the camera running if this browser or device does not support autofocus constraints.
    }
    setupCameraTools(videoTrack);
    elements.cameraPreview.srcObject = cameraStream;
    elements.cameraFrame.hidden = false;
    await elements.cameraPreview.play();
    elements.cameraButton.textContent = "Stop camera";
    elements.captureButton.disabled = false;
    elements.captureButton.textContent = "Scan again";
    elements.previewCard.hidden = true;
    elements.id.textContent = "Searching…";
    elements.rawText.textContent = "Waiting for live OCR text…";
    elements.latency.textContent = "Searching";
    setStatus("Camera ready. Searching video frames for an RVCE ID…", "scanning");
    scanAgain();
  } catch (error) {
    stopCamera();
    const message = error?.name === "NotAllowedError"
      ? "Camera permission was denied. Allow camera access in your browser settings, then try again."
      : error?.name === "NotFoundError"
        ? "No camera was found on this device. You can choose an existing photo instead."
        : error?.name === "NotReadableError"
          ? "The camera is busy in another app. Close that app and try again."
          : `Could not start the camera: ${error?.message || error}`;
    setStatus(message, "error");
  } finally {
    elements.cameraButton.disabled = false;
  }
}

elements.imageInput.addEventListener("change", () => {
  const file = elements.imageInput.files?.[0];
  stopCamera();
  void processImage(file);
});

elements.cameraButton.addEventListener("click", () => {
  if (cameraStream) stopCamera();
  else void startCamera();
});
elements.captureButton.addEventListener("click", scanAgain);
elements.dialogClose.addEventListener("click", () => elements.detectedDialog.close());

window.addEventListener("pagehide", () => {
  stopCamera();
  if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
  void terminateOcrWorkers();
});

void loadOcrWorkers().catch(() => {
  // The status message explains how to retry when the user selects an image.
});
