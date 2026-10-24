import { createWorker, PSM } from "tesseract.js";
import "../style.css";

const elements = {
  imageInput: document.querySelector("#imageInput"),
  cameraFrame: document.querySelector("#cameraFrame"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraButton: document.querySelector("#cameraButton"),
  captureButton: document.querySelector("#captureButton"),
  previewCard: document.querySelector("#previewCard"),
  preview: document.querySelector("#imagePreview"),
  imageCaption: document.querySelector("#imageCaption"),
  status: document.querySelector("#statusText"),
  statusRow: document.querySelector("#statusRow"),
  progress: document.querySelector("#progressText"),
  name: document.querySelector("#studentName"),
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
      setStatus("OCR engine ready. Take or choose a card photo.", "success");
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

function extractStudentName(text) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const fieldLabel = /^(?:student\s*id|usn|id\s*no|course|institution|college|dob|date\s*of\s*birth|valid\s*upto|blood\s*group)\b/i;
  const normalizeName = (value) => value
    .replace(/^[\s:|.\-]+/, "")
    .replace(/\s+(?:course|institution|college|dob|date\s*of\s*birth|valid\s*upto)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  for (let index = 0; index < lines.length; index += 1) {
    const labelMatch = lines[index].match(/\b(?:student\s*)?name\b\s*[:\-]?\s*(.*)$/i);
    if (!labelMatch) continue;

    const sameLineValue = normalizeName(labelMatch[1]);
    if (/[A-Za-z]{2,}/.test(sameLineValue) && !fieldLabel.test(sameLineValue)) return sameLineValue;

    // Some card layouts put the value on the next OCR line. Stop at the next
    // field label so a missing name can never be misreported as "Course".
    for (let next = index + 1; next < Math.min(index + 3, lines.length); next += 1) {
      if (fieldLabel.test(lines[next])) break;
      const nextLineValue = normalizeName(lines[next]);
      if (/[A-Za-z]{2,}/.test(nextLineValue)) return nextLineValue;
    }
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
  elements.name.textContent = "Reading…";
  elements.id.textContent = "Reading…";
  elements.fieldNote.textContent = "Extracting text from the full image. Check the suggested fields against the card.";
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
    const studentName = extractStudentName(rawText);
    const studentId = extractStudentId(rawText);
    elements.name.textContent = studentName;
    elements.id.textContent = studentId;
    elements.rawText.textContent = rawText;
    const totalSeconds = (performance.now() - selectedAt) / 1000;
    const ocrSeconds = (performance.now() - ocrStartedAt) / 1000;
    elements.latency.textContent = `${totalSeconds.toFixed(2)} s total · ${ocrSeconds.toFixed(2)} s OCR`;

    if (studentName === "Not found" || studentId === "Not found") {
      elements.fieldNote.textContent = "Some fields were not recognized. Review all recognized text below; no crop or automatic correction was applied to the image.";
    } else {
      elements.fieldNote.textContent = "Both fields were detected. Verify spelling and characters against the card.";
    }
    setStatus("OCR finished. Review the extracted fields and recognized text.", "success");
  } catch (error) {
    if (thisRequest !== requestId) return;
    elements.rawText.textContent = "OCR could not finish for this image.";
    elements.name.textContent = "Not found";
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
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
    cameraStream = null;
  }
  elements.cameraPreview.srcObject = null;
  elements.cameraFrame.hidden = true;
  elements.captureButton.disabled = true;
  elements.cameraButton.textContent = "Start camera";
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
    elements.cameraPreview.srcObject = cameraStream;
    elements.cameraFrame.hidden = false;
    await elements.cameraPreview.play();
    elements.cameraButton.textContent = "Stop camera";
    elements.captureButton.disabled = false;
    setStatus("Camera ready. Frame the full card and take a photo.", "success");
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

async function capturePhoto() {
  const video = elements.cameraPreview;
  if (!cameraStream || !video.videoWidth || !video.videoHeight) {
    setStatus("Camera is still starting. Please wait a moment and try again.", "error");
    return;
  }

  elements.captureButton.disabled = true;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  stopCamera();
  setStatus("Photo captured. Reading the card…", "scanning");
  canvas.toBlob((blob) => {
    if (!blob) {
      setStatus("Could not capture the photo. Start the camera and try again.", "error");
      return;
    }
    void processImage(new File([blob], "student-card-photo.jpg", { type: "image/jpeg" }));
  }, "image/jpeg", 0.94);
}

elements.imageInput.addEventListener("change", () => {
  const file = elements.imageInput.files?.[0];
  void processImage(file);
});

elements.cameraButton.addEventListener("click", () => {
  if (cameraStream) stopCamera();
  else void startCamera();
});
elements.captureButton.addEventListener("click", () => void capturePhoto());

window.addEventListener("pagehide", () => {
  stopCamera();
  if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
  if (worker) void worker.terminate();
});

void loadOcrWorker().catch(() => {
  // The status message explains how to retry when the user selects an image.
});
