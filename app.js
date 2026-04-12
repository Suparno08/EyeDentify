const STUDENT_STORAGE_KEY = "skillx.faceStudents.v1";
const ATTENDANCE_STORAGE_KEY = "skillx.faceAttendance.v1";
const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
const MATCH_THRESHOLD = 0.48;
const SCAN_INTERVAL_MS = 1300;
const RECOGNITION_COOLDOWN_MS = 12000;

const enrollmentForm = document.getElementById("enrollment-form");
const referenceImagesInput = document.getElementById("student-reference-images");
const referencePreviewGrid = document.getElementById("reference-preview-grid");
const enrollmentStatus = document.getElementById("enrollment-status");
const lookupForm = document.getElementById("lookup-form");
const summaryPanel = document.getElementById("student-summary");
const studentGallery = document.getElementById("student-gallery");
const attendanceTableBody = document.getElementById("attendance-table-body");
const registerSummary = document.getElementById("register-summary");
const scanStatusPanel = document.getElementById("scan-status-panel");
const downloadCsvButton = document.getElementById("download-csv");
const writeCsvButton = document.getElementById("write-csv");
const sheetStatus = document.getElementById("sheet-status");
const loadModelsButton = document.getElementById("load-models");
const startCameraButton = document.getElementById("start-camera");
const stopCameraButton = document.getElementById("stop-camera");
const modelsBadge = document.getElementById("models-badge");
const cameraBadge = document.getElementById("camera-badge");
const studentCountBadge = document.getElementById("student-count-badge");
const cameraFeed = document.getElementById("camera-feed");
const faceOverlay = document.getElementById("face-overlay");
const videoShell = document.querySelector(".video-shell");
const videoPlaceholder = document.getElementById("video-placeholder");
const preloader = document.getElementById("preloader");

let students = loadState(STUDENT_STORAGE_KEY);
let attendanceRecords = loadState(ATTENDANCE_STORAGE_KEY);
let modelsReady = false;
let faceMatcher = null;
let cameraStream = null;
let scanTimer = null;
let isScanRunning = false;
let cooldownByRoll = new Map();

referenceImagesInput.addEventListener("change", handleReferencePreview);
enrollmentForm.addEventListener("submit", handleEnrollmentSubmit);
lookupForm.addEventListener("submit", handleLookupSubmit);
downloadCsvButton.addEventListener("click", handleCsvDownload);
writeCsvButton.addEventListener("click", handleCsvFileWrite);
loadModelsButton.addEventListener("click", ensureModelsLoaded);
startCameraButton.addEventListener("click", startCamera);
stopCameraButton.addEventListener("click", stopCamera);
window.addEventListener("beforeunload", stopCamera);
window.addEventListener("load", hidePreloader);

renderAll();
bootstrap();

function hidePreloader() {
  if (!preloader) {
    return;
  }

  setTimeout(() => {
    preloader.classList.add("hidden");
  }, 900);
}

function detectionOptions() {
  return new faceapi.TinyFaceDetectorOptions({
    inputSize: 320,
    scoreThreshold: 0.5
  });
}

async function bootstrap() {
  if (!window.faceapi) {
    setScanMessage("Face recognition library did not load. Check internet access and refresh the page.", true);
    return;
  }

  await ensureModelsLoaded();
}

function loadState(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.error(`Unable to read ${key}:`, error);
    return [];
  }
}

