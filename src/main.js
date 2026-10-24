import { createWorker, PSM } from "tesseract.js";
import "../style.css";

const elements = {
  imageInput: document.querySelector("#imageInput"),
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
  const tokens = cleanedText.match(/[A-Z0-9][A-Z0-9\s-]{7,18}[A-Z0-9]/g) || [];

  for (const token of tokens) {
    const compact = token.replace(/[^A-Z0-9]/g, "");
    const repaired = compact
      .replace(/^I(?=R[ZV])/, "1")
      .replace(/(?<=1R[ZV]\d{2}[A-Z]{2,3})[OQ]/g, "0");
    const match = repaired.match(/1R[ZV]\d{2}[A-Z]{2,3}\d{2,3}/);
    if (match) return match[0];
  }
  return "Not found";
}

function extractStudentName(text) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const nameIndex = lines.findIndex((line) => /\b(?:student\s*)?name\b/i.test(line));

  if (nameIndex >= 0) {
    const labeledLine = lines[nameIndex];
    const value = labeledLine.replace(/^.*?\b(?:student\s*)?name\b\s*[:\-]?\s*/i, "").trim();
    if (/[A-Za-z]{2,}/.test(value)) return value;
    if (lines[nameIndex + 1] && !/\b(?:usn|student\s*id|id\s*no)\b/i.test(lines[nameIndex + 1])) {
      return lines[nameIndex + 1];
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

elements.imageInput.addEventListener("change", () => {
  const file = elements.imageInput.files?.[0];
  void processImage(file);
});

window.addEventListener("pagehide", () => {
  if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
  if (worker) void worker.terminate();
});

void loadOcrWorker().catch(() => {
  // The status message explains how to retry when the user selects an image.
});
