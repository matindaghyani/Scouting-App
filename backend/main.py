import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional, List
from uuid import uuid4
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import FastAPI, File, UploadFile, HTTPException, Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from pydantic_settings import BaseSettings
from openai import OpenAI

from sqlalchemy import (
    create_engine,
    Column,
    String,
    Integer,
    DateTime,
    Text,
    ForeignKey,
)
from sqlalchemy.orm import sessionmaker, declarative_base, relationship, Session
class Settings(BaseSettings):
    openai_api_key: str
    stt_model: str = "whisper-1"
    gpt_model: str = "gpt-4.1-mini"

    smtp_host: str
    smtp_port: int = 587
    smtp_username: str
    smtp_password: str
    smtp_use_tls: bool = True
    from_email: EmailStr

    database_url: str = "sqlite:///./scouting.db"

    class Config:
        env_file = ".env"


settings = Settings()
client = OpenAI(api_key=settings.openai_api_key)

DATABASE_URL = settings.database_url
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, index=True, nullable=False)

    sessions = relationship("SessionModel", back_populates="user")

class SessionModel(Base):
    __tablename__ = "sessions"
    id = Column(Integer, primary_key=True, index=True)
    session_uuid = Column(String, unique=True, index=True, nullable=False)
    user_id = Column(String, ForeignKey("users.user_id"), index=True, nullable=False)
    session_name = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False)

    user = relationship("User", back_populates="sessions")
    transcripts = relationship("Transcript", back_populates="session", cascade="all, delete-orphan", order_by="Transcript.timestamp")

class Transcript(Base):
    __tablename__ = "transcripts"
    id = Column(Integer, primary_key=True, index=True)
    transcript_uuid = Column(String, unique=True, index=True, nullable=False)
    session_uuid = Column(String, ForeignKey("sessions.session_uuid"), index=True, nullable=False)
    filename = Column(String, nullable=True)
    transcript = Column(Text, nullable=False)
    timestamp = Column(DateTime, nullable=False)

    session = relationship("SessionModel", back_populates="transcripts")

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Hockey Scouting Backend (DB + Session Summaries)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
class CreateSessionRequest(BaseModel):
    session_name: Optional[str] = None

class CreateSessionResponse(BaseModel):
    session_uuid: str
    session_name: Optional[str]
    created_at: str

class TranscriptResponse(BaseModel):
    transcript_uuid: str
    filename: Optional[str]
    transcript: str
    timestamp: str

class SendEmailRequest(BaseModel):
    user_id: str
    session_uuid: str
    to_email: EmailStr
    include_summary: Optional[bool] = False
    subject: Optional[str] = "Hockey scouting report"

def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_or_create_user(db: Session, user_id: str) -> User:
    user = db.query(User).filter(User.user_id == user_id).first()
    if not user:
        user = User(user_id=user_id)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user

def send_email(
    to_email: str,
    subject: str,
    body_html: str,
    body_text: Optional[str] = None,
) -> None:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = settings.from_email
    msg["To"] = to_email

    if body_text is None:
        body_text = "Your email client does not support HTML.\n\n" + body_html

    part1 = MIMEText(body_text, "plain")
    part2 = MIMEText(body_html, "html")
    msg.attach(part1)
    msg.attach(part2)

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            if settings.smtp_use_tls:
                server.starttls()
            server.login(settings.smtp_username, settings.smtp_password)
            server.sendmail(settings.from_email, [to_email], msg.as_string())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send email: {e}")


def build_email_html(subject: str, transcripts: List[TranscriptResponse], session_summary: Optional[str] = None) -> str:
    transcripts_html = "".join(
        f"<h4>{t.timestamp}</h4><pre style='white-space: pre-wrap; font-family: monospace;'>{t.transcript}</pre><hr/>"
        for t in transcripts
    )
    summary_section = f"<h3>Session Summary</h3><div>{session_summary}</div><hr/>" if session_summary else ""
    return f"""
    <html>
      <body style="font-family: Arial, sans-serif;">
        <h2>{subject}</h2>
        {summary_section}
        <h3>Transcripts</h3>
        <div>{transcripts_html}</div>
      </body>
    </html>
    """

async def transcribe_audio(file: UploadFile) -> str:
    try:
        contents = await file.read()
        transcription = client.audio.transcriptions.create(
            model=settings.stt_model,
            file=(file.filename or "audio-file", contents),
        )
        text = getattr(transcription, "text", None)
        if text is None:
            raise RuntimeError("No text returned from transcription.")
        return text
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription error: {e}")


async def summarize_session_text(session_text: str) -> str:
    system_prompt = """
You are an assistant that summarizes a hockey scouting session's transcripts.

Produce a concise session-level summary including:
- Game context if available
- Key player observations (group by player if names/numbers appear)
- Overall recommendations
Keep the summary concise (bullet points or short paragraphs).
"""
    try:
        completion = client.chat.completions.create(
            model=settings.gpt_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Session transcripts:\n\n{session_text}"},
            ],
            temperature=0.2,
            max_tokens=800,
        )
        return completion.choices[0].message.content
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summarization error: {e}")