function saveState(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function renderAll() {
  rebuildMatcher();
  renderStudentGallery();
  renderAttendanceRegister();
  updateStudentCountBadge();
}

function updateStudentCountBadge() {
  studentCountBadge.textContent = `${students.length} student(s) enrolled`;
  studentCountBadge.className = `badge ${students.length ? "ok" : "muted"}`;
}

async function handleReferencePreview(event) {
  const files = Array.from(event.target.files || []);

  if (files.length === 0) {
    referencePreviewGrid.className = "preview-grid empty-state-panel";
    referencePreviewGrid.textContent = "Select one or more clear face photos.";
    return;
  }

  try {
    const previewImages = await Promise.all(files.map(async (file) => ({
      name: file.name,
      dataUrl: await readFileAsDataUrl(file)
    })));

    referencePreviewGrid.className = "preview-grid";
    referencePreviewGrid.innerHTML = previewImages.map((image) => `
      <article class="preview-card">
        <img class="preview-thumb" src="${image.dataUrl}" alt="${escapeHtml(image.name)}">
        <span>${escapeHtml(image.name)}</span>
      </article>
    `).join("");
  } catch (error) {
    console.error(error);
    setStatus(enrollmentStatus, "Could not preview the selected images.", true);
  }
}

async function handleEnrollmentSubmit(event) {
  event.preventDefault();
  clearStatus(enrollmentStatus);

  if (!modelsReady) {
    setStatus(enrollmentStatus, "Load the face models before registering students.", true);
    return;
  }

  const name = document.getElementById("student-name").value.trim();
  const rollNumber = document.getElementById("student-roll").value.trim().toUpperCase();
  const department = document.getElementById("student-department").value.trim();
  const files = Array.from(referenceImagesInput.files || []);

  if (!name || !rollNumber || !department || files.length === 0) {
    setStatus(enrollmentStatus, "Fill all fields and choose previous student face photos.", true);
    return;
  }

  const successfulReferences = [];
  const skippedFiles = [];

  for (const file of files) {
    try {
      const compressedDataUrl = await compressImage(file, 640, 0.86);
      const image = await createImageElement(compressedDataUrl);
      const detections = await faceapi
        .detectAllFaces(image, detectionOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (detections.length !== 1) {
        skippedFiles.push(`${file.name} (need exactly one face)`);
        continue;
      }

      successfulReferences.push({
        imageDataUrl: compressedDataUrl,
        descriptor: Array.from(detections[0].descriptor)
      });
    } catch (error) {
      console.error(error);
      skippedFiles.push(`${file.name} (face not processed)`);
    }
  }

  if (successfulReferences.length === 0) {
    setStatus(enrollmentStatus, "No usable face photo was found. Use clear images with one visible face.", true);
    return;
  }

  const existingStudent = students.find((student) => student.rollNumber === rollNumber);
  const mergedImages = existingStudent
    ? [...existingStudent.referenceImages, ...successfulReferences.map((item) => item.imageDataUrl)]
    : successfulReferences.map((item) => item.imageDataUrl);
  const mergedDescriptors = existingStudent
    ? [...existingStudent.referenceDescriptors, ...successfulReferences.map((item) => item.descriptor)]
    : successfulReferences.map((item) => item.descriptor);

  const studentRecord = {
    id: existingStudent ? existingStudent.id : crypto.randomUUID(),
    name,
    rollNumber,
    department,
    referenceImages: mergedImages.slice(-6),
    referenceDescriptors: mergedDescriptors.slice(-6),
    updatedAt: new Date().toISOString()
  };

  students = [
    ...students.filter((student) => student.rollNumber !== rollNumber),
    studentRecord
  ].sort((left, right) => left.rollNumber.localeCompare(right.rollNumber));

  saveState(STUDENT_STORAGE_KEY, students);
  rebuildMatcher();
  renderStudentGallery();
  updateStudentCountBadge();

  enrollmentForm.reset();
  referencePreviewGrid.className = "preview-grid empty-state-panel";
  referencePreviewGrid.textContent = "Select one or more clear face photos.";

  const skippedText = skippedFiles.length ? ` Skipped: ${skippedFiles.join(", ")}.` : "";
  setStatus(enrollmentStatus, `Registered ${name} with ${successfulReferences.length} face photo(s).${skippedText}`);
}

function renderStudentGallery() {
  if (students.length === 0) {
    studentGallery.className = "student-gallery empty-state-panel";
    studentGallery.textContent = "No students enrolled yet.";
    return;
  }

  studentGallery.className = "student-gallery";
  studentGallery.innerHTML = students.map((student) => `
    <article class="student-card">
      <div class="student-card-header">
        <h3>${escapeHtml(student.name)}</h3>
        <p>${escapeHtml(student.rollNumber)} | ${escapeHtml(student.department)}</p>
      </div>
      <div class="student-card-grid">
        ${student.referenceImages.map((image, index) => `
          <img class="gallery-thumb" src="${image}" alt="${escapeHtml(student.name)} reference ${index + 1}">
        `).join("")}
      </div>
    </article>
  `).join("");
}

function rebuildMatcher() {
  if (!window.faceapi || students.length === 0) {
    faceMatcher = null;
    return;
  }

  const labeledDescriptors = students
    .filter((student) => student.referenceDescriptors && student.referenceDescriptors.length > 0)
    .map((student) => new faceapi.LabeledFaceDescriptors(
      student.rollNumber,
      student.referenceDescriptors.map((descriptor) => new Float32Array(descriptor))
    ));

  faceMatcher = labeledDescriptors.length ? new faceapi.FaceMatcher(labeledDescriptors, MATCH_THRESHOLD) : null;
}

async function ensureModelsLoaded() {
  if (modelsReady || !window.faceapi) {
    updateModelsBadge();
    return;
  }

  setScanMessage("Loading face recognition models. Please wait.");

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);

    modelsReady = true;
    updateModelsBadge();
    setScanMessage("Face models loaded. Register students or start the front camera.");
  } catch (error) {
    console.error(error);
    setScanMessage("Could not load face models. Use localhost and internet access, then refresh.", true);
    updateModelsBadge();
  }
}

