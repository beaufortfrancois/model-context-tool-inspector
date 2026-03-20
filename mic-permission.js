/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const askBtn = document.getElementById('askBtn');
const statusDiv = document.getElementById('status');

async function requestPermission() {
  statusDiv.textContent = "Requesting...";
  statusDiv.className = "";
  
  try {
    // Calling this from a button click provides the required User Gesture
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Success! Stop tracks immediately
    stream.getTracks().forEach(track => track.stop());
    
    statusDiv.textContent = "✅ Permission Granted!";
    statusDiv.className = "success";
    askBtn.style.display = "none";
    
    console.log("[WebMCP] Permission granted successfully.");
    
    // Close automatically after a short delay
    setTimeout(() => window.close(), 1000);
  } catch (err) {
    console.error("[WebMCP] Permission request failed:", err);
    statusDiv.textContent = `❌ ${err.name}: ${err.message}`;
    statusDiv.className = "error";
    
    if (err.name === 'NotAllowedError') {
      statusDiv.innerHTML += `<br><br><small>Chrome is blocking the request. Check the camera icon in the address bar.</small>`;
    }
  }
}

askBtn.onclick = requestPermission;