@app.post("/api/users/{user_id}/sessions", response_model=CreateSessionResponse)
async def create_session(user_id: str, payload: CreateSessionRequest):
    db = next(get_db())
    user = get_or_create_user(db, user_id)
    session_uuid = str(uuid4())
    now = datetime.now(ZoneInfo("America/Los_Angeles")).replace(second=0, microsecond=0)
    session = SessionModel(session_uuid=session_uuid, user_id=user.user_id, session_name=payload.session_name, created_at=now)
    db.add(session)
    db.commit()
    db.refresh(session)
    return CreateSessionResponse(session_uuid=session.session_uuid, session_name=session.session_name, created_at=session.created_at.isoformat())


@app.get("/api/users/{user_id}/sessions", response_model=List[CreateSessionResponse])
async def list_sessions(user_id: str):
    db = next(get_db())
    sessions = db.query(SessionModel).filter(SessionModel.user_id == user_id).all()
    return [CreateSessionResponse(session_uuid=s.session_uuid, session_name=s.session_name, created_at=s.created_at.isoformat()) for s in sessions]


@app.get("/api/users/{user_id}/sessions/{session_uuid}/transcripts", response_model=List[TranscriptResponse])
async def get_session_transcripts(user_id: str, session_uuid: str = Path(...)):
    db = next(get_db())
    session = db.query(SessionModel).filter(SessionModel.session_uuid == session_uuid, SessionModel.user_id == user_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    transcripts = db.query(Transcript).filter(Transcript.session_uuid == session_uuid).order_by(Transcript.timestamp).all()
    return [
        TranscriptResponse(
            transcript_uuid=t.transcript_uuid,
            filename=t.filename,
            transcript=t.transcript,
            timestamp=t.timestamp.isoformat(),
        )
        for t in transcripts
    ]


@app.post("/api/users/{user_id}/sessions/{session_uuid}/upload-audio", response_model=List[TranscriptResponse])
async def upload_audio_to_session(
    user_id: str,
    session_uuid: str,
    audio: UploadFile = File(...)
):
    db = next(get_db())
    session = db.query(SessionModel).filter(SessionModel.session_uuid == session_uuid, SessionModel.user_id == user_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="User or session not found.")

    transcript_text = await transcribe_audio(audio)
    transcript_obj = Transcript(
        transcript_uuid=str(uuid4()),
        session_uuid=session_uuid,
        filename=audio.filename,
        transcript=transcript_text,
        timestamp=datetime.now(ZoneInfo("America/Los_Angeles")).replace(second=0, microsecond=0),
    )
    db.add(transcript_obj)
    db.commit()
    db.refresh(transcript_obj)

    transcripts_list = db.query(Transcript).filter(Transcript.session_uuid == session_uuid).order_by(Transcript.timestamp).all()
    return [
        TranscriptResponse(
            transcript_uuid=t.transcript_uuid,
            filename=t.filename,
            transcript=t.transcript,
            timestamp=t.timestamp.isoformat(),
        )
        for t in transcripts_list
    ]


@app.get("/api/users/{user_id}/sessions/{session_uuid}/summary")
async def get_session_summary(user_id: str, session_uuid: str = Path(...)):
    db = next(get_db())
    session = db.query(SessionModel).filter(SessionModel.session_uuid == session_uuid, SessionModel.user_id == user_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    transcripts_all = db.query(Transcript).filter(Transcript.session_uuid == session_uuid).order_by(Transcript.timestamp).all()
    if not transcripts_all:
        raise HTTPException(status_code=404, detail="No transcripts for this session.")

    concatenated = "\n\n".join(t.transcript for t in transcripts_all)
    summary_text = await summarize_session_text(concatenated)
    return {"session_uuid": session_uuid, "summary": summary_text}


@app.post("/api/scout/email-existing-text")
async def email_existing_text(payload: SendEmailRequest):
    db = next(get_db())
    session = db.query(SessionModel).filter(SessionModel.session_uuid == payload.session_uuid, SessionModel.user_id == payload.user_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    transcripts = db.query(Transcript).filter(Transcript.session_uuid == payload.session_uuid).order_by(Transcript.timestamp).all()
    transcript_obj = [
        TranscriptResponse(
            transcript_uuid=t.transcript_uuid,
            filename=t.filename,
            transcript=t.transcript,
            timestamp=t.timestamp.isoformat() + "Z",
        )
        for t in transcripts
    ]

    session_summary_text = None
    if payload.include_summary:
        concatenated = "\n\n".join(t.transcript for t in transcripts)
        session_summary_text = await summarize_session_text(concatenated)

    html = build_email_html(subject=payload.subject, transcripts=transcript_obj, session_summary=session_summary_text)
    send_email(to_email=payload.to_email, subject=payload.subject, body_html=html)

    return {"message": "Email sent successfully."}


@app.get("/health")
async def health():
    return {"status": "ok"}
