import { createWorker, PSM } from "tesseract.js";
import "../style.css";

const elements = {
  imageInput: document.querySelector("#imageInput"),
  cameraFrame: document.querySelector("#cameraFrame"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraGuideRegion: document.querySelector(".camera-guide span"),
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
let currentImageUrl = "";
let requestId = 0;
let cameraStream = null;
let liveScanId = 0;

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

function extractStudentId(text) {
  const cleanedText = text.toUpperCase().replace(/[|]/g, "I");
  const compact = cleanedText.replace(/[^A-Z0-9]/g, "");

  // RVCE card IDs (for example RVCE25BCS104) and RVCE USNs are both used
  // on member cards. OCR may insert spaces or confuse 0/O and 1/I.
  const rvceId = compact.match(/RVCE\d{2}[A-Z]{2,4}\d{2,4}/);
  if (rvceId) return rvceId[0];

  const repaired = compact
    .replace(/^I(?=R[ZV])/, "1")
    .replace(/(?<=1R[ZV]\d{2}[A-Z]{2,3})[OQ]/g, "0");
  const usn = repaired.match(/1R[ZV]\d{2}[A-Z]{2,3}\d{2,3}/);
  if (usn) return usn[0];

  // Restrict a second pass to text near an ID label to avoid returning a
  // course code or another number elsewhere on the card.
  const labeled = cleanedText.match(/(?:STUDENT\s*ID|USN|ID\s*NO)\s*[:\-]?\s*([A-Z0-9\s|]{8,24})/);
  if (labeled) {
    const candidate = labeled[1].replace(/[^A-Z0-9]/g, "");
    const labeledRvceId = candidate.match(/RVCE\d{2}[A-Z]{2,4}\d{2,4}/);
    if (labeledRvceId) return labeledRvceId[0];
    const labeledUsn = candidate.replace(/^I(?=R[ZV])/, "1").match(/1R[ZV]\d{2}[A-Z]{2,3}\d{2,3}/);
    if (labeledUsn) return labeledUsn[0];
  }
  return "Not found";
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
    const activeWorker = await loadOcrWorker();
    if (thisRequest !== requestId) return;
    const ocrStartedAt = performance.now();
    const result = await activeWorker.recognize(file);
    if (thisRequest !== requestId) return;

    const rawText = result.data.text?.trim() || "No readable text found.";
    const studentId = extractStudentId(rawText);
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
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function scanVideoFrames(scanId) {
  const startedAt = performance.now();
  let frameCount = 0;
  const video = elements.cameraPreview;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  try {
    const activeWorker = await loadOcrWorker();
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

      const result = await activeWorker.recognize(canvas);
      if (scanId !== liveScanId || !cameraStream) return;
      frameCount += 1;

      const rawText = result.data.text?.trim() || "No readable text in this frame.";
      const studentId = extractStudentId(rawText);
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
  if (worker) void worker.terminate();
});

void loadOcrWorker().catch(() => {
  // The status message explains how to retry when the user selects an image.
});
