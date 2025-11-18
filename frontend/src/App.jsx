import React, {useEffect, useRef, useState} from "react";

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
    const [menuOpenSession, setMenuOpenSession] = useState(null);

    // New: share modal
    const [shareOpen, setShareOpen] = useState(false);
    const [shareEmail, setShareEmail] = useState("");
    const [shareIncludeSummary, setShareIncludeSummary] = useState(false);
    const shareRef = useRef();

    // Sidebar toggle
    // Initialize based on screen width (Open on desktop, closed on mobile)
    const [sidebarOpen, setSidebarOpen] = useState(true);

    useEffect(() => {
        // Check screen size on mount to determine sidebar state
        if (window.innerWidth < 768) {
            setSidebarOpen(false);
        }
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

    async function handleNewSession() {
        try {
            const name = pdtNowName();
            const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({session_name: name}),
            });

            if (!res.ok) {
                setMessage("Could not create session");
                return;
            }

            await refreshSessions();
            setMessage("New session created");

            // On mobile, close sidebar after creating to show the main screen
            if (window.innerWidth < 768) setSidebarOpen(false);
        } catch (e) {
            setMessage("Session error: " + e.message);
        }
    }

    async function ensureSessionBeforeRecording() {
        if (!selectedSession) {
            setMessage("Creating a new session...");
            const name = pdtNowName();
            try {
                const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions`, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({session_name: name}),
                });
                if (!res.ok) {
                    setMessage("Could not create session");
                    return null;
                }

                const newSessionUuid = await refreshSessions();
                setMessage("New session created, starting recording...");
                return newSessionUuid;
            } catch (e) {
                setMessage("Session creation error: " + e.message);
                return null;
            }
        }
        return selectedSession;
    }

    async function handleStartRecording() {
        setMessage(null);

        const sessionToUse = await ensureSessionBeforeRecording();
        if (!sessionToUse) return;

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {channelCount: 1, sampleRate: 48000, noiseSuppression: false, echoCancellation: false}
        });

        mediaStreamRef.current = stream;

        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";

        const mr = new MediaRecorder(stream, {mimeType: mime});
        const chunks = [];

        mr.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        mr.onstop = async () => {
            if (!chunks.length) {
                setMessage("⚠ No audio captured!");
                return;
            }

            const blob = new Blob(chunks, {type: mime});
            await uploadAudioBlob(blob, sessionToUse);

            stream.getTracks().forEach((t) => t.stop());
            mediaStreamRef.current = null;
        };

        mr.start(250);

        setRecorder(mr);
        setAudioChunks([]);
        setIsRecording(true);
    }

    function handleStopRecording() {
        if (recorder) {
            recorder.stop();
            setRecorder(null);
        }
        setIsRecording(false);
    }

    async function uploadAudioBlob(blob, sessionUuid) {
        const uuid = sessionUuid || selectedSession;
        if (!uuid) {
            setMessage("No session selected.");
            return;
        }
        setMessage("Uploading audio...");
        try {
            const form = new FormData();
            const filename = `recording_${Date.now()}.webm`;
            form.append("audio", blob, filename);

            const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions/${uuid}/upload-audio`, {
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

    async function sendEmailRequest({toEmail, includeSummaryFlag, sessionUuid}) {
        if (!sessionUuid) {
            setMessage("No session selected.");
            return {ok: false, error: "no-session"};
        }
        if (!toEmail) {
            setMessage("Please enter an email address.");
            return {ok: false, error: "no-email"};
        }

        setMessage("Sending email...");
        try {
            const payload = {
                user_id: USER_ID,
                session_uuid: sessionUuid,
                to_email: toEmail,
                include_summary: !!includeSummaryFlag,
                subject: "Hockey scouting report",
            };
            const res = await fetch(`${API_BASE}/api/scout/email-existing-text`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const err = await res.text();
                setMessage("Failed to send email: " + err);
                return {ok: false, error: err};
            }
            setMessage("Email sent.");
            return {ok: true};
        } catch (e) {
            console.error(e);
            setMessage("Email error: " + (e.message || e));
            return {ok: false, error: e};
        }
    }

    async function handleModalSend() {
        const result = await sendEmailRequest({
            toEmail: shareEmail,
            includeSummaryFlag: shareIncludeSummary,
            sessionUuid: selectedSession
        });
        if (result.ok) {
            setShareOpen(false);
        }
    }

    useEffect(() => {
        function onKey(e) {
            if (e.key === "Escape") setShareOpen(false);
        }

        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        if (shareOpen) {
            setShareEmail(emailAddress || "");
            setShareIncludeSummary(includeSummary);
        }
    }, [shareOpen]);

    return (
        <div className="h-screen w-full bg-gray-100 flex overflow-hidden relative">

            {/* Mobile Sidebar Backdrop: Visible only on mobile when sidebar is open */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-40 md:hidden"
                    onClick={() => setSidebarOpen(false)}
                ></div>
            )}

            {/* Sidebar */}
            <aside
                className={`
                    fixed md:relative z-50 h-full bg-white border-r transition-all duration-300 overflow-hidden
                    ${sidebarOpen ? "w-64 translate-x-0" : "w-0 -translate-x-full md:w-0 md:translate-x-0"}
                `}
            >
                <div className="p-4 border-b flex items-center justify-between">
                    <h2 className="text-xl font-semibold">Sessions</h2>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleNewSession}
                            className="px-2 py-1 text-xs rounded bg-blue-600 text-white"
                        >
                            + New
                        </button>
                        <button
                            onClick={() => setSidebarOpen(false)}
                            className="p-2 rounded hover:bg-gray-100 transition"
                            title="Close sidebar"
                        >
                            <svg
                                width="16" height="16" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" strokeWidth="2"
                                strokeLinecap="round" strokeLinejoin="round"
                            >
                                <rect x="3" y="3" width="18" height="18" rx="4" ry="4"/>
                                <line x1="8" y1="3" x2="8" y2="21"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <div className="p-2 overflow-y-auto" style={{height: "calc(100% - 60px)"}}>
                    {sessions.length === 0 && <div className="p-4 text-gray-500">No sessions yet.</div>}
                    {sessions.map((s) => (
                        <div
                            key={s.session_uuid}
                            className={`p-3 my-2 rounded cursor-pointer flex justify-between items-center relative ${selectedSession === s.session_uuid ? "bg-blue-50 border-l-4 border-blue-500" : "hover:bg-gray-50"}`}
                        >
                            <div
                                className="flex-1 truncate pr-2"
                                onClick={() => {
                                    setSelectedSession(s.session_uuid);
                                    loadTranscripts(s.session_uuid);
                                    setMenuOpenSession(null);
                                    // Optional: Close sidebar on mobile when a session is selected
                                    if (window.innerWidth < 768) setSidebarOpen(false);
                                }}
                            >
                                <div
                                    className="text-sm font-medium truncate">{s.session_name || "Untitled session"}</div>
                            </div>

                            <div className="relative">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setMenuOpenSession(menuOpenSession === s.session_uuid ? null : s.session_uuid);
                                    }}
                                    className="px-2 py-1 hover:bg-gray-100 rounded"
                                >
                                    &#x22EE;
                                </button>

                                {menuOpenSession === s.session_uuid && (
                                    <div
                                        className="absolute right-0 top-full mt-1 w-28 bg-white border rounded shadow z-50">
                                        <button
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                if (!window.confirm("Are you sure you want to delete this session?")) return;
                                                try {
                                                    const res = await fetch(`${API_BASE}/api/users/${USER_ID}/sessions/${s.session_uuid}`, {
                                                        method: "DELETE",
                                                    });
                                                    if (!res.ok) {
                                                        setMessage("Failed to delete session");
                                                        return;
                                                    }
                                                    setMessage("Session deleted");

                                                    if (selectedSession === s.session_uuid) {
                                                        setSelectedSession(null);
                                                        setTranscripts([]);
                                                    }
                                                    await refreshSessions();
                                                } catch (err) {
                                                    console.error(err);
                                                    setMessage("Delete error: " + err.message);
                                                } finally {
                                                    setMenuOpenSession(null);
                                                }
                                            }}
                                            className="w-full text-left px-3 py-1 text-red-500 hover:bg-red-50 rounded"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 flex flex-col h-screen overflow-y-auto">

                {/* Top controls area - Sticky header or just fixed buttons */}
                <div>
                    {/* Open Sidebar Button: Always available if sidebar is closed (desktop) or mobile hamburger */}
                    {!sidebarOpen && (
                        <button
                            onClick={() => setSidebarOpen(true)}
                            className="fixed top-4 left-4 p-2 rounded-full bg-white shadow hover:scale-105 transition z-30"
                            title="Open sidebar"
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" strokeWidth="2">
                                <path d="M3 12h18"/>
                                <path d="M3 6h18" opacity="0.5"/>
                                <path d="M3 18h18" opacity="0.5"/>
                            </svg>
                        </button>
                    )}

                    {/* Share Button: Fixed Top Right */}
                    <button
                        onClick={() => setShareOpen(true)}
                        className="fixed top-4 right-4 inline-flex items-center gap-2 px-3 py-2 md:px-4 md:py-2 bg-blue-500 text-white rounded-full shadow hover:scale-105 transition z-30"
                        title="Share"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"
                             strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 16V4"/>
                            <path d="M6 10l6-6 6 6"/>
                            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>
                        </svg>
                        <span className="text-xs md:text-sm font-medium">Share</span>
                    </button>
                </div>

                <div className="w-full max-w-3xl mx-auto px-4 py-8 md:p-8 mt-12 md:mt-0">
                    <div className="flex flex-col items-center text-center mt-4 md:mt-8">
                        <h1 className="text-2xl md:text-4xl font-bold text-blue-600">Hockey Scout</h1>
                        <p className="text-gray-600 mt-2 text-sm md:text-base">Record your observations during the
                            game</p>
                    </div>

                    <div className="mt-8 md:mt-12 text-center">
                        <div className="flex flex-col items-center">
                            <button
                                onClick={() => (isRecording ? handleStopRecording() : handleStartRecording())}
                                className={`
                                    flex items-center justify-center rounded-full shadow-xl transition-all hover:scale-105
                                    ${isRecording ? "bg-red-400" : "bg-blue-500"}
                                `}
                                style={{
                                    width: 120,
                                    height: 120, // Slightly smaller default, could scale up on md
                                    transition: "background 0.3s ease, transform 0.15s ease",
                                }}
                            >
                                {/* Adjust icon size for mobile/desktop if needed, usually SVG scales fine */}
                                {!isRecording ? (
                                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white"
                                         strokeWidth="2">
                                        <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3z"/>
                                        <path d="M19 11v1a7 7 0 0 1-14 0v-1"/>
                                    </svg>
                                ) : (
                                    <div className="bg-white rounded-sm" style={{width: 25, height: 25}}></div>
                                )}
                            </button>

                            <div className="mt-4 text-center font-semibold text-gray-700">
                                {isRecording ? (
                                    <span className="text-red-500 animate-pulse">Recording...</span>
                                ) : (
                                    "Tap to Record"
                                )}
                            </div>

                            <div className="mt-4 text-gray-600 text-sm">Scout notes will appear below</div>
                        </div>

                        <div className="mt-8 w-full">
                            <div className="p-4 border-2 border-dashed rounded bg-white min-h-[160px]">
                                {loading ? (
                                    <div className="text-center text-gray-500">Loading transcripts...</div>
                                ) : transcripts.length === 0 ? (
                                    <div className="text-center text-gray-500 text-sm">No scout notes yet. Start
                                        recording to capture your observations.</div>
                                ) : (
                                    <div>
                                        {transcripts.map((t) => (
                                            <div key={t.transcript_uuid} className="mb-6 text-left">
                                                <div
                                                    className="text-xs text-gray-400">{formatTimestampISO(t.timestamp)}</div>
                                                <div
                                                    className="whitespace-pre-wrap break-words bg-gray-50 p-3 rounded mt-1 text-sm border border-gray-100">
                                                    {t.transcript}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="mt-6"/>
                        {message && <div
                            className="mt-4 text-center text-sm text-gray-700 bg-yellow-50 p-2 rounded">{message}</div>}
                    </div>
                </div>
            </main>

            {/* Share Modal */}
            {shareOpen && (
                <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 sm:p-6">
                    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShareOpen(false)}/>

                    <div ref={shareRef}
                         className="relative mt-20 w-full max-w-sm bg-white/95 rounded-2xl shadow-2xl p-6 z-[70] ring-1 ring-gray-200 mx-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="text-lg font-semibold">Share Notes</h3>
                            </div>
                            <button onClick={() => setShareOpen(false)}
                                    className="p-2 rounded-full hover:bg-gray-100 transition">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2">
                                    <path d="M18 6L6 18"/>
                                    <path d="M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>

                        <div className="mt-4">
                            <label className="text-xs text-gray-600">To</label>
                            <input
                                autoFocus
                                type="email"
                                value={shareEmail}
                                onChange={(e) => setShareEmail(e.target.value)}
                                placeholder="recipient@example.com"
                                className="w-full mt-1 px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                            />

                            <label className="flex items-center gap-2 mt-3 text-sm">
                                <input type="checkbox" checked={shareIncludeSummary}
                                       onChange={(e) => setShareIncludeSummary(e.target.checked)}/> Include summary
                            </label>

                            <div className="mt-4 flex items-center justify-end gap-2">
                                <button onClick={() => setShareOpen(false)}
                                        className="px-3 py-2 rounded-lg border hover:bg-gray-50 transition text-sm">Cancel
                                </button>
                                <button onClick={handleModalSend}
                                        className="px-4 py-2 rounded-lg bg-blue-600 text-white shadow transition text-sm">Send
                                </button>
                            </div>
                        </div>

                        <div
                            className="mt-3 text-xs text-gray-400 truncate">Session: {selectedSession || "(no session selected)"}</div>
                    </div>
                </div>
            )}
        </div>
    );
}