function updateModelsBadge() {
  modelsBadge.textContent = modelsReady ? "Models loaded" : "Models not loaded";
  modelsBadge.className = `badge ${modelsReady ? "ok" : "error"}`;
}

async function startCamera() {
  if (!modelsReady) {
    setScanMessage("Load the face models before starting the camera.", true);
    return;
  }

  if (!faceMatcher || students.length === 0) {
    setScanMessage("Register at least one student before live scanning.", true);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setScanMessage("This browser does not support camera access.", true);
    return;
  }

  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    setScanMessage("Open this project using localhost. Do not open index.html directly.", true);
    return;
  }

  try {
    if (cameraStream) {
      stopCamera();
    }

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });

    cameraFeed.srcObject = cameraStream;
    await cameraFeed.play();
    videoShell.classList.add("camera-active");
    videoPlaceholder.hidden = true;
    setCameraBadge(true);
    setScanMessage("Camera started. Keep only one student face in front of the camera.");
    startScanLoop();
  } catch (error) {
    console.error(error);
    setCameraBadge(false);
    setScanMessage("Camera could not start. Check browser permission for the front camera.", true);
  }
}

function stopCamera() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }

  isScanRunning = false;

  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  cameraFeed.pause();
  cameraFeed.srcObject = null;
  videoShell.classList.remove("camera-active");
  videoPlaceholder.hidden = false;
  clearOverlay();
  setCameraBadge(false);
}

function setCameraBadge(isOn) {
  cameraBadge.textContent = isOn ? "Camera on" : "Camera off";
  cameraBadge.className = `badge ${isOn ? "ok" : "muted"}`;
}

function startScanLoop() {
  if (scanTimer) {
    clearInterval(scanTimer);
  }

  scanTimer = setInterval(processLiveFrame, SCAN_INTERVAL_MS);
  processLiveFrame();
}

