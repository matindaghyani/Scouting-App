/*
Hockey Scout - Single-file React front-end (App.jsx)

Instructions:
1. Create a React project (Vite or CRA). Install Tailwind CSS (optional) or use basic CSS.
2. Place this file as src/App.jsx and ensure Tailwind is configured. Alternatively adapt classes to regular CSS.
3. Start the backend at http://localhost:8000 (or set REACT_APP_API_BASE to your backend URL).

What this app does:
- On mount, it creates a session for user "user" using the current time in America/Los_Angeles (PDT/PST) as the session name.
- Shows a left sidebar of sessions (like ChatGPT). Select a session to view transcripts.
- Central area has a round microphone button to start/stop recording. When stopped, audio is uploaded to the backend and transcripts are refreshed.
- Right / bottom shows transcripts for the selected session.
- Simple form to email transcripts to an address, with an "include summary" checkbox.

Notes:
- The backend API base is read from API_BASE (window.__API_BASE__ || process.env.REACT_APP_API_BASE || 'http://localhost:8000')
- This is a single-file example. Split into components for larger projects.
*/

import React, { useEffect, useRef, useState } from "react";

const API_BASE = window.__API_BASE__ || import.meta.env.VITE_API_BASE || "http://localhost:8000";
const USER_ID = "user"; // fixed user per requirements

function formatTimestampISO(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch (e) {
    return iso;
  }
}

function pdtNowName() {
  // Use Intl to format date/time in America/Los_Angeles with short timezone name
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return fmt.format(now).replace(",", "");
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [transcripts, setTranscripts] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recorder, setRecorder] = useState(null);
  const [audioChunks, setAudioChunks] = useState([]);
  const [message, setMessage] = useState(null);
  const [emailAddress, setEmailAddress] = useState("");
  const [includeSummary, setIncludeSummary] = useState(false);
  const [loading, setLoading] = useState(false);
  const mediaStreamRef = useRef(null);

async function handleNewSession() {
  try {
    const name = pdtNowName();
    const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_name: name }),
    });

    if (!res.ok) {
      setMessage("Could not create session");
      return;
    }

    await refreshSessions(); // refresh + auto select last session
    setMessage("New session created");
  } catch (e) {
    setMessage("Session error: " + e.message);
  }
}

