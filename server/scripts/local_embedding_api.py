import os
from typing import List, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastembed import TextEmbedding


DEFAULT_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: Union[str, List[str]]


app = FastAPI(title="LawVerify Local Embedding API")
_embedder: TextEmbedding | None = None


def get_embedder() -> TextEmbedding:
    global _embedder

    if _embedder is None:
        model_name = os.getenv("EMBEDDING_MODEL", DEFAULT_MODEL)
        cache_dir = os.getenv("FASTEMBED_CACHE_PATH")
        _embedder = TextEmbedding(model_name=model_name, cache_dir=cache_dir)

    return _embedder


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "model": os.getenv("EMBEDDING_MODEL", DEFAULT_MODEL),
    }


@app.post("/v1/embeddings")
def create_embeddings(payload: EmbeddingRequest):
    try:
        texts = payload.input if isinstance(payload.input, list) else [payload.input]
        normalized = [text.strip() for text in texts if isinstance(text, str) and text.strip()]

        if not normalized:
            raise HTTPException(status_code=400, detail="input 不能为空。")

        vectors = list(get_embedder().embed(normalized))

        return {
            "object": "list",
            "model": payload.model or os.getenv("EMBEDDING_MODEL", DEFAULT_MODEL),
            "data": [
                {
                    "object": "embedding",
                    "index": index,
                    "embedding": [float(value) for value in vector],
                }
                for index, vector in enumerate(vectors)
            ],
            "usage": {
                "prompt_tokens": 0,
                "total_tokens": 0,
            },
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