async function processLiveFrame() {
  if (isScanRunning || !cameraStream || !faceMatcher || cameraFeed.readyState < 2) {
    return;
  }

  isScanRunning = true;

  try {
    const detections = await faceapi
      .detectAllFaces(cameraFeed, detectionOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();

    drawDetections(detections);

    if (detections.length === 0) {
      setScanMessage("No face detected. Ask the student to look at the front camera.");
      return;
    }

    if (detections.length > 1) {
      setScanMessage("More than one face detected. Keep only one student in the camera frame.", true);
      return;
    }

    const detection = detections[0];
    const bestMatch = faceMatcher.findBestMatch(detection.descriptor);

    if (bestMatch.label === "unknown") {
      setScanResultCard({
        title: "Face not matched",
        tone: "fail",
        description: "The live face does not match any registered student. Attendance was not marked.",
        distance: bestMatch.distance
      });
      return;
    }

    const student = students.find((item) => item.rollNumber === bestMatch.label);
    if (!student) {
      setScanMessage("Matched label found, but student record is missing.", true);
      return;
    }

    const cooldownUntil = cooldownByRoll.get(student.rollNumber) || 0;
    if (Date.now() < cooldownUntil) {
      return;
    }

    const today = getLocalDateKey(new Date());
    const alreadyMarked = attendanceRecords.find((record) => record.rollNumber === student.rollNumber && record.dateKey === today);
    const livePhoto = captureFaceCrop(cameraFeed, detection.detection.box);

    if (alreadyMarked) {
      cooldownByRoll.set(student.rollNumber, Date.now() + RECOGNITION_COOLDOWN_MS);
      setScanResultCard({
        title: `${student.name} already marked today`,
        tone: "ok",
        description: `Face matched, but attendance for ${formatHumanDate(today)} already exists.`,
        distance: bestMatch.distance,
        imageDataUrl: livePhoto
      });
      return;
    }

    const now = new Date();
    const record = {
      id: crypto.randomUUID(),
      studentId: student.id,
      name: student.name,
      rollNumber: student.rollNumber,
      department: student.department,
      dateKey: today,
      dateLabel: formatHumanDate(today),
      timeLabel: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      timestamp: now.toISOString(),
      matchDistance: bestMatch.distance.toFixed(4),
      livePhoto
    };

    attendanceRecords.unshift(record);
    saveState(ATTENDANCE_STORAGE_KEY, attendanceRecords);
    renderAttendanceRegister();
    renderStudentSummary(student.rollNumber);

    cooldownByRoll.set(student.rollNumber, Date.now() + RECOGNITION_COOLDOWN_MS);
    setScanResultCard({
      title: `Attendance marked for ${student.name}`,
      tone: "ok",
      description: `Face matched with roll number ${student.rollNumber}. Attendance marked automatically.`,
      distance: bestMatch.distance,
      imageDataUrl: livePhoto
    });
  } catch (error) {
    console.error(error);
    setScanMessage("Live face scanning failed on this frame. Refresh and try again.", true);
  } finally {
    isScanRunning = false;
  }
}

function drawDetections(detections) {
  if (!cameraFeed.videoWidth || !cameraFeed.videoHeight) {
    return;
  }

  faceapi.matchDimensions(faceOverlay, {
    width: cameraFeed.videoWidth,
    height: cameraFeed.videoHeight
  });

  const resized = faceapi.resizeResults(detections, {
    width: cameraFeed.videoWidth,
    height: cameraFeed.videoHeight
  });

  const context = faceOverlay.getContext("2d");
  context.clearRect(0, 0, faceOverlay.width, faceOverlay.height);
  faceapi.draw.drawDetections(faceOverlay, resized);
}

function clearOverlay() {
  const context = faceOverlay.getContext("2d");
  context.clearRect(0, 0, faceOverlay.width, faceOverlay.height);
}

function setScanMessage(message, isError = false) {
  scanStatusPanel.classList.add("empty-state");
  scanStatusPanel.innerHTML = `<p class="${isError ? "status-message error" : "status-subtext"}">${escapeHtml(message)}</p>`;
}

function setScanResultCard({ title, tone, description, distance, imageDataUrl }) {
  scanStatusPanel.classList.remove("empty-state");
  scanStatusPanel.innerHTML = `
    <div class="match-card">
      <div class="action-row">
        <span class="match-pill ${tone === "fail" ? "fail" : ""}">${escapeHtml(title)}</span>
        <span class="match-pill">Distance: ${typeof distance === "number" ? distance.toFixed(4) : escapeHtml(distance ?? "N/A")}</span>
        <span class="match-pill">Threshold: ${MATCH_THRESHOLD}</span>
      </div>
      ${imageDataUrl ? `<img class="match-photo" src="${imageDataUrl}" alt="Live scan photo">` : ""}
      <p class="status-subtext">${escapeHtml(description)}</p>
    </div>
  `;
}

function handleLookupSubmit(event) {
  event.preventDefault();
  const rollNumber = document.getElementById("lookup-roll").value.trim().toUpperCase();

  if (!rollNumber) {
    summaryPanel.classList.add("empty-state");
    summaryPanel.innerHTML = "Enter a roll number to check attendance.";
    return;
  }

  renderStudentSummary(rollNumber);
}

function renderStudentSummary(rollNumber) {
  const student = students.find((entry) => entry.rollNumber === rollNumber);
  const studentRecords = attendanceRecords
    .filter((record) => record.rollNumber === rollNumber)
    .sort((left, right) => getSortTime(right) - getSortTime(left));

  if (!student) {
    summaryPanel.classList.add("empty-state");
    summaryPanel.innerHTML = `No registered student found for <strong>${escapeHtml(rollNumber)}</strong>.`;
    return;
  }

  const trackedDays = new Set(attendanceRecords.map((record) => record.dateKey)).size || 1;
  const presentDays = studentRecords.length;
  const percentage = ((presentDays / trackedDays) * 100).toFixed(1);

  const historyMarkup = studentRecords.length
    ? studentRecords.map((record) => `
      <article class="history-item">
        <div>
          <strong>${escapeHtml(record.dateLabel)}</strong>
          <span class="status-subtext">${escapeHtml(record.timeLabel)} | Distance ${escapeHtml(record.matchDistance)}</span>
        </div>
        <span>${escapeHtml(record.department)}</span>
      </article>
    `).join("")
    : `<p class="status-subtext">No attendance has been marked yet for this student.</p>`;

  summaryPanel.classList.remove("empty-state");
  summaryPanel.innerHTML = `
    <div class="student-meta">
      <span>${escapeHtml(student.name)}</span>
      <span>${escapeHtml(student.rollNumber)}</span>
      <span>${escapeHtml(student.department)}</span>
    </div>
    <div class="summary-grid">
      <div class="summary-stat">
        <span>Attendance %</span>
        <strong>${percentage}%</strong>
      </div>
      <div class="summary-stat">
        <span>Days Present</span>
        <strong>${presentDays}</strong>
      </div>
      <div class="summary-stat">
        <span>Tracked Class Days</span>
        <strong>${trackedDays}</strong>
      </div>
    </div>
    <div class="history-list">
      ${historyMarkup}
    </div>
  `;
}

function renderAttendanceRegister() {
  if (attendanceRecords.length === 0) {
    attendanceTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-table">No attendance records yet.</td>
      </tr>
    `;
    registerSummary.textContent = "No automatic attendance entries yet.";
    return;
  }

  const uniqueStudents = new Set(attendanceRecords.map((record) => record.rollNumber)).size;
  const uniqueDays = new Set(attendanceRecords.map((record) => record.dateKey)).size;

  registerSummary.textContent = `${attendanceRecords.length} attendance record(s), ${uniqueStudents} unique student(s), ${uniqueDays} class day(s) tracked.`;

  attendanceTableBody.innerHTML = attendanceRecords.map((record) => `
    <tr>
      <td>${escapeHtml(record.dateLabel)}</td>
      <td>${escapeHtml(record.timeLabel)}</td>
      <td>${escapeHtml(record.name)}</td>
      <td>${escapeHtml(record.rollNumber)}</td>
      <td>${escapeHtml(record.department)}</td>
      <td>${escapeHtml(record.matchDistance)}</td>
      <td>${record.livePhoto ? `<img class="table-photo" src="${record.livePhoto}" alt="${escapeHtml(record.name)} live scan">` : ""}</td>
    </tr>
  `).join("");
}

function handleCsvDownload() {
  if (attendanceRecords.length === 0) {
    setStatus(sheetStatus, "There are no attendance records to export yet.", true);
    return;
  }

  const csv = buildCsv(attendanceRecords);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = getLocalDateKey(new Date());

  link.href = url;
  link.download = `attendance-sheet-${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(url);

  setStatus(sheetStatus, "Attendance CSV downloaded. Open it in Excel.");
}

async function handleCsvFileWrite() {
  if (attendanceRecords.length === 0) {
    setStatus(sheetStatus, "Add attendance records before writing a CSV file.", true);
    return;
  }

  if (!window.showSaveFilePicker) {
    setStatus(sheetStatus, "Direct CSV writing works in Chrome or Edge. Use download if this browser does not support it.", true);
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: `attendance-sheet-${getLocalDateKey(new Date())}.csv`,
      types: [
        {
          description: "CSV Files",
          accept: { "text/csv": [".csv"] }
        }
      ]
    });

    const writable = await handle.createWritable();
    await writable.write(buildCsv(attendanceRecords));
    await writable.close();
    setStatus(sheetStatus, "Attendance sheet written to the selected CSV file.");
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus(sheetStatus, "File save canceled.");
      return;
    }

    console.error(error);
    setStatus(sheetStatus, "Could not write the CSV file. Please try again.", true);
  }
}

