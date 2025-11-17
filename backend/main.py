import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional, Dict

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from pydantic_settings import BaseSettings
from openai import OpenAI

class Settings(BaseSettings):
    openai_api_key: str

    smtp_host: str
    smtp_port: int = 587
    smtp_username: str
    smtp_password: str
    smtp_use_tls: bool = True
    from_email: EmailStr

    stt_model: str = "whisper-1"
    gpt_model: str = "gpt-4.1-mini"

    class Config:
        env_file = ".env"


settings = Settings()
client = OpenAI(api_key=settings.openai_api_key)


app = FastAPI(title="Hockey Scouting Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

USER_EMAILS: Dict[str, str] = {}

class SetEmailRequest(BaseModel):
    user_id: str
    coach_email: EmailStr


class ScoutEmailRequest(BaseModel):
    to_email: EmailStr
    subject: str
    raw_transcript: str
    organized_summary: str

def send_email(
    to_email: str,
    subject: str,
    body_html: str,
    body_text: Optional[str] = None,
) -> None:
    """
    Basic SMTP email sender.
    """
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


async def transcribe_audio(file: UploadFile) -> str:
    """
    Send audio file to OpenAI for transcription.
    Compatible with the new openai-python SDK.
    """
    try:
        contents = await file.read()  # bytes

        transcription = client.audio.transcriptions.create(
            model=settings.stt_model,  # e.g. "whisper-1"
            file=(file.filename or "audio-file", contents),
        )

        text = getattr(transcription, "text", None)
        if not text:
            raise RuntimeError("No text returned from transcription.")
        return text
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription error: {e}")


async def summarize_notes(transcript: str) -> str:
    """
    Use GPT to organize and summarize the scouting notes.
    """
    system_prompt = """
You are an assistant helping a hockey scout structure their spoken notes.

Given a raw transcript, produce a concise, structured report with:

- Game context (teams, level, date if mentioned)
- Player observations grouped by player (name / number if present)
  - Strengths
  - Weaknesses
  - Notable plays
- Overall recommendations (e.g. follow-up scouting, potential fit, questions)
- Any data-quality notes (e.g. unclear audio, missing names)

Output in clear markdown.
"""

    try:
        completion = client.chat.completions.create(
            model=settings.gpt_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Raw transcript:\n\n{transcript}"},
            ],
            temperature=0.3,
        )
        return completion.choices[0].message.content
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summarization error: {e}")


def build_email_html(subject: str, transcript: str, summary: str) -> str:
    """
    Simple HTML template for the coach email.
    """
    return f"""
    <html>
      <body style="font-family: Arial, sans-serif;">
        <h2>{subject}</h2>
        <h3>Organized Scouting Report</h3>
        <div>{summary}</div>
        <hr />
        <h3>Raw Transcript</h3>
        <pre style="white-space: pre-wrap; font-family: monospace;">
{transcript}
        </pre>
      </body>
    </html>
    """
    
@app.post("/api/users/set-email")
async def set_coach_email(payload: SetEmailRequest):
    """
    Store the coach's email for a given user (scout).
    """
    USER_EMAILS[payload.user_id] = payload.coach_email
    return {
        "message": "Coach email saved successfully.",
        "user_id": payload.user_id,
        "coach_email": payload.coach_email,
    }


@app.get("/api/users/{user_id}/email")
async def get_coach_email(user_id: str):
    """
    Fetch the stored coach email for a user.
    """
    coach_email = USER_EMAILS.get(user_id)
    if not coach_email:
        raise HTTPException(
            status_code=404,
            detail="Coach email not set for this user.",
        )
    return {"user_id": user_id, "coach_email": coach_email}


@app.post("/api/scout/upload-audio")
async def upload_audio(
    audio: UploadFile = File(...),
    user_id: str = Form(...),
    subject: str = Form("Hockey scouting report"),
):
    """
    Full pipeline:

    1) Look up coach email for user_id
    2) Transcribe audio
    3) Summarize/organize notes
    4) Email coach
    5) Return transcript & summary
    """
    coach_email = USER_EMAILS.get(user_id)
    if not coach_email:
        raise HTTPException(
            status_code=400,
            detail="Coach email not set for this user. Call /api/users/set-email first.",
        )

    transcript = await transcribe_audio(audio)
    summary = await summarize_notes(transcript)

    html = build_email_html(subject=subject, transcript=transcript, summary=summary)
    send_email(to_email=coach_email, subject=subject, body_html=html)

    return {
        "message": "Scouting report processed and emailed successfully.",
        "user_id": user_id,
        "coach_email": coach_email,
        "subject": subject,
        "transcript": transcript,
        "summary": summary,
    }


@app.post("/api/scout/email-existing-text")
async def email_existing_text(payload: ScoutEmailRequest):
    """
    Use this if the frontend already has transcript & summary (possibly edited)
    and just needs to send the email.
    """
    html = build_email_html(
        subject=payload.subject,
        transcript=payload.raw_transcript,
        summary=payload.organized_summary,
    )
    send_email(
        to_email=payload.to_email,
        subject=payload.subject,
        body_html=html,
    )
    return {"message": "Email sent successfully."}


@app.get("/health")
async def health():
    return {"status": "ok"}
