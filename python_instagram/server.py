"""
Crimson Sentinel — microserviço Instagram Stories via instagrapi.

Expõe HTTP/JSON local na porta 8721 (default). O worker Node (socialWorker)
consome estes endpoints para buscar stories de handles cadastrados em
`establishments.instagram_handle`.

Endpoints:
  GET  /health                         → 200 {status: "ok"}
  POST /login                           → (re)autentica com creds do env
                                         (reusable de session.json em disco)
  GET  /stories/{handle}                → lista de stories ativos do handle
  GET  /stories/{handle}?download=true  → baixa mídias em /tmp e retorna URLs

Variáveis de ambiente (lidas no /login):
  IG_USERNAME  — conta secundária dedicada
  IG_PASSWORD  — senha da conta

Sessão: persistida em python_instagram/session.json (criado automaticamente
após primeiro login bem-sucedido). É o principal mitigador de ban — evita
re-logins.
"""
from __future__ import annotations

import os
import json
import shutil
import base64
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

from instagrapi import Client


# ---- Caminhos de sessão ---------------------------------------------------
SESSION_DIR = Path(__file__).parent
SESSION_FILE = SESSION_DIR / "session.json"

# ---- App FastAPI -----------------------------------------------------------
app = FastAPI(title="Crimson Instagram Service", version="1.0.0")
_cl = Client()


def _load_session() -> bool:
    if SESSION_FILE.exists():
        try:
            _cl.load_settings(str(SESSION_FILE))
            _cl.get_timeline_feed()  # check session validity
            return True
        except Exception:
            return False
    return False


def _save_session() -> None:
    try:
        _cl.dump_settings(str(SESSION_FILE))
    except Exception:
        pass


def _login() -> None:
    username = os.environ.get("IG_USERNAME")
    password = os.environ.get("IG_PASSWORD")
    if not username or not password:
        raise HTTPException(
            status_code=400,
            detail="IG_USERNAME/IG_PASSWORD não configurados no ambiente deste serviço",
        )
    if _load_session():
        # Reutilizar sessão se válida
        _cl.username = username
        return
    _cl.login(username, password)
    _save_session()


class HealthResponse(BaseModel):
    status: str
    session_loaded: bool
    username: Optional[str] = None


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    session_loaded = SESSION_FILE.exists()
    return HealthResponse(
        status="ok",
        session_loaded=session_loaded,
        username=os.environ.get("IG_USERNAME"),
    )


@app.post("/login")
def login() -> Dict[str, Any]:
    try:
        _login()
        return {"status": "ok", "session_loaded": SESSION_FILE.exists()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"login failed: {e}")


class StoryItem(BaseModel):
    id: str
    type: str  # "photo" | "video"
    taken_at: str
    caption_text: str = ""
    pk: str
    media_url: Optional[str] = None  # url local em /tmp se download=true


@app.get("/stories/{handle}")
def get_stories(
    handle: str,
    download: bool = Query(False, description="Se true, baixa mídia em /tmp e retorna URL"),
) -> List[StoryItem]:
    # Suaviza handle: remove "@" inicial se presente
    handle = handle.lstrip("@")
    try:
        # Garante logado (reusa session)
        if not _cl.username:
            _login()
        user_id = _cl.user_id_from_username(handle)
        stories = _cl.user_stories(user_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"instagrapi error: {e}")

    items: List[StoryItem] = []
    for s in stories:
        item = StoryItem(
            id=str(s.id),
            pk=str(s.pk),
            type=s.media_type.name if hasattr(s, "media_type") and s.media_type else "unknown",
            taken_at=s.taken_at.isoformat() if s.taken_at else "",
            caption_text=(s.caption_text or "")[:5000],
        )
        if download:
            try:
                # Salva mídia em /tmp/instagrapi_<id>.<ext>
                ext = "mp4" if s.media_type and "video" in str(s.media_type).lower() else "jpg"
                if ext == "mp4":
                    path = _cl.story_download(str(s.pk), folder=tempfile.gettempdir())
                else:
                    path = _cl.story_download(str(s.pk), folder=tempfile.gettempdir())
                if path:
                    p = Path(path)
                    # Renomear para nome previsível
                    target = Path(tempfile.gettempdir()) / f"instagrapi_{s.id}.{ext}"
                    if target != p:
                        shutil.move(str(p), str(target))
                    item.media_url = str(target)
            except Exception as e:
                item.media_url = None
        items.append(item)
    return items


@app.on_event("shutdown")
def shutdown() -> None:
    _save_session()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("INSTAGRAM_SERVICE_PORT", "8721")))