function buildCsv(data) {
  const headers = [
    "id",
    "studentId",
    "name",
    "rollNumber",
    "department",
    "dateKey",
    "dateLabel",
    "timeLabel",
    "timestamp",
    "matchDistance"
  ];

  const rows = data.map((record) => headers.map((header) => escapeCsv(record[header] ?? "")).join(","));
  return [headers.join(","), ...rows].join("\n");
}

function escapeCsv(value) {
  const text = String(value).replace(/"/g, '""');
  return `"${text}"`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.toggle("success", !isError);
}

function clearStatus(element) {
  element.textContent = "";
  element.classList.remove("error", "success");
}

function formatHumanDate(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function getLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSortTime(record) {
  const parsed = Date.parse(record.timestamp || `${record.dateKey}T00:00:00`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function createImageElement(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

function compressImage(file, maxWidth = 640, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const image = new Image();

      image.onload = () => {
        const scale = Math.min(1, maxWidth / image.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);

        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Canvas not supported"));
          return;
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      image.onerror = reject;
      image.src = reader.result;
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function captureFaceCrop(video, box) {
  const canvas = document.createElement("canvas");
  const padding = 36;
  const sx = Math.max(0, Math.floor(box.x - padding));
  const sy = Math.max(0, Math.floor(box.y - padding));
  const sw = Math.min(video.videoWidth - sx, Math.floor(box.width + padding * 2));
  const sh = Math.min(video.videoHeight - sy, Math.floor(box.height + padding * 2));

  if (sw <= 0 || sh <= 0) {
    return "";
  }

  canvas.width = sw;
  canvas.height = sh;

  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }

  context.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/jpeg", 0.86);
}