useEffect(() => {
  refreshSessions();

  return () => {
    if (mediaStreamRef.current)
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
  };
}, []);

  async function refreshSessions(selectUuid) {
    try {
      const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions`);
      const data = await res.json();
      setSessions(data || []);
      // choose last created or provided
      if (data && data.length > 0) {
        const toSelect = selectUuid || data[data.length - 1].session_uuid;
        setSelectedSession(toSelect);
        await loadTranscripts(toSelect);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function loadTranscripts(sessionUuid) {
    if (!sessionUuid) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions/${sessionUuid}/transcripts`);
      if (!res.ok) {
        setTranscripts([]);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setTranscripts(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function handleStartRecording() {
    setMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const options = {};
      // mimeType feature detection
      if (MediaRecorder.isTypeSupported("audio/webm")) options.mimeType = "audio/webm";
      const mr = new MediaRecorder(stream, options);
      const chunks = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mr.onstop = async () => {
        setAudioChunks(chunks.slice());
        await uploadAudioBlob(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }));
        // stop tracks
        stream.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      };
      mr.start();
      setRecorder(mr);
      setAudioChunks([]);
      setIsRecording(true);
    } catch (e) {
      console.error(e);
      setMessage("Could not start recording: " + (e.message || e));
    }
  }

  function handleStopRecording() {
    if (recorder) {
      recorder.stop();
      setRecorder(null);
    }
    setIsRecording(false);
  }

  async function uploadAudioBlob(blob) {
    if (!selectedSession) {
      setMessage("No session selected.");
      return;
    }
    setMessage("Uploading audio...");
    try {
      const form = new FormData();
      const filename = `recording_${Date.now()}.webm`;
      form.append("audio", blob, filename);
      const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions/${selectedSession}/upload-audio`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await res.text();
        setMessage("Upload failed: " + err);
        return;
      }
      const data = await res.json();
      setTranscripts(data || []);
      setMessage("Uploaded and transcribed.");
    } catch (e) {
      console.error(e);
      setMessage("Upload error: " + (e.message || e));
    }
  }

  async function handleSendEmail(e) {
    e.preventDefault();
    if (!selectedSession) {
      setMessage("No session selected.");
      return;
    }
    if (!emailAddress) {
      setMessage("Please enter an email address.");
      return;
    }
    setMessage("Sending email...");
    try {
      const payload = {
        user_id: USER_ID,
        session_uuid: selectedSession,
        to_email: emailAddress,
        include_summary: includeSummary,
        subject: "Hockey scouting report",
      };
      const res = await fetch(`${API_BASE}/api/scout/email-existing-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.text();
        setMessage("Failed to send email: " + err);
      } else {
        setMessage("Email sent.");
      }
    } catch (e) {
      console.error(e);
      setMessage("Email error: " + (e.message || e));
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r">
        <div className="p-4 border-b">
          <h2 className="text-xl font-semibold flex items-center justify-between">
            Sessions
            <button
              onClick={handleNewSession}
              className="px-2 py-1 text-xs rounded bg-blue-600 text-white"
            >
              + New
            </button>
          </h2>
          <p className="text-sm text-gray-500">Scout: {USER_ID}</p>
        </div>

        <div className="p-2 overflow-auto" style={{ height: "calc(100vh - 88px)" }}>
          {sessions.length === 0 && <div className="p-4 text-gray-500">No sessions yet.</div>}
          {sessions.map((s) => (
            <div
              key={s.session_uuid}
              onClick={() => {
                setSelectedSession(s.session_uuid);
                loadTranscripts(s.session_uuid);
              }}
              className={`p-3 my-2 rounded cursor-pointer ${selectedSession === s.session_uuid ? "bg-blue-50 border-l-4 border-blue-500" : "hover:bg-gray-50"}`}
            >
              <div className="text-sm font-medium">{s.session_name || "Untitled session"}</div>
              <div className="text-xs text-gray-500 mt-1">{new Date(s.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
        <div className="p-4 border-t text-xs text-gray-500">API: {API_BASE}</div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-8">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl font-bold text-blue-600">Hockey Scout</h1>
          <p className="text-gray-600 mt-2">Record your observations during the game</p>

          <div className="mt-12">
            <div className="flex flex-col items-center">
              <button
                onClick={() => (isRecording ? handleStopRecording() : handleStartRecording())}
                className={`rounded-full shadow-lg flex items-center justify-center transition-transform ${isRecording ? "scale-95" : "hover:scale-105"}`}
                style={{ width: 180, height: 180, background: "#2F80ED", color: "white" }}
              >
                <div className="text-center">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="mx-auto">
                    <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3z" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M19 11v1a7 7 0 0 1-14 0v-1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <div className="mt-3 font-semibold">{isRecording ? "Recording..." : "Tap to Record"}</div>
                </div>
              </button>

              <div className="mt-4 text-gray-600">Scout notes will appear below</div>
            </div>

            <div className="mt-8">
              <div className="p-4 border-2 border-dashed rounded bg-white min-h-[160px]">
                {loading ? (
                  <div className="text-center text-gray-500">Loading transcripts...</div>
                ) : transcripts.length === 0 ? (
                  <div className="text-center text-gray-500">No scout notes yet. Start recording to capture your observations.</div>
                ) : (
                  <div>
                    {transcripts.map((t) => (
                      <div key={t.transcript_uuid} className="mb-6 text-left">
                        <div className="text-xs text-gray-400">{formatTimestampISO(t.timestamp)}</div>
                        <pre className="whitespace-pre-wrap bg-gray-50 p-3 rounded mt-1 text-sm">{t.transcript}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 flex items-center justify-center gap-4">
              <input
                placeholder="email@example.com"
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                className="px-3 py-2 rounded border"
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={includeSummary} onChange={(e) => setIncludeSummary(e.target.checked)} /> Include summary
              </label>
              <button onClick={handleSendEmail} className="px-4 py-2 rounded bg-blue-600 text-white">Send</button>
            </div>

            {message && <div className="mt-4 text-center text-sm text-gray-700">{message}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}
