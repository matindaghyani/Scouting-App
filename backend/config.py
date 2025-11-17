from pydantic import BaseSettings, EmailStr

class Settings(BaseSettings):
    openai_api_key: str
    smtp_host: str
    smtp_port: int = 587
    smtp_username: str
    smtp_password: str
    smtp_use_tls: bool = True
    from_email: EmailStr

    # OpenAI models
    stt_model: str = "gpt-4o-mini-tts"
    gpt_model: str = "gpt-4.1-mini"

    class Config:
        env_file = ".env"

settings = Settings()
